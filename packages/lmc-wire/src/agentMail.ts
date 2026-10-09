import { z } from 'zod';

/** v2 adds send deduplication; v3 adds recipient acknowledgement. */
export const AGENT_MAIL_RECEIPT_PROTOCOL = 3;
export const AGENT_MAIL_INBOX_LIMIT = 512;

/** Encrypted session metadata, persisted with the effects it protects. */
export const AgentMailReceiptSchema = z.object({
    phase: z.enum(['projected', 'processed', 'acked']),
    kind: z.enum(['user', 'event']),
    relation: z.enum(['hub', 'worker']).nullable(),
    at: z.number(),
    rejection: z.string().optional(),
    invalid: z.boolean().optional(),
});
export type AgentMailReceipt = z.infer<typeof AgentMailReceiptSchema>;
export type AgentMailInbox = Record<string, AgentMailReceipt>;
