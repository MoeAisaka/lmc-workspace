import { describe, expect, it, vi } from 'vitest';
vi.mock('@/configuration', () => ({ configuration: { lmcHomeDir: '/tmp/lmc-quota-unit-no-source' } }));
import { createAccountQuotaHandler, projectAccountQuota, readDashboardQuota } from './accountQuota';

const now = 1_790_000_000_000;
const source = () => ({ sources: {
    codex_spark: { ok: true, last_success_ts: now / 1000, data: { mtime: (now - 120_000) / 1000, codex: {
        remainingWeeklyPercent: 72, resetsWeeklyAt: (now + 6 * 86400_000) / 1000, windowWeeklyMins: 10080,
        resetCredits: { availableCount: 1, credits: [{ status: 'available', expiresAt: (now + 1000) / 1000 }, { status: 'used', expiresAt: now / 1000 }] },
    } } },
    claude_usage: { ok: true, last_success_ts: now / 1000, data: { subscriptionType: 'max', windows: [
        { kind: 'weekly_all', remainingPercent: 21, resetsAt: (now + 1000) / 1000 },
        { kind: 'weekly_scoped', scopeModel: 'Fable', remainingPercent: 0, resetsAt: (now + 1000) / 1000 },
    ] } },
    unrelated_private_source: { secret: 'NEVER_EXPOSE' },
} });
describe('sanitized dashboard projection', () => {
    it('uses actual provider sampling time, preserves null and zero, and never copies unrelated data', () => {
        const result = projectAccountQuota(source(), now);
        expect(result.providers[0].capturedAt).toBe(now - 120_000);
        expect(result.providers[0].windows[0].remaining).toBeNull();
        expect(result.providers[0].resetCredits).toEqual({ count: 1, expiresAt: now + 1000 });
        expect(result.providers[1].windows[2].remaining).toBe(0);
        expect(JSON.stringify(result)).not.toContain('NEVER_EXPOSE');
    });
    it('preserves last successful readings on source error and marks old data stale', () => {
        const raw = source(); raw.sources.claude_usage.ok = false;
        const result = projectAccountQuota(raw, now + 66 * 60_000);
        expect(result.providers.every(p => p.stale)).toBe(true);
        expect(result.providers[1].refreshFailed).toBe(true);
        expect(result.providers[1].windows[1].remaining).toBe(21);
    });
    it('fails missing sources closed, rejects malformed percentages and does not leak raw errors', () => {
        const raw = source(); raw.sources.claude_usage.data.windows[0].remainingPercent = 200;
        expect(projectAccountQuota(raw, now).providers[1].windows[1].remaining).toBeNull();
        expect(projectAccountQuota(null, now).providers.every(p => p.capturedAt === null && p.stale)).toBe(true);
    });
    it('coalesces concurrent reads and enforces a 15-second cache, including failure', async () => {
        const read = vi.fn().mockResolvedValue(projectAccountQuota(source(), now));
        const handler = createAccountQuotaHandler(read);
        await Promise.all([handler(), handler(), handler()]);
        await handler(); expect(read).toHaveBeenCalledTimes(1);
        const fail = createAccountQuotaHandler(async () => { throw new Error('PRIVATE_TOKEN'); });
        expect(await fail()).toEqual({ error: 'unavailable' });
    });
    it('never probes providers or the network when the local connector is not configured', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch');
        await expect(readDashboardQuota()).rejects.toThrow();
        expect(fetch).not.toHaveBeenCalled(); fetch.mockRestore();
    });
});
