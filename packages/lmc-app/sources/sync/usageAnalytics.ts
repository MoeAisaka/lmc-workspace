import { addUsage, emptyUsage, usageTotal, type AccountQuotaSnapshot, type UsageRecord, type UsageTokens } from 'lmc-wire';
import { getCurrentLanguage, t, type SupportedLanguage } from '@/text';

export type UsagePeriod = '5hours' | 'today' | '7days' | '30days' | 'month';
export type UsageTimeRange = { start: number; end: number };
const FIVE_HOURS = 5 * 3600_000;
const QUARTER_HOUR = 15 * 60_000;
export function usageRange(period: UsagePeriod, now: number, monthOffset = 0): UsageTimeRange {
    if (period === '5hours') return { start: now - FIVE_HOURS, end: now + 1 };
    if (period === 'month') {
        const current = new Date(now), offset = Number.isFinite(monthOffset) ? Math.min(0, Math.trunc(monthOffset)) : 0;
        const start = new Date(current.getFullYear(), current.getMonth() + offset, 1).getTime();
        const end = Math.min(now + 1, new Date(current.getFullYear(), current.getMonth() + offset + 1, 1).getTime());
        return { start, end };
    }
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (period === 'today' ? 0 : period === '7days' ? 6 : 29));
    return { start: start.getTime(), end: now + 1 };
}
/** Query one padded hour for a rolling window so each poll can stay incremental.
 * Official five-hour windows start inside this range; provider filtering is local. */
export function usageQueryRange(period: UsagePeriod, now: number, monthOffset = 0): UsageTimeRange {
    const range = usageRange(period, now, monthOffset);
    return period === '5hours' ? { ...range, start: Math.floor(range.start / 3600_000) * 3600_000 } : range;
}

/** A merged provider view has no single official reset window. Never align it to
 * an arbitrary provider, a stale sample, or a reset that has not been confirmed. */
export function fiveHourUsageRange(snapshot: AccountQuotaSnapshot | null | undefined, engine: string, now: number) {
    const rolling = { ...usageRange('5hours', now), official: false };
    const provider = snapshot?.providers.find(p => p.engine === engine);
    const window = provider?.windows.find(w => w.id === 'five_hour');
    const maxAge = (engine === 'codex' ? 65 : 30) * 60_000;
    if (!provider || provider.stale || provider.refreshFailed || !provider.capturedAt
        || provider.capturedAt > now + 60_000 || now - provider.capturedAt > maxAge
        || !window || window.pending || window.durationMins !== 300 || !window.resetsAt
        || !Number.isFinite(window.resetsAt) || window.resetsAt <= now || window.resetsAt > now + FIVE_HOURS) return rolling;
    return { start: window.resetsAt - FIVE_HOURS, end: now + 1, official: true };
}

export type UsageBucket = { at: number; tokens: UsageTokens; count: number };
export type UsageGroup = { id: string; tokens: UsageTokens; count: number; last: number; engines: string[] };
export function summarizeUsage(records: UsageRecord[], period: UsagePeriod, now: number,
    filters: { engine?: string; machineId?: string; sessionId?: string; monthOffset?: number; range?: UsageTimeRange } = {}) {
    const range = filters.range ?? usageRange(period, now, filters.monthOffset);
    const selected = [...new Map(records.map(r => [`${r.sessionId}:${r.key}`, r])).values()].filter(r =>
        r.occurredAt >= range.start && r.occurredAt < range.end && (!filters.engine || r.engine === filters.engine)
        && (!filters.machineId || r.machineId === filters.machineId) && (!filters.sessionId || r.sessionId === filters.sessionId));
    const bucketAt = (time: number) => {
        if (period === '5hours') return Math.floor(time / QUARTER_HOUR) * QUARTER_HOUR;
        const d = new Date(time);
        if (period === 'today') return time - d.getMinutes() * 60_000 - d.getSeconds() * 1000 - d.getMilliseconds();
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    };
    const buckets = new Map<number, UsageBucket>();
    const date = new Date(bucketAt(range.start));
    while (date.getTime() < range.end) {
        const at = date.getTime(); buckets.set(at, { at, tokens: emptyUsage(), count: 0 });
        if (period === '5hours') date.setTime(date.getTime() + QUARTER_HOUR);
        else if (period === 'today') date.setTime(date.getTime() + 3600_000);
        else date.setDate(date.getDate() + 1);
    }
    const sessions = new Map<string, UsageGroup>();
    const engines = new Map<string, UsageGroup>();
    const models = new Map<string, UsageGroup>();
    let total = emptyUsage(), recent = 0;
    const pulse = Array.from({ length: 30 }, (_, i) => ({ at: Math.floor(now / 60_000) * 60_000 - (29 - i) * 60_000, tokens: emptyUsage(), count: 0 }));
    const group = (map: Map<string, UsageGroup>, id: string, r: UsageRecord) => {
        const value = map.get(id) ?? { id, tokens: emptyUsage(), count: 0, last: 0, engines: [] };
        value.tokens = addUsage(value.tokens, r.tokens); value.count++; value.last = Math.max(value.last, r.occurredAt);
        if (!value.engines.includes(r.engine)) value.engines.push(r.engine);
        map.set(id, value);
    };
    for (const r of selected) {
        total = addUsage(total, r.tokens);
        const b = buckets.get(bucketAt(r.occurredAt));
        if (b) { b.tokens = addUsage(b.tokens, r.tokens); b.count++; }
        group(sessions, r.sessionId, r); group(engines, r.engine, r); group(models, `${r.engine} · ${r.model ?? t('lmc.usage.unreportedModel')}`, r);
        if (r.occurredAt >= now - 600_000) recent += usageTotal(r.tokens);
        const minute = Math.floor(r.occurredAt / 60_000) * 60_000;
        const p = pulse.find(p => p.at === minute); if (p) { p.tokens = addUsage(p.tokens, r.tokens); p.count++; }
    }
    const sorted = (map: Map<string, UsageGroup>) => [...map.values()].sort((a, b) => usageTotal(b.tokens) - usageTotal(a.tokens));
    const denominator = total.input + total.cacheRead + total.cacheWrite;
    return { range, total, count: selected.length, sessions: sorted(sessions), engines: sorted(engines), models: sorted(models),
        buckets: [...buckets.values()], pulse, perMinute: recent / 10,
        cacheRate: denominator ? total.cacheRead / denominator : null,
        records: selected.sort((a, b) => b.occurredAt - a.occurredAt) };
}

export type UsageCalendarDay = UsageBucket & { day: number; end: number; level: number; state: 'recorded' | 'empty' | 'uncollected' | 'future' };
export function usageCalendar(buckets: UsageBucket[], now: number, monthOffset = 0, collectedSince: number | null = null) {
    const first = new Date(usageRange('month', now, monthOffset).start);
    const year = first.getFullYear(), month = first.getMonth();
    const byDay = new Map(buckets.map(b => [b.at, b]));
    const max = Math.max(1, ...buckets.map(b => usageTotal(b.tokens)));
    const days: UsageCalendarDay[] = [];
    for (let day = 1; day <= new Date(year, month + 1, 0).getDate(); day++) {
        const at = new Date(year, month, day).getTime(), end = new Date(year, month, day + 1).getTime();
        const bucket = byDay.get(at) ?? { at, tokens: emptyUsage(), count: 0 };
        const state = at > now ? 'future' : bucket.count > 0 ? 'recorded' : collectedSince !== null && end <= collectedSince ? 'uncollected' : 'empty';
        days.push({ ...bucket, day, end, state, level: bucket.count ? Math.max(1, Math.ceil(Math.sqrt(usageTotal(bucket.tokens) / max) * 4)) : 0 });
    }
    return { year, month, leading: (first.getDay() + 6) % 7, days };
}

export function compactTokens(value: number, lang: SupportedLanguage = getCurrentLanguage()) {
    const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
    if (lang === 'zh-Hans') {
        if (safe >= 9_999_500) return `${(safe / 1e8).toFixed(2)}亿`;
        if (safe >= 9_999.5) return `${(safe / 1e4).toFixed(1)}万`;
        return Math.round(safe).toLocaleString('zh-CN');
    }
    return safe >= 1e9 ? `${(safe / 1e9).toFixed(2)}B` : safe >= 1e6 ? `${(safe / 1e6).toFixed(2)}M`
        : safe >= 1e3 ? `${(safe / 1e3).toFixed(1)}K` : Math.round(safe).toLocaleString('en-US');
}
