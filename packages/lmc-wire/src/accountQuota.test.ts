import { describe, expect, it } from 'vitest';
import { AccountQuotaSnapshotSchema, fableWeeklyShare, quotaDailyPace, type AccountQuotaWindow } from './accountQuota';

const start = 1_790_000_000_000;
const week: AccountQuotaWindow = { id: 'seven_day', remaining: 72, resetsAt: start + 7 * 86400_000, durationMins: 10080, pending: false };
describe('dashboard daily allowance', () => {
    it('makes the whole first day available and carries savings forward', () => {
        expect(quotaDailyPace(week, start)?.floor).toBeCloseTo(600 / 7);
        expect(quotaDailyPace(week, start + 86400_000)).toEqual({ day: 2, days: 7, floor: 100 - 200 / 7 });
        expect(quotaDailyPace(week, start + 6 * 86400_000)?.floor).toBe(0);
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
