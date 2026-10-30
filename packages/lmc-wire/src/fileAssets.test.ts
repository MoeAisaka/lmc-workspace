import { describe, expect, it } from 'vitest';
import { FILE_ASSET_MAX_SIZE, FILE_ASSET_PART_SIZE, fileAssetManifestSchema } from './fileAssets';
describe('saved file manifest boundaries', () => {
    const part = { size: FILE_ASSET_PART_SIZE, sha256: 'a'.repeat(64) };
    const file = { version: 1, id: '11111111-1111-4111-8111-111111111111', name: 'snapshot.bin', mimeType: 'application/octet-stream', size: FILE_ASSET_MAX_SIZE, parts: Array.from({ length: 256 }, () => ({ ...part })) };
    it('accepts exactly 2 GiB, rejects larger files and inconsistent chunk boundaries', () => {
        expect(fileAssetManifestSchema.safeParse(file).success).toBe(true);
        expect(fileAssetManifestSchema.safeParse({ ...file, size: file.size + 1 }).success).toBe(false);
        expect(fileAssetManifestSchema.safeParse({ ...file, parts: [{ ...part, size: 0 }, ...file.parts.slice(1)] }).success).toBe(false);
    });
    it('represents an empty file with exactly one authenticated empty chunk', () => {
        expect(fileAssetManifestSchema.safeParse({ ...file, size: 0, parts: [{ ...part, size: 0 }] }).success).toBe(true);
        expect(fileAssetManifestSchema.safeParse({ ...file, size: 0, parts: [] }).success).toBe(false);
    });
});
