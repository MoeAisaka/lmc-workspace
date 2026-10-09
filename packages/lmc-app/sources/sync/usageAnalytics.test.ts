import { describe, it, expect } from 'vitest';
import { summarizeUsage, usageRange } from './usageAnalytics';
import { usageTotal, type UsageRecord } from 'lmc-wire';
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
