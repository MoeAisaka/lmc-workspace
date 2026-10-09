import { z } from 'zod';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Disjoint categories: cache is never added twice to input. No billing inference. */
export const UsageTokensSchema = z.object({ input: count, output: count, cacheRead: count, cacheWrite: count });
export type UsageTokens = z.infer<typeof UsageTokensSchema>;
export const UsageRecordSchema = z.object({
    key: z.string().min(1).max(200).startsWith('u2:'),
    sessionId: z.string().min(1).max(200),
    engine: z.enum(['claude', 'codex']),
    model: z.string().max(200).nullable(),
    machineId: z.string().min(1).max(200),
    occurredAt: z.number().int().positive(),
    tokens: UsageTokensSchema,
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;
export const usageTotal = (t: UsageTokens) => t.input + t.output + t.cacheRead + t.cacheWrite;
export const emptyUsage = (): UsageTokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
export function addUsage(a: UsageTokens, b: UsageTokens): UsageTokens {
    return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}
