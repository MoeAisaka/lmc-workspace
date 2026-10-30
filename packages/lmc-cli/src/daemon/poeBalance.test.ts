import { describe, expect, it } from 'vitest';
import { createPoeBalanceReader, parsePoePoints } from './poeBalance';

describe('Poe point balance', () => {
    it('preserves zero and rejects non-integer, negative and malformed amounts', () => {
        expect(parsePoePoints({ current_point_balance: 0 })).toBe(0);
        expect(parsePoePoints({ current_point_balance: 1000000 })).toBe(1000000);
        for (const value of [null, undefined, '12', -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => parsePoePoints({ current_point_balance: value })).toThrow();
    });
    it('coalesces reads, preserves sampling time on failure, sanitizes errors and resets on key rotation', async () => {
        let time = 1000, key = 'fixture-key-one', calls = 0, fail = false;
        const read = createPoeBalanceReader(() => ({ version: 1, enabled: true, apiKey: key }), async () => {
            calls++; if (fail) throw new Error('RAW_PRIVATE_ERROR'); return { current_point_balance: 0 };
        }, () => time);
        const [one] = await Promise.all([read(), read(), read()]);
        expect(calls).toBe(1); expect(one).toEqual({ points: 0, capturedAt: 1000, status: 'ok', stale: false });
        time += 60001; fail = true;
        expect(await read()).toEqual({ points: 0, capturedAt: 1000, status: 'unavailable', stale: true });
        expect(calls).toBe(2);
        key = 'fixture-key-two';
        expect(await read()).toEqual({ points: null, capturedAt: null, status: 'unavailable', stale: true });
        expect(calls).toBe(3);
    });
    it('makes no provider request when unconfigured and exposes authentication status without error bodies', async () => {
        const noKey = createPoeBalanceReader(() => null, async () => { throw new Error('must not call'); });
        expect((await noKey()).status).toBe('unconfigured');
        const badKey = createPoeBalanceReader(() => ({ version: 1, enabled: false, apiKey: 'fixture-key' }), async () => { throw new Error('authentication'); });
        expect(await badKey()).toEqual({ points: null, capturedAt: null, status: 'authentication', stale: true });
    });
});
