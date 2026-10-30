import { describe, it, expect } from 'vitest';
import { fiveHourUsageRange, summarizeUsage, usageCalendar, usageQueryRange, usageRange } from './usageAnalytics';
import { usageTotal, type AccountQuotaSnapshot, type UsageRecord } from 'lmc-wire';
const now = new Date(2026, 9, 5, 12).getTime();
const make = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({ key: 'u2:claude:one', sessionId: 's1', machineId: 'm1', engine: 'claude', model: 'model', occurredAt: now - 60_000, tokens: { input: 10, output: 20, cacheRead: 60, cacheWrite: 10 }, ...overrides });
describe('usage dashboard measures', () => {
    it('reconciles disjoint total, buckets, engines, sessions and models', () => {
        const a = make(), b = make({ key: 'u2:codex:two', sessionId: 's2', machineId: 'm2', engine: 'codex' });
        const s = summarizeUsage([a, a, b], 'today', now);
        expect(usageTotal(s.total)).toBe(200);
        for (const values of [s.buckets, s.engines, s.sessions, s.models]) expect(values.reduce((n, g) => n + usageTotal(g.tokens), 0)).toBe(200);
        expect(s.count).toBe(2); expect(s.perMinute).toBe(20); expect(s.cacheRate).toBe(.75);
    });
    it('filters engine, device and session together and keeps both engines after a switch', () => {
        const records = [make(), make({ key: 'u2:codex:two', engine: 'codex' }), make({ key: 'u2:codex:three', engine: 'codex', machineId: 'm2', sessionId: 's2' })];
        expect(summarizeUsage(records, 'today', now).sessions[0].engines).toEqual(['claude', 'codex']);
        expect(summarizeUsage(records, 'today', now, { engine: 'codex', machineId: 'm1', sessionId: 's1' }).count).toBe(1);
    });
    it('uses calendar-day boundaries and excludes future/outside-window events', () => {
        const range = usageRange('7days', now);
        expect(new Date(range.start).getDate()).toBe(29);
        const s = summarizeUsage([make({ occurredAt: range.start }), make({ key: 'u2:claude:old', occurredAt: range.start - 1 }), make({ key: 'u2:claude:future', occurredAt: now + 100 })], '7days', now);
        expect(s.count).toBe(1); expect(s.buckets).toHaveLength(7); expect(s.perMinute).toBe(0);
    });
    it('distinguishes zero use from undefined cache rate', () => {
        const s = summarizeUsage([], 'today', now);
        expect(s.cacheRate).toBeNull(); expect(usageTotal(s.total)).toBe(0); expect(s.pulse).toHaveLength(30);
    });
});

describe('five-hour usage windows', () => {
    const at = new Date(2026, 9, 18, 2, 37, 21).getTime();
    const quota = (engine: 'codex' | 'claude' = 'codex'): AccountQuotaSnapshot => ({ providers: [{
        engine, plan: null, capturedAt: at - 60_000, refreshFailed: false, stale: false, resetCredits: null,
        windows: [{ id: 'five_hour', remaining: 60, durationMins: 300, pending: false, resetsAt: at + 2 * 3600_000 }],
    }] });
    it('spans midnight, excludes older/future records and conserves disjoint totals', () => {
        const range = usageRange('5hours', at);
        const records = [make({ occurredAt: range.start }), make({ key: 'codex', engine: 'codex', occurredAt: at }),
            make({ key: 'old', occurredAt: range.start - 1 }), make({ key: 'future', occurredAt: at + 1 })];
        const s = summarizeUsage(records, '5hours', at);
        expect(s.count).toBe(2);expect(usageTotal(s.total)).toBe(200);
        expect(s.buckets.reduce((n, b) => n + usageTotal(b.tokens), 0)).toBe(200);
        expect(s.buckets.length).toBeGreaterThanOrEqual(20);
        expect(s.buckets[0].at).toBeLessThanOrEqual(range.start);
    });
    it('aligns a single provider to its actual current reset, without changing token amounts', () => {
        for (const engine of ['claude', 'codex'] as const) {
            const window = fiveHourUsageRange(quota(engine), engine, at);
            expect(window).toEqual({ start: at - 3 * 3600_000, end: at + 1, official: true });
            const s = summarizeUsage([make({ engine, occurredAt: at - 4 * 3600_000 }), make({ engine, key: 'current', occurredAt: at })], '5hours', at, { engine, range: window });
            expect(s.count).toBe(1);expect(usageTotal(s.total)).toBe(100);
        }
    });
    it('uses a rolling window for merged providers or invalid/stale quota data', () => {
        const rolling = { ...usageRange('5hours', at), official: false };
        expect(fiveHourUsageRange(quota(), '', at)).toEqual(rolling);
        expect(fiveHourUsageRange(null, 'codex', at)).toEqual(rolling);
        for (const change of [{ stale: true }, { refreshFailed: true }, { capturedAt: at - 66 * 60_000 }, { capturedAt: at + 61_000 }]) {
            const q = quota();Object.assign(q.providers[0], change);
            expect(fiveHourUsageRange(q, 'codex', at)).toEqual(rolling);
        }
        for (const change of [{ pending: true }, { resetsAt: at }, { resetsAt: at + 6 * 3600_000 }, { durationMins: null }, { durationMins: 60 }]) {
            const q = quota();Object.assign(q.providers[0].windows[0], change);
            expect(fiveHourUsageRange(q, 'codex', at)).toEqual(rolling);
        }
    });
    it('pads the query with a stable start for incremental polls, covering official and rolling windows', () => {
        const query = usageQueryRange('5hours', at), later = usageQueryRange('5hours', at + 30_000);
        expect(query.start).toBe(later.start);
        expect(query.start).toBeLessThanOrEqual(usageRange('5hours', at).start);
        expect(query.start).toBeLessThanOrEqual(fiveHourUsageRange(quota(), 'codex', at).start);
    });
});

describe('monthly usage calendar', () => {
    it('uses real month boundaries across leap years and year navigation', () => {
        const now = new Date(2028, 2, 3, 12).getTime();
        const feb = usageRange('month', now, -1);
        expect(feb).toEqual({ start: new Date(2028, 1, 1).getTime(), end: new Date(2028, 2, 1).getTime() });
        expect(usageCalendar([], now, -1).days).toHaveLength(29);
        expect(usageCalendar([], new Date(2026, 0, 5).getTime(), -1)).toMatchObject({ year: 2025, month: 11 });
        expect(usageRange('month', now, 1)).toEqual(usageRange('month', now));
    });
    it('distinguishes missing data, dates before collection, recorded zero usage and future dates', () => {
        const now = new Date(2026, 9, 18, 12).getTime(), since = new Date(2026, 9, 5, 12).getTime();
        const s = summarizeUsage([make({ occurredAt: since, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })], 'month', now);
        const c = usageCalendar(s.buckets, now, 0, since);
        expect(c.leading).toBe(3);expect(c.days).toHaveLength(31);
        expect(c.days[0].state).toBe('uncollected');expect(c.days[4].state).toBe('recorded');
        expect(c.days[5].state).toBe('empty');expect(c.days[18].state).toBe('future');
        expect(c.days[4].level).toBe(1);
    });
    it('reconciles monthly and selected-day totals after duplicate, engine and device filters', () => {
        const now = new Date(2026, 9, 18, 12).getTime(), day = new Date(2026, 9, 5, 12).getTime();
        const a = make({ occurredAt: day }), b = make({ key: 'two', occurredAt: day + 1000, engine: 'codex' }),
            c = make({ key: 'three', occurredAt: day + 86400_000, engine: 'codex', machineId: 'm2' });
        const s = summarizeUsage([a, a, b, c], 'month', now, { machineId: 'm1' });
        const calendar = usageCalendar(s.buckets, now);
        expect(usageTotal(s.total)).toBe(200);
        expect(calendar.days.reduce((n, d) => n + usageTotal(d.tokens), 0)).toBe(200);
        const fifth = calendar.days[4];
        const detail = s.records.filter(r => r.occurredAt >= fifth.at && r.occurredAt < fifth.end);
        expect(summarizeUsage(detail, 'month', now).sessions[0].engines).toEqual(['codex', 'claude']);
        expect(usageTotal(summarizeUsage(detail, 'month', now, { engine: 'codex' }).total)).toBe(100);
    });
    it('handles UK daylight-saving days without losing calendar totals or repeated hours', () => {
        const previous = process.env.TZ;process.env.TZ = 'Europe/London';
        try {
            const end = new Date(2026, 9, 26, 12).getTime();
            const one = new Date('2026-10-25T01:30:00+01:00').getTime();
            const two = new Date('2026-10-25T01:30:00+00:00').getTime();
            const s = summarizeUsage([make({ occurredAt: one }), make({ key: 'second', occurredAt: two })], 'month', end);
            const day = usageCalendar(s.buckets, end).days[24];
            expect(day.end - day.at).toBe(25 * 3600_000);expect(usageTotal(day.tokens)).toBe(200);
            const daily = summarizeUsage(s.records, 'today', new Date(2026, 9, 25, 23, 59).getTime());
            expect(daily.buckets.filter(b => b.count)).toHaveLength(2);
        } finally { if (previous === undefined) delete process.env.TZ;else process.env.TZ = previous; }
    });
});
