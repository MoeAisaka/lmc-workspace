import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDashboardQuotaReader, projectAccountQuota } from './accountQuota';
import { createQuotaBackground } from './quotaBackground';
import { unavailableAgy } from './antigravityQuota';

afterEach(() => vi.useRealTimers());
describe('quota isolation', () => {
    it('returns the dashboard within 200ms while both external probes remain pending', async () => {
        vi.useFakeTimers();
        let creditsDone!: (value: null) => void;
        let agyDone!: (value: ReturnType<typeof unavailableAgy>) => void;
        const dashboard = projectAccountQuota(null);
        dashboard.providers[0].windows[0].remaining = 69;
        const credits = vi.fn(() => new Promise<null>(r => { creditsDone = r; }));
        const agy = vi.fn(() => new Promise<ReturnType<typeof unavailableAgy>>(r => { agyDone = r; }));
        const read = createDashboardQuotaReader(async () => ({ providers: { claude: { enabled: false }, agy: { enabled: true } } }),
            vi.fn().mockResolvedValue(dashboard), credits, agy);
        const first = read();
        await vi.advanceTimersByTimeAsync(200);
        const result = await first;
        expect(result.providers.map(p => p.engine)).toEqual(['codex', 'agy']);
        expect(result.providers[0].windows[0].remaining).toBe(69);
        expect(result.refreshing).toBe(true);
        const second = read();
        await vi.advanceTimersByTimeAsync(200);
        await second;
        expect(credits).toHaveBeenCalledTimes(1); expect(agy).toHaveBeenCalledTimes(1);
        creditsDone(null); agyDone(unavailableAgy('region_restricted'));
        await vi.advanceTimersByTimeAsync(0);
        const completed = await read();
        expect(completed.refreshing).toBe(false);
        expect(completed.providers[1].status).toBe('region_restricted');
    });
    it('returns a warm sample immediately during revalidation, retains it on failure and bounds retries', async () => {
        vi.useFakeTimers();
        const cache = createQuotaBackground<{ balance: number; stale: boolean }>(1000, previous => ({ ...previous!, stale: true }));
        const probe = vi.fn().mockResolvedValue({ balance: 0, stale: false });
        expect((await cache(probe)).value).toEqual({ balance: 0, stale: false });
        await vi.advanceTimersByTimeAsync(1001);
        let reject!: (error: Error) => void;
        probe.mockImplementation(() => new Promise((_, r) => { reject = r; }));
        expect(await cache(probe)).toMatchObject({ value: { balance: 0 }, refreshing: true });
        await cache(probe); expect(probe).toHaveBeenCalledTimes(2);
        reject(new Error('private')); await vi.advanceTimersByTimeAsync(0);
        expect(await cache(probe)).toEqual({ value: { balance: 0, stale: true }, refreshing: false });
        expect(probe).toHaveBeenCalledTimes(2);
    });
    it('does not start disabled optional providers', async () => {
        const credits = vi.fn(), agy = vi.fn();
        const read = createDashboardQuotaReader(async () => ({ providers: { codex: { enabled: false } } }),
            async () => projectAccountQuota(null), credits, agy);
        expect((await read()).providers.map(p => p.engine)).toEqual(['claude']);
        expect(credits).not.toHaveBeenCalled(); expect(agy).not.toHaveBeenCalled();
    });
});
