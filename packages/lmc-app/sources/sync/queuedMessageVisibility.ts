import type { Message } from './typesMessage';
import type { QueuedPrompt } from './turnQueue';

// Existing Agents persist this success receipt as a generic event. The queue
// already acknowledges acceptance by removing the item; replaying these receipts
// in the transcript adds permanent, repeated rows. Match only this known event,
// never user/assistant text or delivery warnings. Keep the stored history intact.
const STEER_ACCEPTED_RECEIPT = 'Codex 已接收补充回复，将在当前工作中处理。';

/** Queue keys are the sender's localId, not prompt text or a derived row id.
 * Filter before turn grouping so pending input cannot split the active turn.
 * Keep stored history intact: consumed prompts appear, withdrawn prompts stay hidden.
 */
export function visibleTranscriptMessages(messages: Message[], queue?: readonly { key: string }[] | null): Message[] {
    const { released, withdrawn } = queueReceipts(messages);
    const pending = new Set(queue?.filter(item => !released.has(item.key)).map(item => item.key));
    // Receipts live in encrypted history, so withdrawal survives reconnects,
    // reloads and runner refreshes. Gather them independently of display order.
    for (const key of withdrawn) pending.add(key);
    const visible = messages.filter(message => {
        if (message.kind === 'agent-event' && (message.event.type === 'queue-withdrawn' || message.event.type === 'queue-released')) return false;
        if (message.kind === 'agent-event' && message.event.type === 'message'
            && message.event.message === STEER_ACCEPTED_RECEIPT) return false;
        if (message.meta?.queueKey) return released.has(message.meta.queueKey) && !withdrawn.has(message.meta.queueKey);
        return message.kind !== 'user-text' || !pending.has(message.localId ?? message.id);
    });
    return visible.length === messages.length ? messages : visible;
}

function queueReceipts(messages: Message[]) {
    const released = new Set<string>();
    const withdrawn = new Set<string>();
    for (const message of messages) {
        if (message.kind !== 'agent-event') continue;
        if (message.event.type === 'queue-released') message.event.keys.forEach(key => released.add(key));
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
    for (const message of awaiting) {
        if (message.kind !== 'user-text') continue;
        const key = message.meta!.queueKey!;
        if (items.has(key) || released.has(key) || withdrawn.has(key)) continue;
        const preview = (message.displayText ?? message.text).replace(/\s+/g, ' ').trim();
        items.set(key, { key, preview: preview.length > 120 ? preview.slice(0, 119) + '…' : preview, createdAt: message.createdAt, awaitingAgent: true, copyText: fullText.get(key) });
    }
    return [...items.values()];
}
