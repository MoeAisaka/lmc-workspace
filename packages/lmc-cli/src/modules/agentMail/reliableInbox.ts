import { createHash } from 'node:crypto';
import { AGENT_MAIL_INBOX_LIMIT, AgentMailReceiptSchema, type AgentMailInbox, type AgentMailReceipt } from 'lmc-wire';
import type { ApiSessionClient } from '@/api/apiSession';
import type { Metadata } from '@/api/types';
import { boardUpdate } from '@/modules/orchestration/board';
import { formatReportEnvelope, parseEnvelope } from '@/modules/orchestration/envelope';
import { relationTo } from '@/modules/orchestration/roles';
import { applyWorkerConfig, configDirectives, hasConfig, isConfigMail, WorkerConfigValidationError, type WorkerConfig } from '@/modules/orchestration/workerConfig';
import { formatIncomingMail, type AgentMailClient, type AgentMailMessage } from './agentMail';

const ACKED_RECEIPTS_KEPT = 32;

type InboxSession = Pick<ApiSessionClient, 'sessionId' | 'getMetadata' | 'updateMetadata' | 'sendUserTextMessage' | 'sendSessionEvent'>;
type InboxMail = Pick<AgentMailClient, 'acknowledge' | 'send'>;

export function inboxOf(metadata: Metadata | null): AgentMailInbox {
    const inbox = metadata?.agentMailInbox ?? {};
    if (typeof inbox !== 'object' || Array.isArray(inbox) || Object.keys(inbox).length > AGENT_MAIL_INBOX_LIMIT
        || Object.values(inbox).some(value => !AgentMailReceiptSchema.safeParse(value).success)) {
        throw new Error('Mail receipt storage is invalid; do not discard its duplicate protection');
    }
    return inbox;
}

/** Only server-confirmed receipts can be evicted. Pending work is never forgotten. */
function roomFor(inbox: AgentMailInbox, id: string): AgentMailInbox {
    if (inbox[id]) return inbox;
    const next = { ...inbox };
    const removable = Object.entries(next).filter(([, value]) => value.phase === 'acked').sort((a, b) => a[1].at - b[1].at);
    while (Object.keys(next).length >= AGENT_MAIL_INBOX_LIMIT && removable.length) delete next[removable.shift()![0]];
    if (Object.keys(next).length >= AGENT_MAIL_INBOX_LIMIT) throw new Error('Mail receipt storage is full of unconfirmed work; acknowledge it before collecting more');
    return next;
}

export const mailDeliveryId = (id: string) => 'agent-mail-' + createHash('sha256').update(id).digest('hex');

function rejectionReport(message: AgentMailMessage, rejection: string): string {
    const task = parseEnvelope(message.text);
    return task?.kind === 'task'
        ? formatReportEnvelope({ id: task.id, attempt: task.attempt, status: 'blocked', fields: {
            dispatch: task.fields.dispatch, summary: 'Task was not started: its requested runtime configuration was rejected.',
            blocked: 'configuration — ' + rejection,
        } })
        : '[notice] ' + rejection;
}

/**
 * The projection and its receipt are one strict metadata write. Session text
 * then uses the server's existing durable localId constraint. A crash at either
 * boundary reuses the same identity; it cannot repeat config, board or a turn.
 */
export async function processReliableMail(
    session: InboxSession, mail: InboxMail, message: AgentMailMessage,
    validateConfig?: (config: WorkerConfig, metadata: Metadata) => Promise<void>,
    active: () => boolean = () => true,
): Promise<void> {
    let receipt = inboxOf(session.getMetadata())[message.id];
    if (receipt?.phase === 'processed' || receipt?.phase === 'acked' || !active()) return;
    if (!receipt) {
        const metadata = session.getMetadata();
        const relation = relationTo(metadata?.orchestration, message.fromSessionId);
        const envelope = parseEnvelope(message.text);
        const config = relation === 'hub' && !message.invalid
            ? (isConfigMail(message.text) ? configDirectives(message.text) : envelope?.kind === 'task' ? configDirectives(envelope.fields.run) : {})
            : {};
        let rejection: string | undefined;
        try { if (metadata && hasConfig(config)) await validateConfig?.(config, metadata); }
        catch (error) {
            if (!(error instanceof WorkerConfigValidationError)) throw error;
            rejection = error.message;
        }
        if (!active()) return;
        const at = Date.now();
        await session.updateMetadata(current => {
            const inbox = inboxOf(current);
            if (inbox[message.id]) return current; // Also protects a concurrent receiving process.
            const room = roomFor(inbox, message.id);
            const currentRelation = relationTo(current.orchestration, message.fromSessionId);
            const rejected = currentRelation === 'hub' ? rejection : undefined;
            let next = current;
            if (currentRelation === 'hub' && hasConfig(config) && !rejected) next = applyWorkerConfig(next, config);
            if (currentRelation && !message.invalid) {
                for (const text of rejected ? [message.text, rejectionReport(message, rejected)] : [message.text]) {
                    next = boardUpdate(text, message.fromSessionId, at)?.(next) ?? next;
                }
            }
            const plan: AgentMailReceipt = {
                phase: 'projected', at, relation: currentRelation,
                kind: message.invalid || rejected || (currentRelation === 'hub' && (isConfigMail(message.text) || envelope?.kind === 'review')) ? 'event' : 'user',
                ...(rejected ? { rejection: rejected } : {}), ...(message.invalid ? { invalid: true } : {}),
            };
            return { ...next, agentMailInbox: { ...room, [message.id]: plan } };
        }, { strict: true });
        receipt = inboxOf(session.getMetadata())[message.id];
        if (!receipt) throw new Error('Mail projection was not confirmed');
    }
    if (receipt.phase !== 'projected' || !active()) return;
    const localId = mailDeliveryId(message.id);
    if (receipt.kind === 'event') {
        const text = receipt.invalid
            ? '[agent-mail] Mail ' + message.id + ' could not be decrypted or had an invalid body. Its ciphertext remains on the center; no model turn was started.'
            : receipt.rejection ? '[configuration] ' + receipt.rejection + ' 原设置保留，本条指令未启动模型回合。' : message.text;
        await session.sendSessionEvent({ type: 'message', message: text }, localId, { localId });
    } else {
        await session.sendUserTextMessage(formatIncomingMail(message, receipt.relation), undefined, { localId });
    }
    if (!active()) return;
    if (receipt.rejection && receipt.relation === 'hub') {
        const sent = await mail.send(message.fromSessionId, rejectionReport(message, receipt.rejection), 1);
        if (!sent.ok) throw new Error('Configuration rejection report is not confirmed');
    }
    await session.updateMetadata(metadata => {
        const inbox = inboxOf(metadata);
        const current = inbox[message.id];
        if (!current) throw new Error('Mail receipt disappeared before processing completed');
        return current.phase !== 'projected' ? metadata : { ...metadata, agentMailInbox: { ...inbox, [message.id]: { ...current, phase: 'processed' } } };
    }, { strict: true });
}

/** Retry even if an ACK succeeded remotely but its response was lost. */
export async function acknowledgeProcessedMail(session: InboxSession, mail: InboxMail, active: () => boolean = () => true): Promise<void> {
    const ids = Object.entries(inboxOf(session.getMetadata())).filter(([, receipt]) => receipt.phase === 'processed').map(([id]) => id);
    for (let start = 0; start < ids.length && active(); start += 20) {
        const batch = ids.slice(start, start + 20);
        if (!await mail.acknowledge(batch)) return;
        await session.updateMetadata(metadata => {
            const inbox = { ...inboxOf(metadata) };
            for (const id of batch) if (inbox[id]?.phase === 'processed') inbox[id] = { ...inbox[id], phase: 'acked' };
            // The center never hands an acknowledged letter out again, so its
            // receipt is only a short tail for diagnosis. Session metadata is
            // synced to every device; do not let it grow with history.
            const acked = Object.entries(inbox).filter(([, receipt]) => receipt.phase === 'acked').sort((a, b) => b[1].at - a[1].at);
            for (const [id] of acked.slice(ACKED_RECEIPTS_KEPT)) delete inbox[id];
            return { ...metadata, agentMailInbox: inbox };
        }, { strict: true });
    }
}
