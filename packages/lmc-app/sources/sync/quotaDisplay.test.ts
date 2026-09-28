import { describe, expect, it } from 'vitest';
import type { AccountQuotaProvider } from 'lmc-wire';
import { bindingRemaining, exhaustedWindow, quotaTone, resetCountdown, weeklyResetLabel } from './quotaDisplay';

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

    it('rings the tighter of the 5-hour and weekly windows, never Fable', () => {
        expect(bindingRemaining(provider(99, 35), now)).toBe(35);
        expect(bindingRemaining(provider(12, 94), now)).toBe(12);
        expect(bindingRemaining(provider(null, 94), now)).toBe(94);
    });

    it('shows no number for a stale or unread provider, or a window already past its reset', () => {
        expect(bindingRemaining(provider(99, 35, { stale: true }), now)).toBeNull();
        expect(bindingRemaining(provider(99, 35, { capturedAt: now - 31 * 60_000 }), now)).toBeNull();
        const reset = provider(99, 5);
        reset.windows[1] = { ...reset.windows[1], resetsAt: now - 1 };
        expect(bindingRemaining(reset, now)).toBe(99);
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
