import { z } from 'zod';

export const DELEGATION_LEDGER_LIMIT = 256;
export const DelegationRecordSchema = z.object({
    worker: z.string().min(1), attempt: z.number().int().min(1).max(2),
    deadline: z.number(), budgetMinutes: z.number().int().min(1).max(1440),
    dispatch: z.string(), state: z.enum(['dispatched', 'done', 'blocked', 'failed', 'accepted', 'rejected']),
    /** Only an exact, current executor report can grant the quota exception. */
    quotaReport: z.object({ worker: z.string(), attempt: z.number(), dispatch: z.string() }).optional(),
    conflicted: z.boolean().optional(),
}).passthrough();
export type DelegationRecord = z.infer<typeof DelegationRecordSchema>;
export const DelegationLedgerSchema = z.record(z.string(), DelegationRecordSchema)
    .refine(ledger => Object.keys(ledger).length <= DELEGATION_LEDGER_LIMIT, 'Delegation ledger full');

export const DelegationMigrationSchema = z.object({
    target: z.string(), token: z.string(), workers: z.array(z.string()), boundAt: z.number(),
});
export type DelegationMigration = z.infer<typeof DelegationMigrationSchema>;

/** Throw instead of resetting/evicting durable limits, including malformed legacy data. */
export function mergeDelegationLedgers(destination: unknown, source: unknown): Record<string, DelegationRecord> {
    const to = DelegationLedgerSchema.parse(destination === undefined ? {} : destination);
    const from = DelegationLedgerSchema.parse(source === undefined ? {} : source);
    const merged = { ...to };
    for (const [id, older] of Object.entries(from)) {
        const newer = merged[id];
        if (!newer) { merged[id] = older; continue; }
        const winner = older.attempt > newer.attempt ? older : newer;
        const conflict = older.attempt === newer.attempt && (older.worker !== newer.worker || older.dispatch !== newer.dispatch);
        merged[id] = {
            ...winner, attempt: Math.max(older.attempt, newer.attempt),
            deadline: Math.min(older.deadline, newer.deadline),
            budgetMinutes: Math.min(older.budgetMinutes, newer.budgetMinutes),
            ...(older.conflicted || newer.conflicted || conflict ? { conflicted: true } : {}),
        };
    }
    if (Object.keys(merged).length > DELEGATION_LEDGER_LIMIT) throw new Error('Combined delegation ledger exceeds 256 tasks; no limits or ownership may be discarded');
    return merged;
}

export function isQuotaReport(blocked: string | undefined): boolean {
    return /^quota(?:$|[\s:—–-])/i.test(blocked?.trim() ?? '');
}
