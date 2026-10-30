import fastify from 'fastify';
import { validatorCompiler, serializerCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Fastify } from '../types';
import { FILE_ASSET_PART_SIZE } from 'lmc-wire';

const mock = vi.hoisted(() => {
    const assets = new Map<string, any>(), parts = new Map<string, any>(), deliveries = new Map<string, any>(), blobs = new Map<string, Buffer>();
    const matches = (row: any, where: any) => Object.entries(where ?? {}).every(([k, v]) => row[k] === v);
    const conflict = () => Object.assign(new Error('unique'), { code: 'P2002' });
    const model = (map: Map<string, any>) => ({
        findUnique: vi.fn(async ({ where }: any) => map.get(where.id) ?? null),
        findFirst: vi.fn(async ({ where, include }: any) => {
            const found = [...map.values()].find(row => matches(row, where));
            return found ? { ...found, ...(include?.parts ? { parts: [...parts.values()].filter(p => p.assetId === found.id).sort((a, b) => a.index - b.index) } : {}) } : null;
        }),
        findMany: vi.fn(async ({ where, take }: any) => [...map.values()].filter(row => matches(row, where)).slice(0, take)),
        count: vi.fn(async ({ where }: any) => [...map.values()].filter(row => matches(row, where)).length),
        create: vi.fn(async ({ data }: any) => {
            if (map.has(data.id)) throw conflict();
            const value = { state: map === assets ? 'uploading' : 'pending', manifest: null, receipt: null, createdAt: new Date(), updatedAt: new Date(), ...data };
            map.set(data.id, value); return value;
        }),
        updateMany: vi.fn(async ({ where, data }: any) => {
            let count = 0;
            for (const [id, row] of map) if (matches(row, where)) { map.set(id, { ...row, ...data, updatedAt: new Date() }); count++; }
            return { count };
        }),
    });
    const db = {
        fileAsset: model(assets), fileDelivery: model(deliveries),
        fileAssetPart: {
            findUnique: vi.fn(async ({ where }: any) => parts.get(where.assetId_index.assetId + ':' + where.assetId_index.index) ?? null),
            create: vi.fn(async ({ data }: any) => { const key = data.assetId + ':' + data.index; if (parts.has(key)) throw conflict(); parts.set(key, data); return data; }),
        },
        session: { findFirst: vi.fn(async ({ where }: any) => where.id === 'target' && where.accountId === 'owner' ? { id: 'target', accountId: 'owner' } : null) },
    };
    return { assets, parts, deliveries, blobs, db, local: true };
});
vi.mock('@/storage/db', () => ({ db: mock.db }));
vi.mock('@/storage/files', () => ({
    isLocalStorage: () => mock.local, s3client: { getObject: async function* (_bucket: string, path: string) { yield mock.blobs.get(path)!; } }, s3bucket: 'synthetic',
    putLocalFile: async (path: string, bytes: Buffer) => { mock.blobs.set(path, Buffer.from(bytes)); },
    readLocalFile: async (path: string) => mock.blobs.get(path),
}));
import { fileAssetRoutes } from './fileAssetRoutes';

describe('persistent files — authenticated routes and durable delivery', () => {
    let app: Fastify;
    const key = Buffer.alloc(81, 2).toString('base64'), manifest = Buffer.alloc(80, 3).toString('base64');
    beforeEach(async () => {
        mock.assets.clear(); mock.parts.clear(); mock.deliveries.clear(); mock.blobs.clear(); mock.local = true;
        const server = fastify();
        server.setValidatorCompiler(validatorCompiler); server.setSerializerCompiler(serializerCompiler);
        server.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_, body, done) => done(null, body));
        app = server.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
        app.decorate('authenticate', async (req: any, reply: any) => { if (!req.headers['x-user']) return reply.code(401).send({ error: 'Unauthorized' }); req.userId = req.headers['x-user']; });
        fileAssetRoutes(app); await app.ready();
    });
    afterEach(async () => { await app.close(); });
    const call = (method: any, url: string, payload?: any, user: string | undefined = 'owner') => app.inject({ method, url, payload, headers: { ...(user ? { 'x-user': user } : {}), ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/octet-stream' } : {}) } });
    async function begin(size = 3) { const id = randomUUID(); expect((await call('POST', '/v1/files', { id, size, keyMode: 'sealed', ownerKey: key })).statusCode).toBe(200); return id; }
    async function ready() { const id = await begin(); await call('PUT', '/v1/files/' + id + '/parts/0', Buffer.alloc(43, 5)); await call('POST', '/v1/files/' + id + '/complete', { manifest }); return id; }

    it('requires login and enforces owner scope for bytes, metadata and recipients', async () => {
        const id = await ready();
        expect((await app.inject('/v1/files/capabilities')).statusCode).toBe(401);
        for (const url of ['/v1/files/' + id, '/v1/files/' + id + '/parts/0']) expect((await call('GET', url, undefined, 'stranger')).statusCode).toBe(404);
        expect((await call('PUT', '/v1/files/' + id + '/parts/0', Buffer.alloc(43), 'stranger')).statusCode).toBe(404);
        expect((await call('POST', '/v1/files/' + id + '/deliveries', { id: randomUUID(), sessionId: 'foreign', ciphertext: key })).statusCode).toBe(404);
        expect((await call('GET', '/v1/sessions/target/file-deliveries', undefined, 'stranger')).statusCode).toBe(404);
    });
    it('keeps partial uploads invisible; exact lengths and all chunks are required', async () => {
        const id = await begin(FILE_ASSET_PART_SIZE + 1);
        expect((await call('GET', '/v1/files/' + id)).statusCode).toBe(404);
        expect((await call('POST', '/v1/files/' + id + '/complete', { manifest })).statusCode).toBe(409);
        expect((await call('PUT', '/v1/files/' + id + '/parts/0', Buffer.alloc(40))).statusCode).toBe(400);
        expect((await call('PUT', '/v1/files/' + id + '/parts/0', Buffer.alloc(FILE_ASSET_PART_SIZE + 40))).statusCode).toBe(200);
        expect((await call('PUT', '/v1/files/' + id + '/parts/1', Buffer.alloc(41))).statusCode).toBe(200);
        expect((await call('PUT', '/v1/files/' + id + '/parts/2', Buffer.alloc(40))).statusCode).toBe(400);
        expect((await call('POST', '/v1/files/' + id + '/complete', { manifest })).statusCode).toBe(200);
        expect((await call('GET', '/v1/files/' + id)).json().size).toBe(FILE_ASSET_PART_SIZE + 1);
    });
    it('makes retries idempotent and never changes a committed part or manifest', async () => {
        const id = await ready(), path = '/v1/files/' + id;
        expect((await call('POST', '/v1/files', { id, size: 3, keyMode: 'sealed', ownerKey: key })).statusCode).toBe(200);
        expect((await call('PUT', path + '/parts/0', Buffer.alloc(43, 5))).statusCode).toBe(200);
        expect((await call('PUT', path + '/parts/0', Buffer.alloc(43, 8))).statusCode).toBe(409);
        expect((await call('POST', path + '/complete', { manifest })).statusCode).toBe(200);
        expect((await call('POST', path + '/complete', { manifest: key })).statusCode).toBe(409);
        expect((await call('GET', path + '/parts/0')).rawPayload).toEqual(Buffer.alloc(43, 5));
        expect((await call('POST', path + '/abort', {})).statusCode).toBe(409);
    });
    it('resolves racing different PUTs without overwriting the winning ciphertext', async () => {
        const id = await begin();
        const a = Buffer.alloc(43, 11), b = Buffer.alloc(43, 12);
        const results = await Promise.all([call('PUT', '/v1/files/' + id + '/parts/0', a), call('PUT', '/v1/files/' + id + '/parts/0', b)]);
        expect(results.map(r => r.statusCode).sort()).toEqual([200, 409]);
        await call('POST', '/v1/files/' + id + '/complete', { manifest });
        expect((await call('GET', '/v1/files/' + id + '/parts/0')).rawPayload).toEqual(results[0].statusCode === 200 ? a : b);
    });
    it('rejects damaged storage instead of returning corrupt content as success', async () => {
        const id = await ready();
        const path = [...mock.blobs.keys()][0]; mock.blobs.set(path, Buffer.alloc(43, 9));
        expect((await call('GET', '/v1/files/' + id + '/parts/0')).statusCode).toBe(503);
    });
    it('proxies object storage on the authenticated origin instead of redirecting bearer requests', async () => {
        const id = await ready(); mock.local = false;
        const response = await call('GET', '/v1/files/' + id + '/parts/0');
        expect(response.statusCode).toBe(200); expect(response.headers.location).toBeUndefined();
        expect(response.rawPayload).toEqual(Buffer.alloc(43, 5));
    });
    it('retains delivery until ACK and does not call any message/model endpoint', async () => {
        const id = await ready(), deliveryId = randomUUID();
        const data = { id: deliveryId, sessionId: 'target', ciphertext: key };
        const endpoint = '/v1/files/' + id + '/deliveries';
        expect((await call('POST', endpoint, data)).json().state).toBe('pending');
        expect((await call('POST', endpoint, data)).json().id).toBe(deliveryId);
        expect(mock.deliveries.size).toBe(1);
        expect((await call('GET', '/v1/sessions/target/file-deliveries')).json().deliveries).toHaveLength(1);
        expect((await call('GET', '/v1/sessions/target/file-deliveries')).json().deliveries).toHaveLength(1);
        const ack = '/v1/sessions/target/file-deliveries/' + deliveryId + '/ack';
        expect((await call('POST', ack, { state: 'received', receipt: key }, 'stranger')).statusCode).toBe(404);
        expect((await call('POST', ack, { state: 'received', receipt: key })).statusCode).toBe(200);
        expect((await call('POST', ack, { state: 'received', receipt: key })).statusCode).toBe(200);
        expect((await call('POST', ack, { state: 'failed', receipt: key })).statusCode).toBe(409);
        expect((await call('GET', '/v1/sessions/target/file-deliveries')).json().deliveries).toEqual([]);
        expect((await call('GET', endpoint)).json().deliveries[0].state).toBe('received');
    });
    it('aborted uploads cannot be completed and never enter the saved list', async () => {
        const id = await begin();
        expect((await call('POST', '/v1/files/' + id + '/abort', {})).statusCode).toBe(200);
        expect((await call('PUT', '/v1/files/' + id + '/parts/0', Buffer.alloc(43))).statusCode).toBe(409);
        expect((await call('POST', '/v1/files/' + id + '/complete', { manifest })).statusCode).toBe(409);
        expect((await call('GET', '/v1/files')).json().files).toEqual([]);
    });
});

