import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lmcAgentMailRoutes } from './agentMail';

const { rows, database } = vi.hoisted(() => {
    const rows = new Map<string, any>();
    const database = {
        session: { findFirst: async ({ where }: any) => where.accountId === 'account' && ['hub', 'worker'].includes(where.id) ? { id: where.id } : null },
        agentMail: {
            create: async ({ data }: any) => {
                const id = data.id ?? `random-${rows.size}`;
                if (rows.has(id)) throw Object.assign(new Error('unique'), { code: 'P2002' });
                const row = { ...data, id, createdAt: new Date(), deliveredAt: null };
                rows.set(id, row);
                return { ...row };
            },
            findUnique: async ({ where }: any) => rows.get(where.id) ?? null,
            findMany: async ({ where }: any) => [...rows.values()].filter(r => r.accountId === where.accountId && r.toSessionId === where.toSessionId
                && (where.deliveredAt !== null || r.deliveredAt === null) && (!where.id || where.id.in.includes(r.id))).map(r => ({ ...r })),
            updateMany: async ({ where, data }: any) => {
                let count = 0;
                for (const row of rows.values()) {
                    if (row.accountId !== where.accountId || row.toSessionId !== where.toSessionId) continue;
                    if (typeof where.id === 'string' ? row.id !== where.id : !where.id.in.includes(row.id)) continue;
                    if (where.deliveredAt === null && row.deliveredAt !== null) continue;
                    Object.assign(row, data); count++;
                }
                return { count };
            },
        },
    };
    return { rows, database };
});
vi.mock('@/storage/db', () => ({ db: database }));
vi.mock('./auth', () => ({ lmcAuth: { verifyToken: async () => ({ kind: 'device', userId: 'account' }), agentChannelKey: async () => 'test-key' } }));

const app = fastify();
lmcAgentMailRoutes(app);
beforeEach(() => rows.clear());
afterEach(() => vi.clearAllMocks());
const post = (body = 'ciphertext', key = 'a'.repeat(64)) => app.inject({ method: 'POST', url: '/v1/lmc/agent/mail', payload: { fromSessionId: 'worker', toSessionId: 'hub', body, hop: 1, idempotencyKey: key } });

describe('mail idempotency and atomic take', () => {
    it('returns the original durable ID for concurrent or lost-response retries', async () => {
        const replies = await Promise.all([post('ciphertext-1'), post('ciphertext-2'), post('ciphertext-3')]);
        expect(replies.map(r => r.statusCode)).toEqual([200, 200, 200]);
        expect(new Set(replies.map(r => r.json().id)).size).toBe(1);
        expect(rows.size).toBe(1);
        const afterRestart = await post('new-random-encryption-of-same-report');
        expect(afterRestart.json().id).toBe(replies[0].json().id);
        expect(afterRestart.json().duplicate).toBe(true);
        await post('new report', 'b'.repeat(64));
        expect(rows.size).toBe(2);
    });

    it('hands a row to only one concurrent receiver', async () => {
        await post();
        const replies = await Promise.all(Array.from({ length: 4 }, () => app.inject({ method: 'GET', url: '/v1/lmc/agent/mail?sessionId=hub' })));
        expect(replies.flatMap(r => r.json().mail)).toHaveLength(1);
        expect((await app.inject({ method: 'GET', url: '/v1/lmc/agent/mail?sessionId=hub' })).json().mail).toEqual([]);
        expect(rows.size).toBe(1); // Do not discard the deduplication tombstone after delivery.
    });
});

describe('v3 recipient acknowledgements', () => {
    const take = (protocol = 3) => app.inject({ method: 'GET', url: '/v1/lmc/agent/mail?sessionId=hub&mailProtocol=' + protocol });
    const ack = (ids: string[], sessionId = 'hub') => app.inject({ method: 'POST', url: '/v1/lmc/agent/mail/ack', payload: { sessionId, ids } });

    it('advertises receipt support separately from v2 send deduplication', async () => {
        expect((await app.inject({ method: 'GET', url: '/v1/lmc/agent/channel-key' })).json().mailProtocol).toBe(3);
    });
    it('does not consume mail on GET, even when the first response is discarded', async () => {
        const id = (await post()).json().id;
        await take(); // Lost HTTP response / receiver exit before delivery.
        expect(rows.get(id).deliveredAt).toBeNull();
        const again = await take();
        expect(again.json().mail).toMatchObject([{ id }]);
        expect(again.json().mailProtocol).toBe(3);
        expect((await ack([id])).json()).toEqual({ acknowledged: [id] });
        expect(rows.get(id).deliveredAt).toBeInstanceOf(Date);
        expect((await take()).json().mail).toEqual([]);
    });
    it('keeps concurrent v3 fetches pending until one confirms, and ACK is idempotent', async () => {
        const id = (await post()).json().id;
        const copies = await Promise.all([take(), take(), take()]);
        expect(copies.map(r => r.json().mail[0].id)).toEqual([id, id, id]);
        expect((await ack([id, id])).statusCode).toBe(200);
        const first = rows.get(id).deliveredAt;
        expect((await ack([id])).statusCode).toBe(200);
        expect(rows.get(id).deliveredAt).toBe(first);
        expect(rows.size).toBe(1);
    });
    it('rejects another recipient or account without partially confirming the batch', async () => {
        const id = (await post()).json().id;
        expect((await ack([id], 'worker')).statusCode).toBe(403);
        rows.set('foreign', { id: 'foreign', accountId: 'other-account', toSessionId: 'hub', deliveredAt: null });
        expect((await ack([id, 'foreign'])).statusCode).toBe(403);
        expect(rows.get(id).deliveredAt).toBeNull();
        expect(rows.get('foreign').deliveredAt).toBeNull();
        expect((await ack(['unknown'])).statusCode).toBe(403);
    });
    it.each([1, 2])('retains take-and-mark for protocol %s clients', async protocol => {
        const id = (await post()).json().id;
        expect((await take(protocol)).json().mail).toHaveLength(1);
        expect(rows.get(id).deliveredAt).toBeInstanceOf(Date);
        expect((await take(protocol)).json().mail).toEqual([]);
    });
    it('bounds and validates acknowledgement batches before updating', async () => {
        expect((await ack([])).statusCode).toBe(400);
        expect((await ack(Array.from({ length: 21 }, (_, i) => 'id-' + i))).statusCode).toBe(400);
        expect((await ack(['id'], 'missing')).statusCode).toBe(404);
    });
});
