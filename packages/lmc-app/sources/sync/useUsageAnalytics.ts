import * as React from 'react';
import { AppState, Platform } from 'react-native';
import { UsageRecordSchema, type UsageRecord } from 'lmc-wire';
import { apiSocket } from './apiSocket';
import { usageRange, type UsagePeriod } from './usageAnalytics';

export type UsageAnalyticsState = { records: UsageRecord[]; loading: boolean; error: string | null;
    collectedSince: number | null; updatedAt: number | null; now: number };
export function useUsageAnalytics(period: UsagePeriod) {
    const [state, setState] = React.useState<UsageAnalyticsState>({ records: [], loading: true, error: null, collectedSince: null, updatedAt: null, now: Date.now() });
    const refreshRef = React.useRef(() => {});
    React.useEffect(() => {
        let disposed = false, busy = false, since = 0, rangeStart = 0;
        const records = new Map<string, UsageRecord>();
        const abort = new AbortController();
        setState({ records: [], loading: true, error: null, collectedSince: null, updatedAt: null, now: Date.now() });
        const refresh = async () => {
            if (busy || (Platform.OS === 'web' && document.hidden)) return;
            busy = true;
            setState(s => ({ ...s, loading: true }));
            const now = Date.now(), range = usageRange(period, now);
            if (range.start !== rangeStart) { since = 0; rangeStart = range.start; records.clear(); }
            try {
                let cursor: string | undefined, snapshotAt: number | undefined, collectedSince: number | null = null;
                const changes = new Map<string, UsageRecord>();
                do {
                    const pageAbort = new AbortController();
                    const cancel = () => pageAbort.abort();
                    abort.signal.addEventListener('abort', cancel, { once: true });
                    const timeout = setTimeout(cancel, 20_000);
                    let response: Response;
                    try {
                        response = await apiSocket.request('/v2/usage/query', { method: 'POST',
                            headers: { 'Content-Type': 'application/json' }, signal: pageAbort.signal,
                            body: JSON.stringify({ ...range, updatedSince: since || undefined, cursor, snapshotAt }) });
                    } finally { clearTimeout(timeout); abort.signal.removeEventListener('abort', cancel); }
                    if (!response.ok) throw new Error(response.status === 404 ? '中心尚未支持用量看板，请升级中心后重试。' : '用量暂时加载失败，请重试。');
                    const page = await response.json();
                    if (!Array.isArray(page.records) || !Number.isFinite(page.snapshotAt)) throw new Error('用量数据格式异常。');
                    for (const value of page.records) {
                        const record = UsageRecordSchema.parse(value);
                        changes.set(`${record.sessionId}:${record.key}`, record);
                    }
                    if (page.nextCursor && page.nextCursor === cursor) throw new Error('用量分页未完成，请重试。');
                    cursor = page.nextCursor ?? undefined; snapshotAt = page.snapshotAt; collectedSince = page.collectedSince;
                } while (cursor && !disposed);
                if (disposed) return;
                for (const [key, record] of changes) records.set(key, record);
                // Overlap covers client/server clock skew and records produced
                // between this request's end time and the server snapshot.
                since = Math.max(0, Math.min(snapshotAt!, range.end) - 300_000);
                setState({ records: [...records.values()], loading: false, error: null, updatedAt: now, collectedSince, now });
            } catch (error) {
                if (!disposed) setState(s => ({ ...s, loading: false, error: error instanceof Error && error.name === 'AbortError'
                    ? '用量加载超时，请重试。' : error instanceof Error ? error.message : '用量加载失败', now }));
            } finally { busy = false; }
        };
        refreshRef.current = () => { void refresh(); };
        void refresh();
        const timer = setInterval(() => { void refresh(); }, 30_000);
        const visible = () => { if (!document.hidden) void refresh(); };
        const sub = AppState.addEventListener('change', state => { if (state === 'active') void refresh(); });
        if (Platform.OS === 'web') document.addEventListener('visibilitychange', visible);
        return () => { disposed = true; abort.abort(); clearInterval(timer); sub.remove(); if (Platform.OS === 'web') document.removeEventListener('visibilitychange', visible); };
    }, [period]);
    return { ...state, refresh: () => refreshRef.current() };
}
