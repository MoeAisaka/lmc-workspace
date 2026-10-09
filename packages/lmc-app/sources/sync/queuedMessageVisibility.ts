import type { Message } from './typesMessage';
import type { QueuedPrompt } from './turnQueue';
import { compareDisplayMessages } from './messageDisplayOrder';

// Existing Agents persist this success receipt as a generic event. The queue
// already acknowledges acceptance by removing the item; replaying these receipts
// in the transcript adds permanent, repeated rows. Match only this known event,
// never user/assistant text or delivery warnings. Keep the stored history intact.
const STEER_ACCEPTED_RECEIPT = 'Codex 已接收补充回复，将在当前工作中处理。';

/** Queue keys are the sender's localId, not prompt text or a derived row id.
 * Filter before turn grouping so pending input cannot split the active turn.
 * Input/output are newest-first. Consumed prompts appear at their first durable
 * release, not where they were typed while waiting. Only project display order;
 * keep the stored messages, timestamps and identities intact.
 */
export function visibleTranscriptMessages(messages: Message[], queue?: readonly { key: string }[] | null): Message[] {
    const { released, withdrawn } = queueReceipts(messages);
    const pending = new Set(queue?.filter(item => !released.has(item.key)).map(item => item.key));
    // Receipts live in encrypted history, so withdrawal survives reconnects,
    // reloads and runner refreshes. Gather them independently of display order.
    for (const key of withdrawn) pending.add(key);
    const unmoved = new Set<Message>();
    const releasedPrompts = new Map<string, Message[]>();
    for (const message of messages) {
        if (message.kind === 'agent-event' && (message.event.type === 'queue-withdrawn' || message.event.type === 'queue-released')) continue;
        if (message.kind === 'agent-event' && message.event.type === 'message'
            && message.event.message === STEER_ACCEPTED_RECEIPT) continue;
        const key = message.meta?.queueKey ?? (message.kind === 'user-text' ? message.localId ?? message.id : undefined);
        if (key && (withdrawn.has(key) || (message.meta?.queueKey ? !released.has(key) : pending.has(key)))) continue;
        if (key && released.has(key)) {
            const group = releasedPrompts.get(key) ?? [];
            group.push(message);
            releasedPrompts.set(key, group);
        } else {
            unmoved.add(message);
        }
    }
    const visible: Message[] = [];
    for (const message of messages) {
        if (unmoved.has(message)) visible.push(message);
        if (message.kind !== 'agent-event' || message.event.type !== 'queue-released') continue;
        // A batch's keys record consumption order (including promote). Reverse
        // them for the inverted list, preserving each prompt's attachment order.
        for (const key of [...message.event.keys].reverse()) {
            if (released.get(key)?.id !== message.id) continue;
            const group = releasedPrompts.get(key);
            if (group) visible.push(...group);
            releasedPrompts.delete(key);
        }
    }
    return visible.length === messages.length ? messages : visible;
}

function queueReceipts(messages: Message[]) {
    const released = new Map<string, Message>();
    const withdrawn = new Set<string>();
    for (const message of messages) {
        if (message.kind !== 'agent-event') continue;
        if (message.event.type === 'queue-released') {
            for (const key of message.event.keys) {
                const previous = released.get(key);
                // A repeated receipt must not move an already displayed prompt.
                // Use server sequence when present, including across clock skew.
                if (!previous || compareDisplayMessages(previous, message) < 0) released.set(key, message);
            }
        }
        if (message.event.type === 'queue-withdrawn') withdrawn.add(message.event.key);
    }
    return { released, withdrawn };
}

/** The same durable identity drives the strip and transcript, even when message
 * and agentState updates arrive in either order, or a fast consumer skips the
 * waiting snapshot entirely. Never infer consumption from a missing queue row.
 */
export function pendingQueuePrompts(messages: Message[], queue?: readonly QueuedPrompt[] | null): QueuedPrompt[] {
    const { released, withdrawn } = queueReceipts(messages);
    const fullText = new Map<string, string>();
    for (const message of messages) {
        if (message.kind === 'user-text') {
            fullText.set(message.meta?.queueKey ?? message.localId ?? message.id, message.displayText ?? message.text);
        }
    }
    // The agent publishes only a short preview. Join by durable identity, even
    // on legacy queues; never copy that preview or match unrelated equal text.
    const items = new Map<string, QueuedPrompt>((queue ?? [])
        .filter(item => !released.has(item.key) && !withdrawn.has(item.key))
        .map(item => [item.key, { ...item, copyText: fullText.get(item.key) }]));
    const awaiting = messages.filter(message => message.kind === 'user-text' && message.meta?.queueKey)
        .sort((a, b) => a.createdAt - b.createdAt);
    // A composer only marks a prompt `queue` while it sees the engine working,
    // so a later prompt a person sent without that mark means the engine was
    // idle by then — and an idle engine has drained its queue. Without this, a
    // prompt whose release receipt never reached this tab kept spinning in the
    // strip for good. The agent's own queue above still shows anything real.
    const lastIdleSend = messages.reduce<Message | null>((latest, message) => (
        message.kind === 'user-text' && !message.meta?.queueKey && message.meta?.sentFrom
            && (!latest || isLater(message, latest)) ? message : latest
    ), null);
    for (const message of awaiting) {
        if (message.kind !== 'user-text') continue;
        const key = message.meta!.queueKey!;
        if (items.has(key) || released.has(key) || withdrawn.has(key)) continue;
        if (lastIdleSend && isLater(lastIdleSend, message)) continue;
        const preview = (message.displayText ?? message.text).replace(/\s+/g, ' ').trim();
        items.set(key, { key, preview: preview.length > 120 ? preview.slice(0, 119) + '…' : preview, createdAt: message.createdAt, awaitingAgent: true, copyText: fullText.get(key) });
    }
    return [...items.values()];
}

function isLater(a: Message, b: Message): boolean {
    if (a.serverSeq !== undefined && b.serverSeq !== undefined) return a.serverSeq > b.serverSeq;
    return a.createdAt > b.createdAt;
}
