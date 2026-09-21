import type { UsageLimits, UsageLimitWindow } from '@/api/types';

/** App-server account/rateLimits snapshots use percentages and epoch seconds. */
export function codexUsageLimits(value: unknown): UsageLimits | null {
    const data = value as any;
    const snapshot = data?.rateLimitsByLimitId?.codex ?? data?.rateLimits;
    if (!snapshot || (snapshot.limitId && snapshot.limitId !== 'codex')) return null;
    const windows: UsageLimitWindow[] = [];
    for (const window of [snapshot.primary, snapshot.secondary]) {
        if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) continue;
        const minutes = window.windowDurationMins;
        const id = minutes === 300 ? 'five_hour' : minutes === 10080 ? 'seven_day' : null;
        if (!id) continue; // Do not label a different provider window as a week.
        const utilization = Math.max(0, Math.min(100, window.usedPercent));
        windows.push({ id, utilization,
            status: utilization >= 100 ? 'rejected' : utilization >= 90 ? 'allowed_warning' : 'allowed',
            resetsAt: typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) ? window.resetsAt * 1000 : null,
        });
    }
    return { capturedAt: Date.now(), windows };
}
