import type { Message } from './typesMessage';
import type { NormalizedMessage } from './typesRaw';
import type { QueuedPrompt } from './turnQueue';
import { pendingQueuePrompts } from './queuedMessageVisibility';

/** Only query durable orphan rows. A missing queue snapshot is not a receipt. */
export function queueReceiptRecoveryTargets(messages: Message[], queue?: readonly QueuedPrompt[] | null) {
    const waiting = new Set(pendingQueuePrompts(messages, queue).filter(item => item.awaitingAgent).map(item => item.key));
    return messages.flatMap(message => {
        const key = message.meta?.queueKey;
        return message.kind === 'user-text' && key && waiting.has(key) && Number.isSafeInteger(message.serverSeq) && message.serverSeq! > 0
            ? [{ key, seq: message.serverSeq! }] : [];
    }).sort((a, b) => a.seq - b.seq || a.key.localeCompare(b.key));
}

export function isMatchingQueueReceipt(message: NormalizedMessage, keys: ReadonlySet<string>): boolean {
    return message.role === 'event' && !message.isSidechain && (
        message.content.type === 'queue-released' && message.content.keys.some(key => keys.has(key))
        || message.content.type === 'queue-withdrawn' && keys.has(message.content.key)
    );
}
