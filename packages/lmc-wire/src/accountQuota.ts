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
    engine: z.enum(['codex', 'claude', 'agy']),
    status: z.enum(['ready', 'region_restricted', 'sign_in_required', 'unavailable', 'not_installed']).optional(),
    checkedAt: z.number().finite().positive().optional(),
    groups: z.array(z.object({
        id: z.enum(['gemini', 'claude_gpt']),
        windows: z.array(AccountQuotaWindowSchema).max(2),
    })).max(2).optional(),
    plan: z.string().max(40).nullable(),
    capturedAt: z.number().finite().positive().nullable(),
    refreshFailed: z.boolean(),
    stale: z.boolean(),
    windows: z.array(AccountQuotaWindowSchema).max(3),
    usageCredits: z.object({
        balance: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
        unlimited: z.boolean(), capturedAt: z.number().finite().positive(), stale: z.boolean(),
    }).nullable().optional(),
    supplemental: z.object({
        remaining: z.number().finite().min(0).max(100).nullable(),
        capturedAt: z.number().finite().positive().nullable(),
        resetsAt: z.number().finite().positive().nullable(),
        pending: z.boolean(),
        stale: z.boolean(),
    }).nullable().optional(),
    resetCredits: z.object({ count: z.number().int().min(0), expiresAt: z.number().finite().positive().nullable() }).nullable(),
});
export const AccountQuotaSnapshotSchema = z.object({
    providers: z.array(AccountQuotaProviderSchema).max(3),
    refreshing: z.boolean().optional(),
});
export type AccountQuotaWindow = z.infer<typeof AccountQuotaWindowSchema>;
export type AccountQuotaProvider = z.infer<typeof AccountQuotaProviderSchema>;
export type AccountQuotaSnapshot = z.infer<typeof AccountQuotaSnapshotSchema>;

const DAY_MS = 86_400_000;
const PACE_BUFFER_MS = 12 * 3_600_000;

/** Rolling 24h dynamic pace with a 12h daytime burst buffer that tapers
 * smoothly to 0 over the final 24h before reset (continuous, zero day-step jumps). */
export function quotaDailyPace(window: AccountQuotaWindow, now: number) {
    if (window.pending || !window.resetsAt || !window.durationMins) return null;
    const total = window.durationMins * 60_000;
    const left = window.resetsAt - now;
    const days = total / DAY_MS;
    if (days < 1 || left <= 0 || left > total) return null;
    const day = Math.min(Math.ceil(days), Math.floor((total - left) / DAY_MS) + 1);
    const buffer = left >= DAY_MS ? PACE_BUFFER_MS : PACE_BUFFER_MS * (left / DAY_MS);
    const floor = Math.max(0, Math.min(100, ((left - buffer) / total) * 100));
    return { day, days: Math.round(days), floor };
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
