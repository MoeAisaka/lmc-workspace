import { addUsage, emptyUsage, usageTotal, type UsageRecord, type UsageTokens } from 'lmc-wire';

export type UsagePeriod = 'today' | '7days' | '30days';
export function usageRange(period: UsagePeriod, now: number) {
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (period === 'today' ? 0 : period === '7days' ? 6 : 29));
    return { start: start.getTime(), end: now + 1 };
}
export type UsageBucket = { at: number; tokens: UsageTokens; count: number };
export type UsageGroup = { id: string; tokens: UsageTokens; count: number; last: number; engines: string[] };
export function summarizeUsage(records: UsageRecord[], period: UsagePeriod, now: number,
    filters: { engine?: string; machineId?: string; sessionId?: string } = {}) {
    const range = usageRange(period, now);
    const selected = [...new Map(records.map(r => [`${r.sessionId}:${r.key}`, r])).values()].filter(r =>
        r.occurredAt >= range.start && r.occurredAt < range.end && (!filters.engine || r.engine === filters.engine)
        && (!filters.machineId || r.machineId === filters.machineId) && (!filters.sessionId || r.sessionId === filters.sessionId));
    const bucketAt = (time: number) => {
        const d = new Date(time);
        if (period === 'today') d.setMinutes(0, 0, 0); else d.setHours(0, 0, 0, 0);
        return d.getTime();
    };
    const buckets = new Map<number, UsageBucket>();
    const date = new Date(range.start);
    while (date.getTime() <= now) {
        const at = date.getTime(); buckets.set(at, { at, tokens: emptyUsage(), count: 0 });
        if (period === 'today') date.setHours(date.getHours() + 1); else date.setDate(date.getDate() + 1);
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
        group(sessions, r.sessionId, r); group(engines, r.engine, r); group(models, `${r.engine} · ${r.model ?? '未上报型号'}`, r);
        if (r.occurredAt >= now - 600_000) recent += usageTotal(r.tokens);
        const minute = Math.floor(r.occurredAt / 60_000) * 60_000;
        const p = pulse.find(p => p.at === minute); if (p) { p.tokens = addUsage(p.tokens, r.tokens); p.count++; }
    }
    const sorted = (map: Map<string, UsageGroup>) => [...map.values()].sort((a, b) => usageTotal(b.tokens) - usageTotal(a.tokens));
    const denominator = total.input + total.cacheRead + total.cacheWrite;
    return { total, count: selected.length, sessions: sorted(sessions), engines: sorted(engines), models: sorted(models),
        buckets: [...buckets.values()], pulse, perMinute: recent / 10,
        cacheRate: denominator ? total.cacheRead / denominator : null,
        records: selected.sort((a, b) => b.occurredAt - a.occurredAt) };
}

export function compactTokens(value: number) {
    return value >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(2)}M`
        : value >= 1e3 ? `${(value / 1e3).toFixed(1)}K` : Math.round(value).toLocaleString();
}
