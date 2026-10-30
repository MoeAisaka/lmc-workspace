import { QuotaObservationSchema, QUOTA_SAMPLE_MS, type QuotaObservation, type AccountQuotaSnapshot } from 'lmc-wire';
import { hasAccountQuotaSource, readDashboardQuota } from './accountQuota';

export function quotaObservations(snapshot: AccountQuotaSnapshot, machineId: string, now = Date.now()): QuotaObservation[] {
    return snapshot.providers.flatMap(p => {
        if (p.stale || p.refreshFailed || (p.status && p.status !== 'ready') || !p.capturedAt
            || now - p.capturedAt > 15 * 60_000 || p.capturedAt > now + 60_000) return [];
        const pools = p.engine === 'agy' ? p.groups ?? [] : [{ id: 'account' as const, windows: p.windows }];
        const parsed = QuotaObservationSchema.safeParse({ machineId, engine: p.engine, capturedAt: p.capturedAt,
            pools: pools.map(g => ({ ...g, windows: g.windows.filter(w => !w.pending && w.remaining !== null && w.resetsAt !== null) })).filter(g => g.windows.length) });
        return parsed.success ? [parsed.data] : [];
    });
}
/** One configured source, five-minute samples, bounded retry queue. Collection
 * continues with the dashboard closed. Stale observations never become new samples. */
export function startQuotaHistory(machineId: string, send: (sample: QuotaObservation) => Promise<boolean>) {
    let stopped = false, busy = false;
    const acknowledged = new Map<string, number>();
    const pending = new Map<string, QuotaObservation>();
    const tick = async () => {
        if (stopped || busy || !hasAccountQuotaSource()) return;
        busy = true;
        try {
            const now = Date.now();
            for (const sample of quotaObservations(await readDashboardQuota(), machineId, now)) {
                const bucket = Math.floor(sample.capturedAt / QUOTA_SAMPLE_MS);
                const key = `${sample.engine}:${bucket}`;
                if (bucket > (acknowledged.get(sample.engine) ?? -1) && !pending.has(key)) pending.set(key, sample);
            }
            for (const [key, sample] of pending) {
                if (now - sample.capturedAt > 86400_000) { pending.delete(key); continue; }
                if (stopped || !await send(sample)) break;
                acknowledged.set(sample.engine, Math.max(acknowledged.get(sample.engine) ?? -1, Math.floor(sample.capturedAt / QUOTA_SAMPLE_MS)));
                pending.delete(key);
            }
        } catch { /* Source unavailable: leave a visible sampling gap, never fabricate. */ }
        finally { busy = false; }
    };
    const timer = setInterval(() => void tick(), 60_000);
    timer.unref(); void tick();
    return () => { stopped = true; clearInterval(timer); };
}
