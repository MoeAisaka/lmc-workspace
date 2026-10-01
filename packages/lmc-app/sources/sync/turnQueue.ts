import { apiSocket } from './apiSocket';
import type { Metadata } from './storageTypes';

/**
 * What the composer asks the engine to do with a message sent while it is
 * busy. `queue` is the plain Send; the other two are the explicit buttons.
 * See docs/plans/turn-queue-and-interrupt.md.
 */
export type MessageIntent = 'queue' | 'steer' | 'interrupt';
export type QueueMode = 'batch' | 'sequential';
export type QueuedPrompt = {
    key: string;
    preview: string;
    createdAt: number;
    awaitingAgent?: boolean;
    /** Full sender text joined from message history, never the truncated preview. */
    copyText?: string;
};

/** The CLI publishes its queue and answers dequeue / promote. */
export function sessionSupportsTurnQueue(metadata?: Metadata | null): boolean {
    return metadata?.sessionCapabilities?.turnQueue === true;
}

export type SteerState = 'enabled' | 'disabled';

/**
 * Whether a waiting prompt can be handed to the running turn at all.
 *
 * Claude needs an explicitly capable native transport. Older Codex runners
 * already implement this RPC; preserve their existing capability contract.
 */
export function queueSteerState(metadata?: Metadata | null): SteerState {
    if (metadata?.sessionCapabilities?.turnSteer === false) return 'disabled';
    if (metadata?.flavor === 'codex') return 'enabled';
    return metadata?.flavor === 'claude' && metadata.claudeNativeActive === true
        && metadata.sessionCapabilities?.turnSteer === true ? 'enabled' : 'disabled';
}

/** Why the runner would not steer a queued prompt, as something to show a person. */
export function steerFailureKey(reason: string | undefined): 'lmc.queue.steerUnavailable' | 'lmc.queue.steerTooLate' | 'lmc.queue.steerUnconfirmed' | 'lmc.queue.steerNotNow' | 'lmc.queue.steerAttachments' | 'lmc.queue.steerSettings' | 'lmc.queue.steerCommand' | 'lmc.queue.steerIdle' | 'lmc.queue.steerRefreshing' {
    if (reason === 'unsupported') return 'lmc.queue.steerUnavailable';
    if (reason === 'gone') return 'lmc.queue.steerTooLate';
    if (reason === 'unconfirmed') return 'lmc.queue.steerUnconfirmed';
    if (reason === 'attachments') return 'lmc.queue.steerAttachments';
    if (reason === 'settings') return 'lmc.queue.steerSettings';
    if (reason === 'command') return 'lmc.queue.steerCommand';
    if (reason === 'idle') return 'lmc.queue.steerIdle';
    if (reason === 'refreshing') return 'lmc.queue.steerRefreshing';
    return 'lmc.queue.steerNotNow';
}

/** Withdraw a waiting prompt. False when the engine already took it. */
export async function sessionDequeue(sessionId: string, key: string): Promise<boolean> {
    const result = await apiSocket.sessionRPC<{ removed: boolean }, { key: string }>(sessionId, 'dequeue', { key });
    return result.removed === true;
}

/**
 * Move a waiting prompt to the front. When the engine is busy the CLI also
 * interrupts the current turn, so the prompt runs next — the same thing as
 * sending it with intent 'interrupt', without a second transcript entry.
 */
export async function sessionPromoteQueued(sessionId: string, key: string): Promise<{ promoted: boolean; interrupted: boolean }> {
    return apiSocket.sessionRPC<{ promoted: boolean; interrupted: boolean }, { key: string }>(sessionId, 'promote', { key });
}

/**
 * Hand a waiting prompt to the turn already running, leaving it running.
 * The runner names its refusals; `steerFailureKey` turns one into a sentence.
 */
export async function sessionSteerQueued(sessionId: string, key: string): Promise<{ steered: boolean; reason?: string }> {
    return apiSocket.sessionRPC<{ steered: boolean; reason?: string }, { key: string }>(sessionId, 'steer', { key });
}

/** Persisted on the session; the CLI reads it back after a relaunch. */
export async function sessionSetQueueMode(sessionId: string, queueMode: QueueMode): Promise<void> {
    const result = await apiSocket.sessionRPC<{ status: string }, { queueMode: QueueMode }>(sessionId, 'configure-session', { queueMode });
    if (result.status !== 'applied') throw new Error(`queue mode not applied: ${result.status}`);
}
