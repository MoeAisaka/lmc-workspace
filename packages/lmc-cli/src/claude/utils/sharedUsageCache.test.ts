import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readSharedUsage, sanitizeRateLimits, usageAccountKey } from './sharedUsageCache';

const windows = { five_hour: { utilization: 12, resets_at: '2026-09-27T12:00:00Z' }, seven_day: { utilization: 40, resets_at: '2026-10-01T00:00:00Z' } };
let dir: string;
let clock: number;
const now = () => clock;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'lmc-usage-')); clock = 1_000_000; });

describe('readSharedUsage', () => {
    it('does not call the endpoint while the shared reading is fresh', async () => {
        const fetchUsage = vi.fn().mockResolvedValue({ available: true, rateLimits: windows });
        await readSharedUsage({ dir, accountKey: 'a', fetchUsage, now });
        clock += 299_000;
        const second = await readSharedUsage({ dir, accountKey: 'a', fetchUsage: vi.fn(), now });
        expect(fetchUsage).toHaveBeenCalledTimes(1);
        expect(second).toEqual({ rateLimits: windows, capturedAt: 1_000_000 });
    });

    it('lets only one of many concurrent sessions call once the reading is stale', async () => {
        let release!: () => void;
        const fetchUsage = vi.fn(() => new Promise<{ available: boolean; rateLimits: unknown }>((resolve) => {
            release = () => resolve({ available: true, rateLimits: windows });
        }));
        const calls = Array.from({ length: 10 }, () => readSharedUsage({ dir, accountKey: 'a', fetchUsage, now }));
        await vi.waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(1));
        release();
        await Promise.all(calls);
        expect(fetchUsage).toHaveBeenCalledTimes(1);
        // The next stale moment is one call again, not ten.
        clock += 300_000;
        await Promise.all(Array.from({ length: 10 }, () => readSharedUsage({ dir, accountKey: 'a', fetchUsage: async () => ({ available: true, rateLimits: windows }), now })));
    });

    it('shares a doubling cooldown after a rate-limited call across the account', async () => {
        const limited = vi.fn().mockResolvedValue({ available: true, rateLimits: null });
        await readSharedUsage({ dir, accountKey: 'a', fetchUsage: limited, now });
        const otherSession = vi.fn().mockResolvedValue({ available: true, rateLimits: windows });
        clock += 299_000;
        expect(await readSharedUsage({ dir, accountKey: 'a', fetchUsage: otherSession, now })).toBeNull();
        expect(otherSession).not.toHaveBeenCalled();
        clock += 2_000;
        const thrown = vi.fn().mockRejectedValue(new Error('429'));
        await readSharedUsage({ dir, accountKey: 'a', fetchUsage: thrown, now });
        expect(thrown).toHaveBeenCalledTimes(1);
        clock += 500_000; // inside the doubled 600 s cooldown
        await readSharedUsage({ dir, accountKey: 'a', fetchUsage: otherSession, now });
        expect(otherSession).not.toHaveBeenCalled();
        clock += 200_000;
        expect(await readSharedUsage({ dir, accountKey: 'a', fetchUsage: otherSession, now })).toEqual({ rateLimits: windows, capturedAt: clock });
        // A different account keeps its own reading and cooldown.
        const b = vi.fn().mockResolvedValue({ available: true, rateLimits: windows });
        await readSharedUsage({ dir, accountKey: 'b', fetchUsage: b, now });
        expect(b).toHaveBeenCalledTimes(1);
    });

    it('writes no credentials or account names to disk', async () => {
        await readSharedUsage({ dir, accountKey: usageAccountKey(['firstParty', 'someone@example.com', 'Org']), now, fetchUsage: async () => ({
            available: true,
            rateLimits: { ...windows, accessToken: 'sk-ant-oat-secret', extra_usage: { monthly_limit: 5, currency: 'USD' }, five_hour_token: { utilization: 1, resets_at: null, token: 'x' } },
        }) });
        const [file] = (await readdir(dir)).filter((name) => name.endsWith('.json'));
        expect(file).toMatch(/^[0-9a-f]{16}\.json$/);
        const text = await readFile(join(dir, file), 'utf8');
        expect(text).not.toMatch(/secret|sk-ant|example\.com|Org|USD|"token"/);
        expect(Object.keys(JSON.parse(text).rateLimits)).toEqual(['five_hour', 'seven_day', 'five_hour_token']);
    });
});

describe('sanitizeRateLimits', () => {
    it('keeps only window shapes', () => {
        expect(sanitizeRateLimits(null)).toBeNull();
        expect(sanitizeRateLimits({ note: 'x', five_hour: { utilization: 3, resets_at: null } })).toEqual({ five_hour: { utilization: 3, resets_at: null } });
    });
});
