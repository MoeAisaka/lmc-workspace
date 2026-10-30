import { z } from 'zod';

/** Sent only to the authorized device daemon, over its authenticated channel. */
export const SharedRuntimeSchema = z.object({
    sessionId: z.string().min(1).max(191), accountId: z.string().regex(/^[a-zA-Z0-9_-]{1,191}$/),
    machineId: z.string().min(1).max(191), engine: z.enum(['claude', 'codex', 'agy']),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/), publicKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
    resume: z.boolean(), seq: z.number().int().nonnegative(),
    metadata: z.record(z.string(), z.unknown()),
});
export type SharedRuntime = z.infer<typeof SharedRuntimeSchema>;
