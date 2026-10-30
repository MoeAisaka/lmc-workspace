import fastify from 'fastify';
import { validatorCompiler, serializerCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import { FILE_ASSET_PART_SIZE } from 'lmc-wire';
import type { Fastify } from '../types';

const mock = vi.hoisted(() => {
    const assets = new Map<string, any>(), shares = new Map<string, any>(), parts: any[] = [], blobs = new Map<string, Buffer>();
    const matches = (r: any, w: any) => Object.entries(w).every(([k, v]: any) => v?.gt ? r[k] > v.gt : r[k] === v);
    return { assets, shares, parts, blobs, local: true, beforeRead: null as null | (() => Promise<void>), closed: null as null | (() => void), db: {
        fileAsset: { findFirst: async ({ where }: any) => [...assets.values()].find(r => matches(r, where)) ?? null },
        fileAssetPart: { findMany: async ({ where }: any) => parts.filter(p => p.assetId === where.assetId).sort((a, b) => a.index - b.index) },
        fileShare: {
            findUnique: async ({ where, include }: any) => { const r = shares.get(where.id); return r ? { ...r, ...(include?.asset ? { asset: assets.get(r.assetId) } : {}) } : null; },
            findFirst: async ({ where }: any) => [...shares.values()].find(r => matches(r, where)) ?? null,
            findMany: async ({ where }: any) => [...shares.values()].filter(r => matches(r, where)),
            count: async ({ where }: any) => [...shares.values()].filter(r => matches(r, where)).length,
            create: async ({ data }: any) => {
                if (shares.has(data.id)) throw Object.assign(new Error('unique'), { code: 'P2002' });
                const row = { ...data, createdAt: new Date(), revokedAt: null }; shares.set(row.id, row); return row;
            },
            updateMany: async ({ where, data }: any) => { for (const r of shares.values()) if (matches(r, where)) Object.assign(r, data); return { count: 1 }; },
        },
    } };
});
vi.mock('@/storage/db', () => ({ db: mock.db }));
vi.mock('@/storage/files', () => ({ isLocalStorage: () => mock.local, readLocalFile: async (p: string) => { await mock.beforeRead?.(); return mock.blobs.get(p); }, s3bucket: 'test', s3client: { getObject: async function* (_: string, p: string) { yield mock.blobs.get(p); } } }));
import { fileShareRoutes } from './fileShareRoutes';

const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const seal = (b: Uint8Array, key: Uint8Array) => { const nonce = randomBytes(24); return Buffer.concat([nonce, nacl.secretbox(b, nonce, key)]); };
describe('expiring saved-file access', () => {
    let app: Fastify;
    beforeEach(async () => {
        mock.assets.clear(); mock.shares.clear(); mock.parts.length = 0; mock.blobs.clear(); mock.local = true; mock.beforeRead = null; mock.closed = null;
        vi.stubEnv('LMC_FILE_SHARE_ORIGIN', 'https://vault.example.test:8443');
        const server = fastify(); server.setValidatorCompiler(validatorCompiler); server.setSerializerCompiler(serializerCompiler);
        server.addHook('onRequest', async (_req, reply) => { reply.raw.once('close', () => mock.closed?.()); });
        app = server.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
        app.decorate('authenticate', async (req: any, reply: any) => { if (!req.headers['x-user']) return reply.code(401).send({ error: 'Unauthorized' }); req.userId = req.headers['x-user']; });
        fileShareRoutes(app); await app.ready();
    });
    afterEach(async () => { await app.close(); vi.unstubAllEnvs(); });
    const call = (method: any, url: string, payload?: any, user = 'owner') => app.inject({ method, url, payload, headers: user ? { 'x-user': user } : {} });
    function file(size = 29) {
        const id = randomUUID(), key = randomBytes(32), bytes = Buffer.alloc(size, 52), manifest: any = { version: 1, id, name: '报告 #1.txt', mimeType: 'text/plain', size, parts: [] };
        for (let index = 0; index < Math.max(1, Math.ceil(size / FILE_ASSET_PART_SIZE)); index++) {
            const clear = bytes.subarray(index * FILE_ASSET_PART_SIZE, (index + 1) * FILE_ASSET_PART_SIZE), cipher = seal(clear, key);
            manifest.parts.push({ size: clear.length, sha256: hash(clear) });
            mock.parts.push({ assetId: id, index, size: cipher.length, sha256: hash(cipher) });
            mock.blobs.set('assets/' + id + '/' + hash(cipher) + '.enc', cipher);
        }
        mock.assets.set(id, { id, accountId: 'owner', state: 'ready', size: BigInt(size), partCount: manifest.parts.length, manifest: seal(Buffer.from(JSON.stringify(manifest)), key) });
        return { id, key, bytes };
    }
    async function share(f = file()) {
        const token = randomBytes(32), body = { id: randomUUID(), tokenHash: hash(token), keyEnvelope: seal(f.key, token).toString('base64'), hours: 24 };
        const endpoint = '/v1/files/' + f.id + '/shares', response = await call('POST', endpoint, body);
        expect(response.statusCode).toBe(200);
        const result = response.json(), url = new URL(result.urlPrefix + token.toString('hex')).pathname;
        return { f, token, body, endpoint, result, url };
    }
    it('requires login and owner scope to create/list/revoke, storing no raw token or key', async () => {
        const s = await share();
        expect((await call('POST', s.endpoint, s.body, '')).statusCode).toBe(401);
        for (const method of ['GET', 'POST']) expect((await call(method, s.endpoint, method === 'POST' ? s.body : undefined, 'stranger')).statusCode).toBe(404);
        expect((await call('DELETE', '/v1/file-shares/' + s.body.id, undefined, 'stranger')).statusCode).toBe(404);
        const listed = (await call('GET', s.endpoint)).json();
        expect(listed.shares).toHaveLength(1);
        expect(JSON.stringify(listed)).not.toContain(s.token.toString('hex'));
        expect(listed.shares[0]).not.toHaveProperty('keyEnvelope');
        expect(mock.shares.get(s.body.id)).not.toHaveProperty('token');
        expect(mock.shares.get(s.body.id)).not.toHaveProperty('key');
    });
    it('revokes over real HTTP when bodyless clients inherit a JSON content type', async () => {
        const s = await share(); await app.listen({ host: '127.0.0.1', port: 0 });
        const addr = app.server.address(); if (!addr || typeof addr === 'string') throw new Error('Missing fixture port');
        const url = 'http://127.0.0.1:' + addr.port + '/v1/file-shares/' + s.body.id;
        for (const user of ['', 'stranger', 'owner']) {
            const res = await fetch(url, { method: 'DELETE', headers: { 'Content-Type': 'application/json', ...(user ? { 'x-user': user } : {}) } });
            expect(res.status).toBe(user === 'owner' ? 200 : user ? 404 : 401);
            await res.arrayBuffer();
        }
        expect((await app.inject(s.url)).statusCode).toBe(404);
        expect(mock.assets.get(s.f.id).state).toBe('ready');
    });
    it('streams exact multi-part bytes without login and supports HEAD and object storage', async () => {
        const s = await share(file(FILE_ASSET_PART_SIZE + 13));
        for (const local of [true, false]) {
            mock.local = local;
            const res = await app.inject(s.url);
            expect(res.statusCode).toBe(200); expect(res.rawPayload.equals(s.f.bytes)).toBe(true);
            expect(res.headers['content-disposition']).toContain("filename*=UTF-8''%E6%8A%A5");
            expect(res.headers['cache-control']).toContain('no-store'); expect(res.headers['content-security-policy']).toContain('sandbox');
        }
        const head = await app.inject({ method: 'HEAD', url: s.url });
        expect(head.statusCode).toBe(200); expect(head.body).toBe(''); expect(Number(head.headers['content-length'])).toBe(s.f.bytes.length);
    });
    it('makes a lost creation response and concurrent creation idempotent, rejects altered identity', async () => {
        const s = await share();
        const replies = await Promise.all([call('POST', s.endpoint, s.body), call('POST', s.endpoint, s.body)]);
        for (const res of replies) expect(res.json()).toEqual(s.result);
        expect(mock.shares.size).toBe(1);
        expect((await call('POST', s.endpoint, { ...s.body, hours: 1 })).statusCode).toBe(409);
        expect((await call('POST', '/v1/files/' + file().id + '/shares', s.body)).statusCode).toBe(409);
    });
    it('rejects wrong tokens, expiry, revoked links, bad key envelopes and damaged storage', async () => {
        const s = await share(), row = mock.shares.get(s.body.id);
        expect((await app.inject(s.url.replace(s.token.toString('hex'), randomBytes(32).toString('hex')))).statusCode).toBe(404);
        const expires = row.expiresAt; row.expiresAt = new Date(Date.now() - 1);
        expect((await app.inject(s.url)).statusCode).toBe(404); row.expiresAt = expires;
        const envelope = row.keyEnvelope; row.keyEnvelope = randomBytes(72);
        expect((await app.inject(s.url)).statusCode).toBe(404); row.keyEnvelope = envelope;
        const blobPath = [...mock.blobs.keys()][0], cipher = mock.blobs.get(blobPath)!;
        mock.blobs.set(blobPath, Buffer.alloc(cipher.length));
        expect((await app.inject(s.url)).statusCode).toBe(503); mock.blobs.set(blobPath, cipher);
        expect((await call('DELETE', '/v1/file-shares/' + row.id)).statusCode).toBe(200);
        expect((await app.inject(s.url)).statusCode).toBe(404);
        expect(mock.assets.get(s.f.id).state).toBe('ready');
    });
    it('rejects invalid lifetimes and can download an empty file', async () => {
        const s = await share(file(0));
        for (const hours of [0, 169, 1.5]) expect((await call('POST', s.endpoint, { ...s.body, id: randomUUID(), hours })).statusCode).toBe(400);
        const res = await app.inject(s.url); expect(res.statusCode).toBe(200); expect(res.rawPayload.length).toBe(0);
    });
    it('releases download slots when clients disconnect during the first storage read', async () => {
        const s = await share(); await app.listen({ host: '127.0.0.1', port: 0 });
        const addr = app.server.address(); if (!addr || typeof addr === 'string') throw new Error('Missing fixture port');
        for (let i = 0; i < 9; i++) {
            let started!: () => void, finish!: () => void, closed!: () => void;
            const reading = new Promise<void>(r => { started = r; }), closing = new Promise<void>(r => { closed = r; });
            mock.closed = closed; mock.beforeRead = () => { started(); return new Promise<void>(r => { finish = r; }); };
            const controller = new AbortController();
            const fetchResult = fetch('http://127.0.0.1:' + addr.port + s.url, { signal: controller.signal }).catch(() => null);
            await reading; controller.abort(); await fetchResult; await closing; finish();
        }
        mock.beforeRead = null; mock.closed = null;
        expect((await app.inject(s.url)).statusCode).toBe(200);
    });
});
