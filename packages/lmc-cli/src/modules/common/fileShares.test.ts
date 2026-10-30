import { describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { decryptBlob, decodeBase64 } from '@/api/encryption';
import { FileShares } from './fileShares';

describe('Agent explicit file sharing', () => {
    it('keeps default delivery private and retries only the same encrypted share intent', async () => {
        const id = randomUUID(), key = randomBytes(32);
        const http = { get: vi.fn(), delete: vi.fn(), post: vi.fn() };
        const shares = new FileShares(http, 'https://lmc.example.test'); shares.remember(id, key);
        await expect(shares.run({ action: 'create', asset_id: id })).rejects.toThrow('explicitly');
        expect(http.post).not.toHaveBeenCalled();
        let saved: any, attempts = 0;
        http.post.mockImplementation(async (_path, body) => {
            if (++attempts === 1) { saved = body; throw new Error('lost reply'); }
            expect(body).toEqual(saved);
            return { data: { id: body.id, assetId: id, createdAt: Date.now(), expiresAt: Date.now() + 86400_000, revokedAt: null, urlPrefix: 'https://vault.example.test/artifact/download/lmc/' + body.id + '/' } };
        });
        const input = { action: 'create' as const, asset_id: id, public_requested: true };
        await expect(shares.run(input)).rejects.toThrow('lost reply');
        const result = await shares.run(input) as any;
        const token = Buffer.from(result.url.split('/').pop(), 'hex');
        expect(createHash('sha256').update(token).digest('hex')).toBe(saved.tokenHash);
        expect(Buffer.from(decryptBlob(decodeBase64(saved.keyEnvelope), token)!)).toEqual(key);
        expect(saved).not.toHaveProperty('token'); expect(saved).not.toHaveProperty('key');
        expect((await shares.run(input) as any).url).toBe(result.url);
        expect(saved.hours).toBe(24);
        http.delete.mockResolvedValue({ data: { revoked: true } });
        expect(await shares.run({ action: 'revoke', share_id: result.id })).toEqual({ revoked: true });
        shares.clear();
        await expect(shares.run(input)).rejects.toThrow('/saved-files/' + id);
    });
    it('lists and revokes existing shares without holding old file keys', async () => {
        const http = { get: vi.fn(async () => ({ data: { shares: [] } })), delete: vi.fn(async () => ({ data: { revoked: true } })), post: vi.fn() };
        const shares = new FileShares(http as any, 'https://lmc.example.test'), id = randomUUID();
        expect(await shares.run({ action: 'list', asset_id: id })).toEqual({ shares: [] });
        expect(await shares.run({ action: 'revoke', share_id: id })).toEqual({ revoked: true });
        expect(http.post).not.toHaveBeenCalled();
    });
});
