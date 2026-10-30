import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Fastify } from '../types';
import { db } from '@/storage/db';
import { isLocalStorage, putLocalFile, readLocalFile, s3client, s3bucket } from '@/storage/files';
import { FILE_ASSET_MAX_SIZE, FILE_ASSET_PART_SIZE, FILE_ASSET_CIPHER_OVERHEAD } from 'lmc-wire';
import { readableFile, sharedFileIds } from '@/lmc/access/resources';

const uuid = z.string().uuid();
const binary = (max: number) => z.string().min(1).max(Math.ceil(max / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const idParams = z.object({ id: uuid });
const partParams = z.object({ id: uuid, index: z.coerce.number().int().min(0).max(255) });
const fileJson = (f: any) => ({
    id: f.id, size: Number(f.size), partCount: f.partCount, keyMode: f.keyMode,
    ownerKey: Buffer.from(f.ownerKey).toString('base64'), manifest: f.manifest ? Buffer.from(f.manifest).toString('base64') : '',
    createdAt: f.createdAt.getTime(),
});
const deliveryJson = (d: any) => ({
    id: d.id, assetId: d.assetId, sessionId: d.sessionId, ciphertext: Buffer.from(d.ciphertext).toString('base64'),
    state: d.state, receipt: d.receipt ? Buffer.from(d.receipt).toString('base64') : null,
    createdAt: d.createdAt.getTime(), updatedAt: d.updatedAt.getTime(),
});
const partPath = (id: string, hash: string) => 'assets/' + id + '/' + hash + '.enc';
const isConflict = (error: unknown) => (error as { code?: string })?.code === 'P2002';

/** Immutable account-owned ciphertext. Session deletion never owns this namespace. */
export function fileAssetRoutes(app: Fastify) {
    app.get('/v1/files/capabilities', { preHandler: app.authenticate }, async () => ({ version: 1, maxSize: FILE_ASSET_MAX_SIZE, partSize: FILE_ASSET_PART_SIZE }));
    app.post('/v1/files', {
        preHandler: app.authenticate,
        schema: { body: z.object({ id: uuid, size: z.number().int().min(0).max(FILE_ASSET_MAX_SIZE), keyMode: z.enum(['sealed', 'legacy']), ownerKey: binary(512) }) },
    }, async (request, reply) => {
        const { id, size, keyMode, ownerKey } = request.body;
        const bytes = Buffer.from(ownerKey, 'base64');
        if (bytes.length < 40 || bytes.length > 512) return reply.code(400).send({ error: 'Invalid encrypted key' });
        const existing = await db.fileAsset.findUnique({ where: { id } });
        const matches = (f: NonNullable<typeof existing>) => f.accountId === request.userId && f.size === BigInt(size) && f.keyMode === keyMode && Buffer.from(f.ownerKey).equals(bytes);
        if (existing) return matches(existing) ? reply.send({ id }) : reply.code(409).send({ error: 'File identity conflict' });
        // Bound abandoned uploads; this is a backstop, not a subscription quota.
        if (await db.fileAsset.count({ where: { accountId: request.userId, state: 'uploading' } }) >= 32) return reply.code(429).send({ error: 'Too many unfinished uploads' });
        try {
            await db.fileAsset.create({ data: { id, accountId: request.userId, runtimeSessionId: (request as any).runtimeScope?.sessionId ?? null, size: BigInt(size), partCount: Math.max(1, Math.ceil(size / FILE_ASSET_PART_SIZE)), keyMode, ownerKey: bytes } });
        } catch (error) {
            if (!isConflict(error)) throw error;
            const winner = await db.fileAsset.findUnique({ where: { id } });
            if (!winner || !matches(winner)) return reply.code(409).send({ error: 'File identity conflict' });
        }
        return { id };
    });

    app.put('/v1/files/:id/parts/:index', {
        preHandler: app.authenticate, bodyLimit: FILE_ASSET_PART_SIZE + FILE_ASSET_CIPHER_OVERHEAD,
        schema: { params: partParams },
    }, async (request, reply) => {
        const { id, index } = request.params;
        const file = await db.fileAsset.findFirst({ where: { id, accountId: request.userId } });
        if (!file) return reply.code(404).send({ error: 'File not found' });
        const body = request.body as Buffer;
        const expected = Math.min(FILE_ASSET_PART_SIZE, Math.max(0, Number(file.size) - index * FILE_ASSET_PART_SIZE)) + FILE_ASSET_CIPHER_OVERHEAD;
        if (index >= file.partCount || !Buffer.isBuffer(body) || body.length !== expected) return reply.code(400).send({ error: 'Invalid encrypted part size' });
        const sha256 = createHash('sha256').update(body).digest('hex');
        const where = { assetId_index: { assetId: id, index } };
        const existing = await db.fileAssetPart.findUnique({ where });
        if (existing) return existing.sha256 === sha256 ? reply.send({ sha256 }) : reply.code(409).send({ error: 'Immutable part conflict' });
        if (file.state !== 'uploading') return reply.code(409).send({ error: 'File is already complete' });
        // The path is content-addressed: a racing or late PUT cannot overwrite a
        // previously committed different chunk even before the DB insert wins.
        const path = partPath(id, sha256);
        if (isLocalStorage()) await putLocalFile(path, body);
        else await s3client.putObject(s3bucket, path, body, body.length);
        try {
            await db.fileAssetPart.create({ data: { assetId: id, index, size: body.length, sha256 } });
        } catch (error) {
            if (!isConflict(error)) throw error;
            const winner = await db.fileAssetPart.findUnique({ where });
            if (winner?.sha256 !== sha256) return reply.code(409).send({ error: 'Immutable part conflict' });
        }
        return { sha256 };
    });

    app.post('/v1/files/:id/complete', {
        preHandler: app.authenticate,
        schema: { params: idParams, body: z.object({ manifest: binary(64 * 1024) }) },
    }, async (request, reply) => {
        const file = await db.fileAsset.findFirst({ where: { id: request.params.id, accountId: request.userId }, include: { parts: { orderBy: { index: 'asc' } } } });
        if (!file) return reply.code(404).send({ error: 'File not found' });
        const manifest = Buffer.from(request.body.manifest, 'base64');
        if (manifest.length < 40 || manifest.length > 64 * 1024) return reply.code(400).send({ error: 'Invalid encrypted manifest' });
        if (file.state === 'ready') return Buffer.from(file.manifest!).equals(manifest) ? reply.send({ id: file.id }) : reply.code(409).send({ error: 'Immutable manifest conflict' });
        if (file.parts.length !== file.partCount || file.parts.some((p, index) => p.index !== index)) return reply.code(409).send({ error: 'Upload is incomplete' });
        const changed = await db.fileAsset.updateMany({ where: { id: file.id, accountId: request.userId, state: 'uploading' }, data: { manifest, state: 'ready' } });
        if (!changed.count) {
            const winner = await db.fileAsset.findUnique({ where: { id: file.id } });
            if (!winner?.manifest || !Buffer.from(winner.manifest).equals(manifest)) return reply.code(409).send({ error: 'Immutable manifest conflict' });
        }
        return { id: file.id };
    });

    app.post('/v1/files/:id/abort', { preHandler: app.authenticate, schema: { params: idParams } }, async (request, reply) => {
        const file = await db.fileAsset.findFirst({ where: { id: request.params.id, accountId: request.userId } });
        if (!file) return reply.code(404).send({ error: 'File not found' });
        if (file.state === 'ready') return reply.code(409).send({ error: 'Completed files cannot be aborted' });
        await db.fileAsset.updateMany({ where: { id: file.id, state: 'uploading' }, data: { state: 'aborted' } });
        return { success: true };
    });
    app.get('/v1/files', {
        preHandler: app.authenticate, schema: { querystring: z.object({ before: uuid.optional() }) },
    }, async (request, reply) => {
        reply.header('Cache-Control', 'private, no-store');
        const before = request.query.before ? await readableFile(request.userId, request.query.before) : null;
        if (request.query.before && !before) return reply.code(404).send({ error: 'File not found' });
        const files = await db.fileAsset.findMany({
            where: { state: 'ready', AND: [{ OR: [{ accountId: request.userId }, { id: { in: await sharedFileIds(request.userId) } }] }, ...(before ? [{ OR: [{ createdAt: { lt: before.createdAt } }, { createdAt: before.createdAt, id: { lt: before.id } }] }] : [])] },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 31,
        });
        const authorized = await Promise.all(files.slice(0, 30).map(file => readableFile(request.userId, file.id)));
        return { files: authorized.filter((f): f is NonNullable<typeof f> => !!f).map(f => ({ ...fileJson(f), shared: f.accountId !== request.userId })), next: files.length > 30 ? files[29].id : null };
    });
    app.get('/v1/files/:id', { preHandler: app.authenticate, schema: { params: idParams } }, async (request, reply) => {
        reply.header('Cache-Control', 'private, no-store');
        const file = await readableFile(request.userId, request.params.id);
        return file ? reply.send({ ...fileJson(file), shared: file.accountId !== request.userId }) : reply.code(404).send({ error: 'File not found' });
    });
    app.get('/v1/files/:id/parts/:index', { preHandler: app.authenticate, schema: { params: partParams } }, async (request, reply) => {
        const file = await readableFile(request.userId, request.params.id);
        if (!file) return reply.code(404).send({ error: 'File not found' });
        const part = await db.fileAssetPart.findUnique({ where: { assetId_index: { assetId: file.id, index: request.params.index } } });
        if (!part) return reply.code(404).send({ error: 'Part not found' });
        const path = partPath(file.id, part.sha256);
        reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
        let bytes: Buffer;
        if (isLocalStorage()) bytes = await readLocalFile(path);
        else {
            // Keep the browser on its authenticated origin (including CSP),
            // without forwarding its bearer header to an object-store URL.
            const chunks: Buffer[] = []; let size = 0;
            for await (const chunk of await s3client.getObject(s3bucket, path)) {
                size += chunk.length;
                if (size > part.size) return reply.code(503).send({ error: 'Stored part is damaged' });
                chunks.push(Buffer.from(chunk));
            }
            bytes = Buffer.concat(chunks);
        }
        if (bytes.length !== part.size || createHash('sha256').update(bytes).digest('hex') !== part.sha256) return reply.code(503).send({ error: 'Stored part is damaged' });
        if (file.accountId !== request.userId && !await readableFile(request.userId, file.id)) return reply.code(404).send({ error: 'File not found' });
        return reply.type('application/octet-stream').send(bytes);
    });

    app.post('/v1/files/:id/deliveries', {
        preHandler: app.authenticate,
        schema: { params: idParams, body: z.object({ id: uuid, sessionId: z.string().min(1).max(191), ciphertext: binary(4096) }) },
    }, async (request, reply) => {
        const file = await db.fileAsset.findFirst({ where: { id: request.params.id, accountId: request.userId, state: 'ready' } });
        const target = await db.session.findFirst({ where: { id: request.body.sessionId, accountId: request.userId } });
        if (!file || !target) return reply.code(404).send({ error: 'File or session not found' });
        const ciphertext = Buffer.from(request.body.ciphertext, 'base64');
        const matches = (d: any) => d.accountId === request.userId && d.assetId === file.id && d.sessionId === target.id && Buffer.from(d.ciphertext).equals(ciphertext);
        let delivery = await db.fileDelivery.findUnique({ where: { id: request.body.id } });
        if (!delivery) {
            try {
                delivery = await db.fileDelivery.create({ data: { id: request.body.id, accountId: request.userId, assetId: file.id, sessionId: target.id, ciphertext } });
            } catch (error) {
                if (!isConflict(error)) throw error;
                delivery = await db.fileDelivery.findUnique({ where: { id: request.body.id } });
            }
        }
        return delivery && matches(delivery) ? reply.send(deliveryJson(delivery)) : reply.code(409).send({ error: 'Delivery identity conflict' });
    });
    app.get('/v1/files/:id/deliveries', { preHandler: app.authenticate, schema: { params: idParams } }, async (request) => ({
        deliveries: (await db.fileDelivery.findMany({ where: { accountId: request.userId, assetId: request.params.id }, orderBy: { createdAt: 'desc' }, take: 50 })).map(deliveryJson),
    }));
    app.get('/v1/sessions/:sessionId/file-deliveries', {
        preHandler: app.authenticate, schema: { params: z.object({ sessionId: z.string() }) },
    }, async (request, reply) => {
        if (!await db.session.findFirst({ where: { id: request.params.sessionId, accountId: request.userId } })) return reply.code(404).send({ error: 'Session not found' });
        return { deliveries: (await db.fileDelivery.findMany({ where: { accountId: request.userId, sessionId: request.params.sessionId, state: 'pending' }, orderBy: { createdAt: 'asc' }, take: 10 })).map(deliveryJson) };
    });
    app.post('/v1/sessions/:sessionId/file-deliveries/:id/ack', {
        preHandler: app.authenticate,
        schema: { params: z.object({ sessionId: z.string(), id: uuid }), body: z.object({ state: z.enum(['received', 'failed']), receipt: binary(8192) }) },
    }, async (request, reply) => {
        const delivery = await db.fileDelivery.findFirst({ where: { id: request.params.id, sessionId: request.params.sessionId, accountId: request.userId } });
        if (!delivery) return reply.code(404).send({ error: 'Delivery not found' });
        if (delivery.state !== 'pending') return delivery.state === request.body.state ? reply.send({ success: true }) : reply.code(409).send({ error: 'Delivery already acknowledged' });
        await db.fileDelivery.updateMany({ where: { id: delivery.id, state: 'pending' }, data: { state: request.body.state, receipt: Buffer.from(request.body.receipt, 'base64') } });
        const updated = await db.fileDelivery.findUnique({ where: { id: delivery.id } });
        return updated?.state === request.body.state ? reply.send({ success: true }) : reply.code(409).send({ error: 'Delivery already acknowledged' });
    });
}

