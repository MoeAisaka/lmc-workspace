import { z } from 'zod';
import { createEnvelope } from './sessionProtocol';

export const FILE_ASSET_PART_SIZE = 8 * 1024 * 1024;
export const FILE_ASSET_MAX_SIZE = 2 * 1024 * 1024 * 1024;
export const FILE_ASSET_MAX_PARTS = FILE_ASSET_MAX_SIZE / FILE_ASSET_PART_SIZE;
export const FILE_ASSET_CIPHER_OVERHEAD = 40;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const FILE_SHARE_MAX_HOURS = 168;
export const fileShareCreateSchema = z.object({
    id: z.string().uuid(), tokenHash: hash,
    keyEnvelope: z.string().regex(/^[A-Za-z0-9+/]{96}$/), // secretbox of a 32-byte file key
    hours: z.number().int().min(1).max(FILE_SHARE_MAX_HOURS).default(24),
});
export const fileShareSchema = z.object({
    id: z.string().uuid(), assetId: z.string().uuid(), expiresAt: z.number(), createdAt: z.number(),
    revokedAt: z.number().nullable(), urlPrefix: z.string().url().optional(),
});
export type FileShare = z.infer<typeof fileShareSchema>;

export const fileAssetManifestSchema = z.object({
    version: z.literal(1),
    id: z.string().uuid(),
    name: z.string().min(1).max(255),
    mimeType: z.string().max(128),
    size: z.number().int().min(0).max(FILE_ASSET_MAX_SIZE),
    parts: z.array(z.object({ size: z.number().int().min(0).max(FILE_ASSET_PART_SIZE), sha256: hash })).min(1).max(FILE_ASSET_MAX_PARTS),
}).superRefine((file, ctx) => {
    if (file.parts.reduce((total, part) => total + part.size, 0) !== file.size ||
        file.parts.length !== Math.max(1, Math.ceil(file.size / FILE_ASSET_PART_SIZE)) ||
        file.parts.some((part, index) => part.size !== Math.min(FILE_ASSET_PART_SIZE, Math.max(0, file.size - index * FILE_ASSET_PART_SIZE)))) {
        ctx.addIssue({ code: 'custom', message: 'Invalid file part sizes' });
    }
});
export type FileAssetManifest = z.infer<typeof fileAssetManifestSchema>;

/** A completed file card has its own identity, independent of any model turn. */
export function savedFileEnvelope(file: Pick<FileAssetManifest, 'id' | 'name' | 'size' | 'mimeType'>, identity: string) {
    return createEnvelope('agent', { t: 'file', ref: 'asset:' + file.id, assetId: file.id, name: file.name, size: file.size, mimeType: file.mimeType }, { id: identity, turn: identity });
}

export const fileAssetRecordSchema = z.object({
    id: z.string().uuid(), size: z.number(), partCount: z.number().int(),
    keyMode: z.enum(['sealed', 'legacy']), ownerKey: z.string(), manifest: z.string(), createdAt: z.number(),
});
export type FileAssetRecord = z.infer<typeof fileAssetRecordSchema>;
export const fileDeliveryPayloadSchema = z.object({ version: z.literal(1), assetId: z.string().uuid(), key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/) });
export const fileDeliverySchema = z.object({
    id: z.string().uuid(), assetId: z.string().uuid(), sessionId: z.string(), ciphertext: z.string(),
    state: z.enum(['pending', 'received', 'failed']), receipt: z.string().nullable(), createdAt: z.number(), updatedAt: z.number(),
});
export type FileDelivery = z.infer<typeof fileDeliverySchema>;
export const filePublicationSchema = z.object({
    id: z.string(), state: z.enum(['uploading', 'ready', 'failed']), bytes: z.number(), total: z.number(),
    file: z.object({ id: z.string().uuid(), name: z.string(), size: z.number(), mimeType: z.string(), cardPending: z.boolean().optional() }).optional(),
    error: z.string().optional(),
});
