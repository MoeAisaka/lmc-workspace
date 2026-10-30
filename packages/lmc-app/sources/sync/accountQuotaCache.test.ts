import { describe, expect, it, vi } from 'vitest';
import { createAccountQuotaCache } from './accountQuotaCache';
import type { AccountQuotaSnapshot } from 'lmc-wire';
describe('shared account quota requests', () => {
    it('coalesces rings and menu and serves the recent sample when reopening', async () => {
        const sample: AccountQuotaSnapshot = { providers: [] };
        const request = vi.fn().mockResolvedValue(sample);
        const cache = createAccountQuotaCache(request);
        await Promise.all([cache.read('a'), cache.read('a'), cache.read('a')]);
        expect(cache.peek('a')).toBe(sample);
        await cache.read('a');
        expect(request).toHaveBeenCalledTimes(1);
        await cache.read('a', true); expect(request).toHaveBeenCalledTimes(2);
    });
    it('polls incomplete snapshots sooner, keeps sources isolated and preserves data on failure', async () => {
        let now = 1000;
        const sample: AccountQuotaSnapshot = { providers: [], refreshing: true };
        const request = vi.fn().mockResolvedValue(sample);
        const cache = createAccountQuotaCache(request, () => now);
        await cache.read('a');
        now += 1001; await cache.read('a');
        expect(request).toHaveBeenCalledTimes(2);
        expect(cache.peek('b')).toBeNull();
        await cache.read('b'); expect(request).toHaveBeenCalledTimes(3);
        request.mockRejectedValue(new Error('offline'));
        await expect(cache.read('a', true)).rejects.toThrow('offline');
        expect(cache.peek('a')).toBe(sample);
    });
});
