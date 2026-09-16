import { describe, expect, it } from 'vitest';

import { EncryptionCache } from './encryptionCache';
import type { DecryptedMessage } from '../storageTypes';

function message(id: string, payload: unknown): DecryptedMessage {
    return {
        id,
        seq: Number(id.replace(/\D/g, '')) || 1,
        localId: null,
        createdAt: 1,
        content: payload as any,
    };
}

describe('EncryptionCache message bounds', () => {
    it('does not retain one decrypted message larger than the per-entry byte cap', () => {
        const cache = new EncryptionCache({
            maxMessages: 10,
            maxMessageBytes: 200,
            maxSingleMessageBytes: 120,
        });

        cache.setCachedMessage('message-1', message('message-1', { output: 'x'.repeat(1_000) }));

        expect(cache.getCachedMessage('message-1')).toBeNull();
        expect(cache.getStats()).toMatchObject({ messages: 0, messageBytes: 0 });
    });

    it('evicts least-recently-used decrypted messages to satisfy count and byte caps', () => {
        const cache = new EncryptionCache({
            maxMessages: 3,
            maxMessageBytes: 1_000,
            maxSingleMessageBytes: 300,
        });
        cache.setCachedMessage('message-1', message('message-1', { output: 'a'.repeat(50) }));
        cache.setCachedMessage('message-2', message('message-2', { output: 'b'.repeat(50) }));
        cache.setCachedMessage('message-3', message('message-3', { output: 'c'.repeat(50) }));
        expect(cache.getCachedMessage('message-1')).not.toBeNull();

        cache.setCachedMessage('message-4', message('message-4', { output: 'd'.repeat(50) }));

        expect(cache.getCachedMessage('message-2')).toBeNull();
        expect(cache.getCachedMessage('message-1')).not.toBeNull();
        expect(cache.getStats().messages).toBeLessThanOrEqual(3);
        expect(cache.getStats().messageBytes).toBeLessThanOrEqual(1_000);
    });

    it('evicts by estimated bytes before the count cap is reached', () => {
        const cache = new EncryptionCache({
            maxMessages: 10,
            maxMessageBytes: 420,
            maxSingleMessageBytes: 300,
        });
        cache.setCachedMessage('message-1', message('message-1', { output: 'a'.repeat(50) }));
        cache.setCachedMessage('message-2', message('message-2', { output: 'b'.repeat(50) }));
        cache.setCachedMessage('message-3', message('message-3', { output: 'c'.repeat(50) }));

        expect(cache.getStats().messages).toBeLessThan(3);
        expect(cache.getStats().messageBytes).toBeLessThanOrEqual(420);
        expect(cache.getCachedMessage('message-1')).toBeNull();
    });

    it('resets byte accounting when all cached data is cleared', () => {
        const cache = new EncryptionCache({ maxMessages: 10, maxMessageBytes: 500, maxSingleMessageBytes: 300 });
        cache.setCachedMessage('message-1', message('message-1', { output: 'small' }));

        cache.clearAll();

        expect(cache.getStats()).toMatchObject({ messages: 0, messageBytes: 0 });
    });
});
