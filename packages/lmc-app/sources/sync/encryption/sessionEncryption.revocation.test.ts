import { describe, expect, it, vi } from 'vitest';
import { SessionEncryption } from './sessionEncryption';
import { EncryptionCache } from './encryptionCache';
import type { ApiMessage } from '../apiTypes';

const message = (id: string): ApiMessage => ({ id, seq: 1, localId: null, createdAt: 1, updatedAt: 1, content: { t: 'encrypted', c: 'AA==' } });
function fixture() {
    const cache = new EncryptionCache();
    const decrypt = vi.fn(async (_bytes: Uint8Array[]) => [{ text: 'previously authorized content' }]);
    const encryption = new SessionEncryption('shared', { decrypt, encrypt: vi.fn() }, cache);
    return { cache, decrypt, encryption };
}
describe('shared-session revocation and decrypted cache', () => {
    it('clears only the revoked session, including decrypted messages and byte accounting', async () => {
        const { cache, encryption } = fixture();
        cache.setCachedMessage('other-message', { id: 'other-message', seq: 1, localId: null, createdAt: 1, content: null }, 'other-session');
        await encryption.decryptMessages([message('shared-message')]);
        expect(cache.getStats().messages).toBe(2);
        encryption.dispose();
        expect(cache.getCachedMessage('shared-message')).toBeNull();
        expect(cache.getCachedMessage('other-message')).not.toBeNull();
        expect(cache.getStats().messages).toBe(1);
        expect(cache.getStats().messageBytes).toBeGreaterThan(0);
    });
    it('discards a decryption that finishes after revoke instead of recreating plaintext cache', async () => {
        const { cache, decrypt, encryption } = fixture();
        let finish!: (value: any[]) => void;
        decrypt.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const pending = encryption.decryptMessages([message('delayed')]);
        encryption.dispose();
        finish([{ text: 'late private content' }]);
        expect(await pending).toEqual([null]);
        expect(cache.getStats()).toMatchObject({ messages: 0, messageBytes: 0 });
        expect(await encryption.decryptMessages([message('delayed')])).toEqual([null]);
        expect(decrypt).toHaveBeenCalledTimes(1);
    });
    it('does not let an old decryptor read a new grant cache', async () => {
        const { cache, encryption: old } = fixture();
        old.dispose();
        const fresh = new SessionEncryption('shared', { decrypt: vi.fn(async () => [{ text: 'new grant' }]), encrypt: vi.fn() }, cache);
        expect((await fresh.decryptMessages([message('new')]))[0]?.content).toEqual({ text: 'new grant' });
        expect(await old.decryptMessages([message('new')])).toEqual([null]);
    });
});
