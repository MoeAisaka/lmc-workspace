import { z } from 'zod';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import nacl from 'tweetnacl';
import type { Fastify } from '../types';
import { db } from '@/storage/db';
import { isLocalStorage, readLocalFile, s3client, s3bucket } from '@/storage/files';
import { fileShareCreateSchema, fileAssetManifestSchema } from 'lmc-wire';

const uuid = z.string().uuid();
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function open(bytes: Uint8Array, key: Uint8Array) {
    return bytes.length < 40 ? null : nacl.secretbox.open(bytes.subarray(24), bytes.subarray(0, 24), key);
}
function publicBase(): string | null {
    const raw = process.env.LMC_FILE_SHARE_ORIGIN;
    if (!raw) return null;
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid file share origin');
    return url.origin;
}
function shareJson(row: any, base?: string | null) {
    return { id: row.id, assetId: row.assetId, createdAt: row.createdAt.getTime(), expiresAt: row.expiresAt.getTime(), revokedAt: row.revokedAt?.getTime() ?? null,
        ...(base ? { urlPrefix: base + '/artifact/download/lmc/' + row.id + '/' } : {}) };
}
async function readPart(part: { assetId: string; sha256: string; size: number }) {
    const path = 'assets/' + part.assetId + '/' + part.sha256 + '.enc';
    let bytes: Buffer;
    if (isLocalStorage()) bytes = await readLocalFile(path);
    else {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of await s3client.getObject(s3bucket, path)) {
            size += chunk.length;
            if (size > part.size) throw new Error('Stored file is damaged');
            chunks.push(Buffer.from(chunk));
        }
        bytes = Buffer.concat(chunks);
    }
    if (bytes.length !== part.size || digest(bytes) !== part.sha256) throw new Error('Stored file is damaged');
    return bytes;
}

/** Shares grant access to one immutable snapshot; only the URL holder has the
 * key needed to unwrap its file key. Tokens and clear file keys are never stored. */
export function fileShareRoutes(app: Fastify) {
    const base = publicBase();
    let downloads = 0;
    app.post('/v1/files/:id/shares', {
        preHandler: app.authenticate, schema: { params: z.object({ id: uuid }), body: fileShareCreateSchema },
    }, async (req, reply) => {
        if (!base) return reply.code(503).send({ error: 'External sharing is not configured' });
        const file = await db.fileAsset.findFirst({ where: { id: req.params.id, accountId: req.userId, state: 'ready' } });
        if (!file) return reply.code(404).send({ error: 'File not found' });
        const body = req.body, keyEnvelope = Buffer.from(body.keyEnvelope, 'base64');
        if (keyEnvelope.length !== 72) return reply.code(400).send({ error: 'Invalid share key envelope' });
        const matches = (r: any) => r.accountId === req.userId && r.assetId === file.id && r.tokenHash === body.tokenHash && r.ttlHours === body.hours && Buffer.from(r.keyEnvelope).equals(keyEnvelope);
        let share = await db.fileShare.findUnique({ where: { id: body.id } });
        if (share) return matches(share) ? shareJson(share, base) : reply.code(409).send({ error: 'Share identity conflict' });
        // A bounded backstop against accidental repeated creation, not a quota.
        if (await db.fileShare.count({ where: { accountId: req.userId, revokedAt: null, expiresAt: { gt: new Date() } } }) >= 32) return reply.code(429).send({ error: 'Revoke an existing active share first' });
        try {
            share = await db.fileShare.create({ data: { id: body.id, accountId: req.userId, assetId: file.id, tokenHash: body.tokenHash, keyEnvelope, ttlHours: body.hours, expiresAt: new Date(Date.now() + body.hours * 3600_000) } });
        } catch (error) {
            if ((error as { code?: string }).code !== 'P2002') throw error;
            share = await db.fileShare.findUnique({ where: { id: body.id } });
            if (!share || !matches(share)) return reply.code(409).send({ error: 'Share identity conflict' });
        }
        return shareJson(share, base);
    });
    app.get('/v1/files/:id/shares', { preHandler: app.authenticate, schema: { params: z.object({ id: uuid }) } }, async (req, reply) => {
        if (!await db.fileAsset.findFirst({ where: { id: req.params.id, accountId: req.userId, state: 'ready' } })) return reply.code(404).send({ error: 'File not found' });
        const shares = await db.fileShare.findMany({ where: { assetId: req.params.id, accountId: req.userId }, orderBy: { createdAt: 'desc' }, take: 100 });
        return { shares: shares.map(row => shareJson(row)) };
    });
    app.delete('/v1/file-shares/:id', {
        // Existing Agent/web clients inherit a JSON header for this bodyless
        // operation. Fastify otherwise rejects it before owner authentication.
        onRequest: async req => {
            if (!req.headers['transfer-encoding'] && (!req.headers['content-length'] || req.headers['content-length'] === '0')) {
                delete req.headers['content-type'];
            }
        },
        preHandler: app.authenticate, schema: { params: z.object({ id: uuid }) },
    }, async (req, reply) => {
        const share = await db.fileShare.findFirst({ where: { id: req.params.id, accountId: req.userId } });
        if (!share) return reply.code(404).send({ error: 'Share not found' });
        await db.fileShare.updateMany({ where: { id: share.id, accountId: req.userId, revokedAt: null }, data: { revokedAt: new Date() } });
        return { revoked: true, id: share.id };
    });
    app.get('/artifact/download/lmc/:id/:token', {
        logLevel: 'silent', // Bearer link must never enter request/error logs.
        schema: { params: z.object({ id: uuid, token: z.string().regex(/^[a-f0-9]{64}$/) }) },
    }, async (req, reply) => {
        reply.header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer').header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "sandbox; default-src 'none'");
        const denied = () => reply.code(404).send({ error: 'Share unavailable or expired' });
        if (!base) return denied();
        const share = await db.fileShare.findUnique({ where: { id: req.params.id }, include: { asset: true } });
        if (!share || share.revokedAt || share.expiresAt.getTime() <= Date.now() || share.asset.state !== 'ready') return denied();
        const token = Buffer.from(req.params.token, 'hex');
        if (!timingSafeEqual(Buffer.from(share.tokenHash, 'hex'), Buffer.from(digest(token), 'hex'))) return denied();
        const key = open(Buffer.from(share.keyEnvelope), token);
        if (!key || key.length !== 32 || !share.asset.manifest) return denied();
        const clear = open(Buffer.from(share.asset.manifest), key);
        if (!clear) return denied();
        let manifest;
        try { manifest = fileAssetManifestSchema.parse(JSON.parse(Buffer.from(clear).toString('utf8'))); } catch { return denied(); }
        if (manifest.id !== share.assetId || manifest.size !== Number(share.asset.size) || manifest.parts.length !== share.asset.partCount) return denied();
        const parts = await db.fileAssetPart.findMany({ where: { assetId: share.assetId }, orderBy: { index: 'asc' } });
        if (parts.length !== manifest.parts.length || parts.some((p, i) => p.index !== i)) return reply.code(503).send({ error: 'Stored file is incomplete' });
        const headers = () => reply.type('application/octet-stream').header('Content-Disposition', "attachment; filename=download; filename*=UTF-8''" + encodeURIComponent(manifest.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))).header('Content-Length', manifest.size);
        if (req.method === 'HEAD') return headers().send(Readable.from([]));
        if (downloads >= 8) return reply.code(429).send({ error: 'Too many downloads, please retry' });
        downloads++;
        let released = false;
        const release = () => { if (!released) { released = true; downloads--; } };
        reply.raw.once('close', release);
        const read = async (index: number) => {
            const bytes = open(await readPart(parts[index]), key);
            const expected = manifest.parts[index];
            if (!bytes || bytes.length !== expected.size || digest(bytes) !== expected.sha256) throw new Error('Stored file is damaged');
            return Buffer.from(bytes);
        };
        let first: Buffer;
        try { first = await read(0); } catch { release(); return reply.code(503).send({ error: 'Stored file is damaged' }); }
        if (reply.raw.destroyed) { release(); return reply; }
        async function* stream() {
            try {
                for (let index = 0; index < parts.length; index++) {
                    const current = await db.fileShare.findUnique({ where: { id: share!.id } });
                    if (reply.raw.destroyed || !current || current.revokedAt || current.expiresAt.getTime() <= Date.now()) throw new Error('Share no longer available');
                    yield index === 0 ? first : await read(index);
                }
            } finally { release(); }
        }
        return headers().send(Readable.from(stream()));
    });
}
