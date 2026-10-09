import { describe, expect, it } from 'vitest';
import { aiTrafficOf, formatTraffic, providerSum, summarizeAiTraffic, trafficDays } from './aiTraffic';

const GB = 1024 ** 3, MB = 1024 ** 2;
const now = new Date(2026, 9, 8, 21, 30).getTime();
const day = (claudeUp: number, claudeDown = 0, openaiUp = 0, openaiDown = 0) => ({ claude: { up: claudeUp, down: claudeDown }, openai: { up: openaiUp, down: openaiDown } });

describe('AI traffic summary', () => {
    it('lists the local days of each period with today last', () => {
        expect(trafficDays('today', now)).toEqual(['2026-10-08']);
        expect(trafficDays('7days', now)).toEqual(['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']);
        expect(trafficDays('30days', now)).toHaveLength(30);
        expect(trafficDays('30days', now)[0]).toBe('2026-09-09');
    });
    it('reads a ledger from an offline machine and rejects a malformed one', () => {
        const traffic = { updatedAt: 1, days: { '2026-10-08': day(1) } };
        expect(aiTrafficOf({ id: 'm', active: false, daemonState: { aiTraffic: traffic } } as any)).toEqual(traffic);
        expect(aiTrafficOf({ id: 'm', active: true, daemonState: { aiTraffic: { days: 'bad' } } } as any)).toBeNull();
        expect(aiTrafficOf({ id: 'm', active: true, daemonState: null } as any)).toBeNull();
    });
    it('adds up the period per provider and per machine, largest first, and honours the machine filter', () => {
        const machines: Parameters<typeof summarizeAiTraffic>[0] = [
            { id: 'mini', name: 'MacMini', traffic: { updatedAt: 1, days: { '2026-10-08': day(1.5 * GB, 60 * MB, 90 * MB, 100 * MB), '2026-10-07': day(GB) } } },
            { id: 'win', name: 'Work-PC', traffic: { updatedAt: 1, days: { '2026-10-08': day(2 * GB, 70 * MB, 55 * MB, 65 * MB), '2026-09-01': day(9 * GB) } } },
            { id: 'old', name: 'GPD', traffic: null },
        ];
        const today = summarizeAiTraffic(machines, 'today', now);
        expect(today.machines.map(m => m.name)).toEqual(['Work-PC', 'MacMini']);
        expect(today.total.claude).toEqual({ up: 3.5 * GB, down: 130 * MB });
        expect(today.total.openai).toEqual({ up: 145 * MB, down: 165 * MB });
        expect(today.reporting).toBe(true);
        const week = summarizeAiTraffic(machines, '7days', now);
        expect(providerSum(week.total)).toBe(providerSum(today.total) + GB);
        const month = summarizeAiTraffic(machines, '30days', now);
        expect(providerSum(month.total)).toBe(providerSum(week.total));
        expect(summarizeAiTraffic(machines, 'today', now, 'mini').machines.map(m => m.id)).toEqual(['mini']);
        expect(summarizeAiTraffic([{ id: 'old', name: 'GPD', traffic: null }], 'today', now)).toMatchObject({ reporting: false, machines: [], projection: null });
    });
    it('projects a month only from whole days: not today, and not the day recording began', () => {
        // Recording began on the 6th (partial), the 7th is whole, the 8th is today.
        const started = { updatedAt: 1, days: { '2026-10-06': day(100 * MB), '2026-10-07': day(4 * GB), '2026-10-08': day(GB) } };
        const one = summarizeAiTraffic([{ id: 'a', name: 'A', traffic: started }], 'today', now);
        expect(one.projection).toEqual({ dailyBytes: 4 * GB, monthlyBytes: 120 * GB, days: 1 });
        // Only today and the first day: nothing whole yet.
        expect(summarizeAiTraffic([{ id: 'a', name: 'A', traffic: { updatedAt: 1, days: { '2026-10-08': day(GB) } } }], 'today', now).projection).toBeNull();
        // Two machines: each averaged over its own whole days, then added; the fewest days is what is reported.
        const longer = { updatedAt: 1, days: { '2026-10-01': day(1), '2026-10-05': day(2 * GB), '2026-10-06': day(2 * GB), '2026-10-07': day(2 * GB), '2026-10-08': day(1) } };
        const two = summarizeAiTraffic([{ id: 'a', name: 'A', traffic: started }, { id: 'b', name: 'B', traffic: longer }], 'today', now);
        expect(two.projection).toEqual({ dailyBytes: 6 * GB, monthlyBytes: 180 * GB, days: 1 });
        // A full published window means the oldest day is not a starting day.
        const full = { updatedAt: 1, days: Object.fromEntries(Array.from({ length: 35 }, (_, i) => { const d = new Date(2026, 9, 8 - i, 12); return [`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, day(GB)]; })) };
        expect(summarizeAiTraffic([{ id: 'c', name: 'C', traffic: full }], 'today', now).projection).toEqual({ dailyBytes: GB, monthlyBytes: 30 * GB, days: 6 });
    });
    it('formats for a plan bought in gigabytes', () => {
        expect(formatTraffic(4.62 * GB)).toBe('4.62 GB');
        expect(formatTraffic(41.6 * GB)).toBe('41.6 GB');
        expect(formatTraffic(128.4 * GB)).toBe('128 GB');
        expect(formatTraffic(440 * MB)).toBe('440 MB');
        expect(formatTraffic(300 * 1024)).toBe('0.3 MB');
        expect(formatTraffic(0)).toBe('0 MB');
    });
});
