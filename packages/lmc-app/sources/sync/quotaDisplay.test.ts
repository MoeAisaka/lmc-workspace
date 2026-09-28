import { describe, expect, it } from 'vitest';
import type { AccountQuotaProvider } from 'lmc-wire';
import { weeklyRemaining, exhaustedWindow, quotaTone, resetCountdown, weeklyResetLabel } from './quotaDisplay';

const now = Date.UTC(2026, 8, 28, 4, 0);
const provider = (five: number | null, week: number | null, extra: Partial<AccountQuotaProvider> = {}): AccountQuotaProvider => ({
    engine: 'claude', plan: 'max', capturedAt: now - 60_000, refreshFailed: false, stale: false, resetCredits: null,
    windows: [
        { id: 'five_hour', remaining: five, resetsAt: now + 3_600_000, durationMins: 300, pending: false },
        { id: 'seven_day', remaining: week, resetsAt: now + 86_400_000, durationMins: 10080, pending: false },
        { id: 'fable_week', remaining: 1, resetsAt: now + 86_400_000, durationMins: 10080, pending: false },
    ], ...extra,
});

describe('quotaDisplay', () => {
    it('colours by the D23 thresholds', () => {
        expect([100, 50, 49.9, 20, 19.9, 0, null].map(quotaTone)).toEqual(['good', 'good', 'warn', 'warn', 'low', 'low', 'unknown']);
    });

    it('rings the weekly window only, never the 5-hour one or Fable', () => {
        expect(weeklyRemaining(provider(99, 35), now)).toBe(35);
        expect(weeklyRemaining(provider(12, 94), now)).toBe(94);
        expect(weeklyRemaining(provider(50, null), now)).toBeNull();
    });

    it('shows no number for a stale or unread provider, or a window already past its reset', () => {
        expect(weeklyRemaining(provider(99, 35, { stale: true }), now)).toBeNull();
        expect(weeklyRemaining(provider(99, 35, { capturedAt: now - 31 * 60_000 }), now)).toBeNull();
        const reset = provider(99, 5);
        reset.windows[1] = { ...reset.windows[1], resetsAt: now - 1 };
        expect(weeklyRemaining(reset, now)).toBeNull();
    });

    it('names the window that blocks the other one', () => {
        expect(exhaustedWindow(provider(100, 0), now)).toBe('seven_day');
        expect(exhaustedWindow(provider(0, 60), now)).toBe('five_hour');
        expect(exhaustedWindow(provider(10, 60), now)).toBeNull();
    });

    it('writes the countdown and the weekly date', () => {
        expect(resetCountdown(now + (2 * 60 + 23) * 60_000, now)).toEqual({ hours: 2, minutes: 23 });
        expect(resetCountdown(now + 30_000, now)).toEqual({ hours: 0, minutes: 1 });
        const d = new Date(2026, 8, 30, 22, 0).getTime();
        expect(weeklyResetLabel(d, true)).toBe('9/30 周三 22:00');
    });
});
