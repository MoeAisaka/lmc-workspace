import type { QueueMode } from './MessageQueue2';

/**
 * What the sender wants done with a message that arrives while the engine is
 * busy. Absent on messages from older apps, which keep today's behaviour.
 *
 * - `queue`: wait for the current turn to finish (the app's plain Send).
 * - `steer`: add to the running turn without stopping it. Only Codex can;
 *   Claude queues it and says so.
 * - `interrupt`: stop the current turn and go next.
 */
export type MessageIntent = 'queue' | 'steer' | 'interrupt';

export function readMessageIntent(meta: unknown): MessageIntent | undefined {
    if (!meta || typeof meta !== 'object') return undefined;
    const intent = (meta as Record<string, unknown>).intent;
    return intent === 'queue' || intent === 'steer' || intent === 'interrupt' ? intent : undefined;
}

/**
 * A `configure-session` request that only changes how queued prompts are
 * consumed: `{ queueMode: 'batch' | 'sequential' }` and nothing else. Both
 * runners check this before the refresh/switch shapes, which reject unknown
 * keys.
 */
export function readQueueMode(request: unknown): QueueMode | null {
    if (!request || typeof request !== 'object') return null;
    const keys = Object.keys(request);
    if (keys.length !== 1 || keys[0] !== 'queueMode') return null;
    const mode = (request as Record<string, unknown>).queueMode;
    return mode === 'batch' || mode === 'sequential' ? mode : null;
}

/**
 * The argument of the `dequeue` and `promote` RPCs: which waiting message.
 */
export function readQueueKey(request: unknown): string | null {
    if (!request || typeof request !== 'object') return null;
    const key = (request as Record<string, unknown>).key;
    return typeof key === 'string' && key.length > 0 ? key : null;
}

export function isQueueMode(value: unknown): value is QueueMode {
    return value === 'batch' || value === 'sequential';
}
