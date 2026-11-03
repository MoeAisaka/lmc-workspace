import { describe, expect, it } from 'vitest';
import { AccountQuotaSnapshotSchema, fableWeeklyShare, quotaDailyPace, type AccountQuotaWindow } from './accountQuota';

const start = 1_790_000_000_000;
const week: AccountQuotaWindow = { id: 'seven_day', remaining: 72, resetsAt: start + 7 * 86400_000, durationMins: 10080, pending: false };
describe('dashboard dynamic 24h pace with 12h rolling buffer', () => {
    it('gives 12h burst headroom upfront, glides continuously per hour, and tapers smoothly over the final 24h', () => {
        // Fresh reset (168h left): 12h buffer => (168 - 12) / 168 * 100 = 92.857%
        expect(quotaDailyPace(week, start)?.floor).toBeCloseTo((156 / 168) * 100);
        // 2h into Day 1 (166h left): floor is 91.67%, so 92% remaining is not flagged as overspent
        expect(quotaDailyPace(week, start + 2 * 3_600_000)?.floor).toBeCloseTo((154 / 168) * 100);
        // 12h into Day 1 (156h left): matches full first-day share (85.71%)
        expect(quotaDailyPace(week, start + 12 * 3_600_000)?.floor).toBeCloseTo(600 / 7);
        // 24h into week (144h left): glides smoothly instead of jumping a full day
        const d2 = quotaDailyPace(week, start + 86_400_000)!;
        expect(d2.day).toBe(2);
        expect(d2.days).toBe(7);
        expect(d2.floor).toBeCloseTo((132 / 168) * 100);
        // Continuous across the 24h-remaining boundary (no cliff to 0%)
        const beforeLast24h = quotaDailyPace(week, week.resetsAt! - 86_400_000 - 1000)!.floor;
        const afterLast24h = quotaDailyPace(week, week.resetsAt! - 86_400_000 + 1000)!.floor;
        expect(Math.abs(beforeLast24h - afterLast24h)).toBeLessThan(0.01);
        expect(afterLast24h).toBeCloseTo((12 / 168) * 100, 1);
        // 23h08m remaining: stays visibly non-zero (~6.88%) and tapers down to 0 at reset
        const left23h08m = (23 * 60 + 8) * 60_000;
        expect(quotaDailyPace(week, week.resetsAt! - left23h08m)?.floor).toBeCloseTo(((23 * 60 + 8) * 0.5 / 10080) * 100);
        expect(quotaDailyPace(week, week.resetsAt! - 12 * 3_600_000)?.floor).toBeCloseTo((6 / 168) * 100);
    });
    it('does not invent markers for unopened, expired, future or short windows', () => {
        expect(quotaDailyPace({ ...week, pending: true }, start)).toBeNull();
        expect(quotaDailyPace(week, week.resetsAt!)).toBeNull();
        expect(quotaDailyPace(week, start - 1)).toBeNull();
        expect(quotaDailyPace({ ...week, durationMins: 300 }, week.resetsAt! - 1000)).toBeNull();
    });
});
describe('Fable share of the same weekly quota', () => {
    it('shows covered reservation, spending and shortfall in weekly points', () => {
        expect(fableWeeklyShare(20, 60)).toEqual({ need: 30, spent: 20, covered: 20, overflow: 10, reachPoolPercent: 40 });
        expect(fableWeeklyShare(80, 60)?.overflow).toBe(0);
        expect(fableWeeklyShare(21, 0)?.need).toBe(0);
    });
    it('does not turn absent or invalid measurements into zero', () => {
        expect(fableWeeklyShare(20, null)).toBeNull();
        expect(fableWeeklyShare(NaN, 50)).toBeNull();
        expect(AccountQuotaSnapshotSchema.safeParse({ providers: [{ engine: 'codex', windows: [{ remaining: 101 }] }] }).success).toBe(false);
    });
});
