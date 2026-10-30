import { describe, expect, it, vi } from 'vitest';
const { derive } = vi.hoisted(() => ({ derive: vi.fn() }));
vi.mock('@/encryption/deriveKey', () => ({ deriveKey: derive }));
vi.mock('@/encryption/libsodium.lib', () => ({ default: {} }));
vi.mock('@/encryption/libsodium', () => ({}));
vi.mock('@/encryption/aes', () => ({}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'synthetic-id' }));
import { Encryption } from './encryption';

// Key lifecycle only. Actual cross-account crypto interoperability is covered
// with CLI-generated envelopes in the server integration and browser fixture.
const fixture = (): Encryption => new (Encryption as any)('synthetic', new Uint8Array(32), { publicKey: new Uint8Array(32) }, new Uint8Array(32));
describe('session encryption initialization and access epoch', () => {
    it('does not cache session or blob keys when access is revoked during derivation', async () => {
        const encryption = fixture(); let finish!: (key: Uint8Array) => void;
        derive.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        let current = true;
        const work = encryption.initializeSessions(new Map([['shared', new Uint8Array(32)]]), () => current);
        await Promise.resolve();
        current = false; encryption.removeSessionEncryption('shared'); finish(new Uint8Array(32));
        await work;
        expect(encryption.getSessionEncryption('shared')).toBeNull();
        expect(encryption.getSessionBlobKey('shared')).toBeNull();
    });
    it('a re-grant creates a new decryptor and keeps the revoked one disposed', async () => {
        const encryption = fixture(); derive.mockResolvedValue(new Uint8Array(32));
        const keys = new Map([['shared', new Uint8Array(32)]]);
        await encryption.initializeSessions(keys);
        const old = encryption.getSessionEncryption('shared')!;
        encryption.removeSessionEncryption('shared');
        await encryption.initializeSessions(keys);
        expect(encryption.getSessionEncryption('shared')).not.toBe(old);
        expect(await old.decryptRaw('AA==')).toBeNull();
        expect(encryption.getSessionBlobKey('shared')).toHaveLength(32);
    });
});
