import type { AccountQuotaSnapshot, AccountQuotaWindow } from 'lmc-wire';

type SessionUsage = {
    metadata?: { flavor?: string | null } | null;
    agentState?: { usageLimits?: { capturedAt: number; windows: { id: string; utilization?: number | null; resetsAt?: number | null }[] } | null } | null;
};

const OVERLAID = ['five_hour', 'seven_day'] as const;

/**
 * The account card's numbers come from the device dashboard, which samples
 * the provider every few minutes and falls behind whenever that sampling is
 * rate limited. A running session reads the same account windows through its
 * engine every 30 seconds. Where a session's reading is newer, it wins for the
 * windows both sources name; the Fable window only the dashboard reports.
 */
export function overlaySessionUsage(snapshot: AccountQuotaSnapshot | null, sessions: SessionUsage[]): AccountQuotaSnapshot | null {
    if (!snapshot) return snapshot;
    return {
        ...snapshot,
        providers: snapshot.providers.map((provider) => {
            let newest: NonNullable<NonNullable<SessionUsage['agentState']>['usageLimits']> | null = null;
            for (const session of sessions) {
                const limits = session.agentState?.usageLimits;
                if (session.metadata?.flavor !== provider.engine || !limits || !Number.isFinite(limits.capturedAt)) continue;
                if (!limits.windows.some((w) => OVERLAID.includes(w.id as any) && typeof w.utilization === 'number')) continue;
                if (!newest || limits.capturedAt > newest.capturedAt) newest = limits;
            }
            if (!newest || (provider.capturedAt != null && newest.capturedAt <= provider.capturedAt)) return provider;
            const fresh = newest;
            const windows: AccountQuotaWindow[] = provider.windows.map((window) => {
                const reading = fresh.windows.find((w) => w.id === window.id);
                if (!OVERLAID.includes(window.id as any) || typeof reading?.utilization !== 'number' || !Number.isFinite(reading.utilization)) return window;
                return {
                    ...window,
                    remaining: Math.max(0, Math.min(100, 100 - reading.utilization)),
                    resetsAt: reading.resetsAt && reading.resetsAt > 0 ? reading.resetsAt : window.resetsAt,
                    pending: false,
                };
            });
            return { ...provider, windows, capturedAt: fresh.capturedAt, stale: false, refreshFailed: false };
        }),
    };
}
