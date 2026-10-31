import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import sodium from 'libsodium-wrappers';
import { encryptBlob, decryptBlob } from '@/encryption/blob';
import { encodeBase64 } from '@/encryption/base64';
import { decryptFileAsset, readFileAssetParts, fileAssetBlob, downloadFileAsset, deliverFileAsset, createFileShare, revokeFileShare, getFileShares, FILE_DOWNLOAD_MEMORY_LIMIT } from './apiFileAssets';

const mocks = vi.hoisted(() => ({ sessions: {} as Record<string, any>, key: new Uint8Array(32), fetch: vi.fn(), encrypt: vi.fn() }));
vi.mock('@/sync/persistence', () => ({ loadSettings: () => ({ settings: {} }) }));
vi.mock('@/encryption/libsodium.lib', async () => ({ default: (await import('libsodium-wrappers')).default }));
vi.mock('expo-crypto', async () => { const c = await import('node:crypto'); return { randomUUID: c.randomUUID, getRandomBytes: (n: number) => new Uint8Array(c.randomBytes(n)) }; });
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://file-test.invalid' }));
vi.mock('./storage', () => ({ storage: { getState: () => ({ sessions: mocks.sessions }) } }));
vi.mock('./sync', () => ({ sync: {
    getCredentials: () => ({ token: 'synthetic-test-token' }),
    encryption: {
        decryptEncryptionKey: async () => mocks.key,
        openEncryption: async () => ({ decrypt: async () => [Buffer.from(mocks.key).toString('base64')] }),
        getSessionEncryption: () => ({ encryptRaw: mocks.encrypt }),
    },
} }));
beforeAll(async () => { await sodium.ready; });
beforeEach(() => { mocks.fetch.mockReset(); mocks.encrypt.mockReset().mockResolvedValue('opaque-ciphertext'); mocks.sessions = {}; mocks.key = randomBytes(32); vi.stubGlobal('fetch', mocks.fetch); });
afterEach(() => { vi.unstubAllGlobals(); });
function fixture() {
    const bytes = Buffer.from('离线也能取回的文件\n'), id = randomUUID();
    const manifest = { version: 1 as const, id, name: 'report.txt', mimeType: 'text/plain', size: bytes.length, parts: [{ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] };
    const record = { id, size: bytes.length, partCount: 1, keyMode: 'sealed', ownerKey: Buffer.alloc(81).toString('base64'), manifest: encodeBase64(encryptBlob(Buffer.from(JSON.stringify(manifest)), mocks.key), 'base64'), createdAt: 1 };
    return { bytes, manifest, record, file: { manifest, key: mocks.key, createdAt: 1 }, ciphertext: encryptBlob(bytes, mocks.key) };
}
describe('saved file client', () => {
    it('creates an explicitly requested expiring link with an encrypted key and idempotent retry', async () => {
        const { file } = fixture(); let saved: any, attempts = 0;
        mocks.fetch.mockImplementation(async (_url, options) => {
            const body = JSON.parse(options.body);
            if (++attempts === 1) { saved = body; throw new Error('lost share reply'); }
            expect(body).toEqual(saved);
            return Response.json({ id: body.id, assetId: file.manifest.id, createdAt: 1, expiresAt: Date.now() + 86400_000, revokedAt: null, urlPrefix: 'https://vault.example.test/artifact/download/lmc/' + body.id + '/' });
        });
        await expect(createFileShare(file)).rejects.toThrow('lost share reply');
        const share = await createFileShare(file), token = Buffer.from(share.url.split('/').pop()!, 'hex');
        expect(createHash('sha256').update(token).digest('hex')).toBe(saved.tokenHash);
        expect(Buffer.from(decryptBlob(Buffer.from(saved.keyEnvelope, 'base64'), token)!)).toEqual(Buffer.from(file.key));
        expect(saved).not.toHaveProperty('token'); expect(saved.hours).toBe(24);
        expect(mocks.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer synthetic-test-token');
        mocks.fetch.mockResolvedValue(Response.json({ shares: [] }));
        expect(await getFileShares(file.manifest.id)).toEqual([]);
        await revokeFileShare(share.id);
        expect(mocks.fetch.mock.calls.at(-1)?.[1].method).toBe('DELETE');
    });
    it('decrypts an independent account envelope in both credential modes', async () => {
        const { record, manifest } = fixture();
        expect((await decryptFileAsset(record)).manifest).toEqual(manifest);
        expect((await decryptFileAsset({ ...record, keyMode: 'legacy' })).manifest).toEqual(manifest);
        mocks.key = randomBytes(32);
        await expect(decryptFileAsset(record)).rejects.toThrow('decrypt');
    });
    it('checks plaintext hashes before writing and never requests the original session device', async () => {
        const { file, ciphertext, bytes } = fixture();
        mocks.fetch.mockImplementation(async () => new Response(new Uint8Array(ciphertext).buffer));
        const output: Uint8Array[] = [];
        await readFileAssetParts(file, async data => { output.push(data); });
        expect(Buffer.concat(output).equals(bytes)).toBe(true);
        expect(mocks.fetch.mock.calls[0][0]).toBe('https://file-test.invalid/v1/files/' + file.manifest.id + '/parts/0');
        file.manifest.parts[0].sha256 = '0'.repeat(64);
        const write = vi.fn();
        await expect(readFileAssetParts(file, write)).rejects.toThrow('checksum');
        expect(write).not.toHaveBeenCalled();
    });
    it('uses a streaming file writer and aborts it on damaged content', async () => {
        const { file, ciphertext } = fixture();
        const output = { write: vi.fn(), close: vi.fn(), abort: vi.fn(async () => {}) };
        vi.stubGlobal('window', { showSaveFilePicker: vi.fn(async () => ({ createWritable: async () => output })) });
        mocks.fetch.mockImplementation(async () => new Response(new Uint8Array(ciphertext).buffer));
        await downloadFileAsset(file);
        expect(output.write).toHaveBeenCalledTimes(1); expect(output.close).toHaveBeenCalledTimes(1);
        mocks.fetch.mockImplementation(async () => new Response(new Uint8Array(40)));
        await expect(downloadFileAsset(file)).rejects.toThrow('Incomplete');
        expect(output.abort).toHaveBeenCalledTimes(1); expect(output.close).toHaveBeenCalledTimes(1);
    });
    it('enforces the fallback memory bound before fetching and honours cancellation', async () => {
        const { file } = fixture();
        await expect(fileAssetBlob({ ...file, manifest: { ...file.manifest, size: FILE_DOWNLOAD_MEMORY_LIMIT + 1 } })).rejects.toThrow('128 MiB');
        expect(mocks.fetch).not.toHaveBeenCalled();
        const controller = new AbortController(); controller.abort();
        await expect(readFileAssetParts(file, async () => {}, undefined, controller.signal)).rejects.toThrow();
        expect(mocks.fetch).not.toHaveBeenCalled();
    });
    it('gates old Agents and reuses one delivery intent after a lost response', async () => {
        const { file } = fixture(), sessionId = randomUUID();
        await expect(deliverFileAsset(file, sessionId)).rejects.toThrow('upgraded Agent');
        expect(mocks.fetch).not.toHaveBeenCalled();
        mocks.sessions[sessionId] = { metadata: { sessionCapabilities: { persistentFiles: true } } };
        let saved: any, attempts = 0;
        mocks.fetch.mockImplementation(async (_url, options) => {
            if (options.method !== 'POST') return Response.json({ deliveries: [] });
            const body = JSON.parse(options.body);
            if (++attempts === 1) { saved = body; throw new TypeError('lost reply'); }
            expect(body).toEqual(saved);
            return Response.json({ ...body, assetId: file.manifest.id, state: 'pending', receipt: null, createdAt: 1, updatedAt: 1 });
        });
        await expect(deliverFileAsset(file, sessionId)).rejects.toThrow('lost reply');
        expect((await deliverFileAsset(file, sessionId)).id).toBe(saved.id);
        expect(mocks.encrypt).toHaveBeenCalledTimes(1);
    });
});
