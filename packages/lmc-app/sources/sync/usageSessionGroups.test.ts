import { describe, expect, it } from 'vitest';
import { usageTotal, type UsageRecord } from 'lmc-wire';
import { summarizeUsage } from './usageAnalytics';
import { groupUsageByHub, usageSessionRoles } from './usageSessionGroups';

const now = new Date(2026, 9, 6, 10).getTime();
const hub = (id: string, workers: string[]) => ({ id, metadata: { orchestration: { role: 'hub' as const, workers: workers.map(sessionId => ({ sessionId })) } } });
const worker = (id: string, hubId: string) => ({ id, metadata: { orchestration: { role: 'worker' as const, hub: { sessionId: hubId } } } });
const record = (sessionId: string, total: number, engine: 'claude' | 'codex' = 'claude', extra: Partial<UsageRecord> = {}): UsageRecord => ({
    sessionId, key: `u2:${engine}:${sessionId}`, machineId: engine === 'claude' ? 'mini' : 'book', engine, model: engine,
    occurredAt: now - 60_000, tokens: { input: total / 10, output: total / 10, cacheRead: total * .7, cacheWrite: total / 10 }, ...extra,
});
const records = [record('hub', 100), record('worker', 300, 'codex'), record('worker', 200), record('plain', 400), record('missing', 500)];
const roles = usageSessionRoles([hub('hub', ['worker', 'worker']), worker('worker', 'hub'), { id: 'plain', metadata: {} }]);

describe('usage grouped by current hub ownership', () => {
    it('reconciles every category and role total without charging duplicate records or worker bindings twice', () => {
        const summary = summarizeUsage([...records, records[0]], 'today', now);
        const result = groupUsageByHub(summary.sessions, roles);
        const team = result.groups.find(g => g.hubId === 'hub')!;
        expect(team.sessions.map(s => s.id)).toEqual(['hub', 'worker']);
        expect(team.sessions[1].engines).toEqual(['codex', 'claude']);
        expect(usageTotal(team.tokens)).toBe(600);
        expect(usageTotal(team.ownTokens)).toBe(100);
        expect(usageTotal(team.workerTokens)).toBe(500);
        expect(usageTotal(result.totals.other)).toBe(900);
        for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
            expect(result.groups.reduce((n, g) => n + g.tokens[field], 0)).toBe(summary.total[field]);
            expect(Object.values(result.totals).reduce((n, t) => n + t[field], 0)).toBe(summary.total[field]);
        }
    });

    it('keeps a hub group when only its worker has records in the selected range', () => {
        const result = groupUsageByHub(summarizeUsage([records[1]], 'today', now).sessions, roles);
        expect(result.groups).toHaveLength(1);
        expect(result.groups[0].hubId).toBe('hub');
        expect(usageTotal(result.groups[0].ownTokens)).toBe(0);
        expect(usageTotal(result.groups[0].workerTokens)).toBe(300);
    });

    it('requires mutual ownership and never guesses from a missing or stale hub list', () => {
        const result = usageSessionRoles([
            hub('old', ['w', 'half']), hub('new', ['w']), worker('w', 'new'),
            worker('half', 'missing'), worker('one-sided', 'new'), { id: 'unknown', metadata: null },
        ]);
        expect(result.w).toEqual({ role: 'worker', hubId: 'new' });
        for (const id of ['half', 'one-sided', 'unknown']) expect(result[id]).toEqual({ role: 'unassigned' });
    });

    it('retains archived session usage and uses the current owner after rebinding', () => {
        const archived = { ...hub('new', ['worker']), metadata: { ...hub('new', ['worker']).metadata, lifecycleState: 'archived' } };
        const current = usageSessionRoles([hub('old', ['worker']), archived, worker('worker', 'new')]);
        const groups = groupUsageByHub(summarizeUsage([records[1]], 'today', now).sessions, current).groups;
        expect(groups.map(g => g.hubId)).toEqual(['new']);
        expect(usageTotal(groups[0].tokens)).toBe(300);
    });

    it.each([{ engine: 'codex' }, { machineId: 'mini' }, { sessionId: 'worker' }])('preserves active filters: %j', filters => {
        const summary = summarizeUsage([...records, record('hub', 700, 'codex', { occurredAt: now - 86400000 })], 'today', now, filters);
        const result = groupUsageByHub(summary.sessions, roles);
        expect(result.groups.reduce((n, g) => n + usageTotal(g.tokens), 0)).toBe(usageTotal(summary.total));
        expect(result.groups.flatMap(g => g.sessions).map(s => s.id).sort()).toEqual(summary.sessions.map(s => s.id).sort());
    });

    it('keeps unknown sessions in other usage and leaves an empty range empty', () => {
        const result = groupUsageByHub(summarizeUsage([records[4]], 'today', now).sessions, {});
        expect(result.groups[0].hubId).toBeNull();
        expect(usageTotal(result.totals.other)).toBe(500);
        expect(groupUsageByHub([], roles).groups).toEqual([]);
    });
});
