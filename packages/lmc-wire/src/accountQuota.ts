import { z } from 'zod';

/** Sanitized dashboard projection; no identities, tokens, raw errors or other dashboard sources. */
export const AccountQuotaWindowSchema = z.object({
    id: z.enum(['five_hour', 'seven_day', 'fable_week']),
    remaining: z.number().finite().min(0).max(100).nullable(),
    resetsAt: z.number().finite().positive().nullable(), // milliseconds
    durationMins: z.number().finite().positive().nullable(),
    pending: z.boolean(),
});
export const AccountQuotaProviderSchema = z.object({
    engine: z.enum(['codex', 'claude']),
    plan: z.string().max(40).nullable(),
    capturedAt: z.number().finite().positive().nullable(),
    refreshFailed: z.boolean(),
    stale: z.boolean(),
    windows: z.array(AccountQuotaWindowSchema).max(3),
    resetCredits: z.object({ count: z.number().int().min(0), expiresAt: z.number().finite().positive().nullable() }).nullable(),
});
export const AccountQuotaSnapshotSchema = z.object({
    providers: z.array(AccountQuotaProviderSchema).max(2),
});
export type AccountQuotaWindow = z.infer<typeof AccountQuotaWindowSchema>;
export type AccountQuotaProvider = z.infer<typeof AccountQuotaProviderSchema>;
export type AccountQuotaSnapshot = z.infer<typeof AccountQuotaSnapshotSchema>;

/** Same daily allowance rule as the dashboard: today's full share is available
 * at the start of the day; earlier savings carry forward. Not a burn-rate forecast. */
export function quotaDailyPace(window: AccountQuotaWindow, now: number) {
    if (window.pending || !window.resetsAt || !window.durationMins) return null;
    const total = window.durationMins * 60_000;
    const left = window.resetsAt - now;
    const days = total / 86_400_000;
    if (days < 1 || left <= 0 || left > total) return null;
    const day = Math.min(Math.ceil(days), Math.floor((total - left) / 86_400_000) + 1);
    return { day, days: Math.round(days), floor: Math.max(0, 100 - Math.min(days, day) * 100 / days) };
}

/** Dashboard convention: a full Fable pool consumes 50 weekly points.
 * This is a visualization assumption, not a provider guarantee or extra quota. */
export function fableWeeklyShare(weekly: number | null, fable: number | null) {
    if (weekly === null || fable === null || !Number.isFinite(weekly) || !Number.isFinite(fable)) return null;
    const weeklyLeft = Math.max(0, Math.min(100, weekly));
    const fableLeft = Math.max(0, Math.min(100, fable));
    const need = fableLeft * 0.5;
    return { need, spent: 50 - need, covered: Math.min(need, weeklyLeft),
        overflow: Math.max(0, need - weeklyLeft), reachPoolPercent: Math.min(100, weeklyLeft * 2) };
}
