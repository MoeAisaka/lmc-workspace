import { z } from 'zod';
import { AccountQuotaWindowSchema } from './accountQuota';
/** Percentage observations only. Never credentials, prompts, or billing estimates. */
export const QuotaObservationSchema = z.object({
    machineId: z.string().min(1).max(200),
    engine: z.enum(['codex', 'claude', 'agy']),
    capturedAt: z.number().int().positive(),
    pools: z.array(z.object({
        id: z.enum(['account', 'gemini', 'claude_gpt']),
        windows: z.array(AccountQuotaWindowSchema).max(3),
    })).min(1).max(2),
});
export type QuotaObservation = z.infer<typeof QuotaObservationSchema>;
export const QUOTA_SAMPLE_MS = 300_000;
