import { describe, expect, it } from 'vitest';
import type { AccountQuotaSnapshot } from 'lmc-wire';
import { overlaySessionUsage } from './accountQuotaOverlay';

const dashboard: AccountQuotaSnapshot = { providers: [
    { engine: 'claude', plan: 'max', capturedAt: 1_000, refreshFailed: true, stale: true, resetCredits: null, windows: [
        { id: 'five_hour', remaining: 99, resetsAt: 5_000, durationMins: 300, pending: false },
        { id: 'seven_day', remaining: 94, resetsAt: 9_000, durationMins: 10080, pending: false },
        { id: 'fable_week', remaining: 100, resetsAt: 9_000, durationMins: 10080, pending: false },
    ] },
] };
const session = (capturedAt: number, week: number, flavor = 'claude') => ({
    metadata: { flavor },
    agentState: { usageLimits: { capturedAt, windows: [{ id: 'five_hour', utilization: 10, resetsAt: 6_000 }, { id: 'seven_day', utilization: week, resetsAt: 9_500 }] } },
});

describe('overlaySessionUsage', () => {
    it('takes the newest session reading over a lagging dashboard, keeping the Fable window', () => {
        const [claude] = overlaySessionUsage(dashboard, [session(2_000, 20), session(3_000, 30)])!.providers;
        expect(claude.windows.map((w) => w.remaining)).toEqual([90, 70, 100]);
        expect(claude.windows[1].resetsAt).toBe(9_500);
        expect(claude).toMatchObject({ capturedAt: 3_000, stale: false, refreshFailed: false });
    });

    it('keeps the dashboard when it is newer or no session of that engine reports', () => {
        expect(overlaySessionUsage(dashboard, [session(500, 30)])).toEqual(dashboard);
        expect(overlaySessionUsage(dashboard, [session(3_000, 30, 'codex')])).toEqual(dashboard);
        expect(overlaySessionUsage(null, [session(3_000, 30)])).toBeNull();
    });
});
