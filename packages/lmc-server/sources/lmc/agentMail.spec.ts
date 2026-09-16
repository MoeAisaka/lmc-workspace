import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lmcAgentMailRoutes } from './agentMail';

const { rows, database } = vi.hoisted(() => {
    const rows = new Map<string, any>();
    const database = {
        session: { findFirst: async ({ where }: any) => ['hub', 'worker'].includes(where.id) ? { id: where.id } : null },
        agentMail: {
            create: async ({ data }: any) => {
                const id = data.id ?? `random-${rows.size}`;
                if (rows.has(id)) throw Object.assign(new Error('unique'), { code: 'P2002' });
                const row = { ...data, id, createdAt: new Date(), deliveredAt: null };
                rows.set(id, row);
                return { ...row };
            },
            findUnique: async ({ where }: any) => rows.get(where.id) ?? null,
            findMany: async ({ where }: any) => [...rows.values()].filter(r => r.accountId === where.accountId && r.toSessionId === where.toSessionId && r.deliveredAt === null).map(r => ({ ...r })),
            updateMany: async ({ where, data }: any) => {
                let count = 0;
                for (const row of rows.values()) {
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
