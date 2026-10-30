import { z } from 'zod';

/** Account points only. Never contains a key, account identity or provider error. */
export const PoeBalanceSchema = z.object({
    points: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    capturedAt: z.number().finite().positive().nullable(),
    status: z.enum(['ok', 'unconfigured', 'authentication', 'unavailable']),
    stale: z.boolean(),
});
export type PoeBalance = z.infer<typeof PoeBalanceSchema>;
