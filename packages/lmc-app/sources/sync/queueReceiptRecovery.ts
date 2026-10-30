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

export type MissingQueuedPromptTarget = {
    key: string;
    beforeSeq: number;
    kind: 'released' | 'queued';
};

/**
 * Symmetric backward recovery: when a durable `queue-released` receipt (or live
 * `agentState.queue` entry) is in the loaded window while its user prompt sits
 * hundreds of messages earlier in unloaded history, locate which prompt keys
 * need to be fetched backward and from what upper-bound sequence.
 */
export function missingQueuedPromptTargets(
    messages: readonly Message[],
    queue?: readonly QueuedPrompt[] | null,
    oldestLoadedSeq?: number,
): MissingQueuedPromptTarget[] {
    const withdrawn = new Set<string>();
    const presentPromptKeys = new Set<string>();
    const releaseSeqByKey = new Map<string, number>();
    let minMessageSeq = Number.POSITIVE_INFINITY;

    for (const message of messages) {
        if (Number.isSafeInteger(message.serverSeq) && message.serverSeq! > 0 && message.serverSeq! < minMessageSeq) {
            minMessageSeq = message.serverSeq!;
        }
        if (message.kind === 'user-text') {
            if (message.meta?.queueKey) presentPromptKeys.add(message.meta.queueKey);
            if (message.localId) presentPromptKeys.add(message.localId);
            presentPromptKeys.add(message.id);
            continue;
        }
        if (message.kind !== 'agent-event') continue;
        if (message.event.type === 'queue-withdrawn') {
            withdrawn.add(message.event.key);
            continue;
        }
        if (message.event.type === 'queue-released' && Number.isSafeInteger(message.serverSeq) && message.serverSeq! > 1) {
            for (const key of message.event.keys) {
                if (!key) continue;
                const previous = releaseSeqByKey.get(key);
                if (previous === undefined || message.serverSeq! < previous) {
                    releaseSeqByKey.set(key, message.serverSeq!);
                }
            }
        }
    }

    const effectiveOldestSeq = Number.isSafeInteger(oldestLoadedSeq) && oldestLoadedSeq! > 0
        ? oldestLoadedSeq!
        : Number.isFinite(minMessageSeq)
            ? minMessageSeq
            : undefined;

    const targets = new Map<string, MissingQueuedPromptTarget>();
    for (const [key, releaseSeq] of releaseSeqByKey) {
        if (withdrawn.has(key) || presentPromptKeys.has(key)) continue;
        const startBefore = effectiveOldestSeq !== undefined
            ? Math.min(releaseSeq, effectiveOldestSeq)
            : releaseSeq;
        if (startBefore > 1) {
            targets.set(key, { key, beforeSeq: startBefore, kind: 'released' });
        }
    }

    if (effectiveOldestSeq !== undefined && effectiveOldestSeq > 1) {
        for (const item of queue ?? []) {
            if (!item.key || withdrawn.has(item.key) || presentPromptKeys.has(item.key) || targets.has(item.key)) continue;
            targets.set(item.key, { key: item.key, beforeSeq: effectiveOldestSeq, kind: 'queued' });
        }
    }

    return [...targets.values()]
        .sort((a, b) => b.beforeSeq - a.beforeSeq || a.key.localeCompare(b.key));
}

export function isMatchingQueuedPromptMessage(message: NormalizedMessage, keys: ReadonlySet<string>): boolean {
    if (message.isSidechain) return false;
    if (message.role === 'user') {
        return Boolean(
            (message.meta?.queueKey && keys.has(message.meta.queueKey))
            || (message.localId && keys.has(message.localId))
            || keys.has(message.id),
        );
    }
    if (message.role === 'agent' && message.meta?.queueKey && keys.has(message.meta.queueKey)) {
        return message.content.some(part => part.type === 'tool-call' && part.name === 'file');
    }
    return false;
}
