import { randomUUID } from "node:crypto";
import { logger } from "@/ui/logger";

export type PendingAttachment = { data: Uint8Array; mimeType: string; name: string };

/**
 * How queued prompts are handed to the engine once it is free.
 *
 * `batch` (the default) joins consecutive same-mode prompts into one turn —
 * fewer turns, but one answer covers several questions. `sequential` hands
 * over one prompt per turn so every question gets its own answer.
 */
export type QueueMode = 'batch' | 'sequential';

/**
 * What the app is told about a waiting prompt. The key is the app's own
 * `localKey` when it sent one, so the app can match the entry to the message
 * it already shows; otherwise it is minted here. The preview is a one-line
 * excerpt, not the whole prompt.
 */
export type QueueSnapshotItem = { key: string; preview: string; createdAt: number };

export type QueueInsertOptions = {
    /** Caller-chosen identity, echoed back in snapshots and accepted by removeByKey/promote. */
    key?: string;
};

const PREVIEW_LENGTH = 120;

function previewOf(message: string): string {
    const flat = message.replace(/\s+/g, ' ').trim();
    return flat.length > PREVIEW_LENGTH ? flat.slice(0, PREVIEW_LENGTH - 1) + '…' : flat;
}

export interface QueueItem<T> {
    key: string;
    message: string;
    mode: T;
    modeHash: string;
    isolate?: boolean; // If true, this message must be processed alone
    /** Decoded image attachments owned by *this* message (per-message ownership). */
    attachments?: PendingAttachment[];
    createdAt: number;
}

/** A queue item lifted out by `takeByKey`, carrying the position to put it back at. */
export type TakenItem<T> = QueueItem<T> & { index: number };

/**
 * A mode-aware message queue that stores messages with their modes.
 * Returns consistent batches of messages with the same mode.
 */
export class MessageQueue2<T> {
    public queue: QueueItem<T>[] = []; // Made public for testing
    private waiter: ((hasMessages: boolean) => void) | null = null;
    private closed = false;
    private onMessageHandler: ((message: string, mode: T) => void) | null = null;
    private onChangeHandler: ((snapshot: QueueSnapshotItem[]) => void) | null = null;
    private queueMode: QueueMode = 'batch';
    modeHasher: (mode: T) => string;

    constructor(
        modeHasher: (mode: T) => string,
        onMessageHandler: ((message: string, mode: T) => void) | null = null
    ) {
        this.modeHasher = modeHasher;
        this.onMessageHandler = onMessageHandler;
        logger.debug(`[MessageQueue2] Initialized`);
    }

    /**
     * Set a handler that will be called when a message arrives
     */
    setOnMessage(handler: ((message: string, mode: T) => void) | null): void {
        this.onMessageHandler = handler;
    }

    /**
     * Set a handler called after every change to what is waiting — push,
     * unshift, removal, promotion, reset, and each batch handed out. This is
     * how the queue is published to the app.
     */
    setOnChange(handler: ((snapshot: QueueSnapshotItem[]) => void) | null): void {
        this.onChangeHandler = handler;
    }

    setQueueMode(mode: QueueMode): void {
        this.queueMode = mode;
    }

    getQueueMode(): QueueMode {
        return this.queueMode;
    }

    /**
     * What is waiting, in order, as the app should see it.
     */
    snapshot(): QueueSnapshotItem[] {
        return this.queue.map((item) => ({ key: item.key, preview: previewOf(item.message), createdAt: item.createdAt }));
    }

    /**
     * Push a message to the queue with a mode and an optional list of
     * attachments that travel with this message.
     */
    push(message: string, mode: T, attachments?: PendingAttachment[], options?: QueueInsertOptions): void {
        this.insert('push', message, mode, { isolate: false, attachments, key: options?.key });
    }

    /**
     * Push a message immediately without batching delay.
     * Does not clear the queue or enforce isolation.
     */
    pushImmediate(message: string, mode: T, options?: QueueInsertOptions): void {
        this.insert('pushImmediate', message, mode, { isolate: false, key: options?.key });
    }

    /**
     * Push a message that must be processed in complete isolation.
     * Clears any pending messages and ensures this message is never batched with others.
     * Used for special commands that require dedicated processing.
     */
    pushIsolateAndClear(message: string, mode: T, attachments?: PendingAttachment[], options?: QueueInsertOptions): void {
        if (this.closed) {
            throw new Error('Cannot push to closed queue');
        }
        logger.debug(`[MessageQueue2] pushIsolateAndClear() clearing ${this.queue.length} pending messages`);
        // Clear any pending messages to ensure this message is processed in complete isolation
        this.queue = [];
        this.insert('pushIsolateAndClear', message, mode, { isolate: true, attachments, key: options?.key });
    }

    /**
     * Push a message that must be processed alone without discarding
     * already-queued user prompts.
     */
    pushIsolated(message: string, mode: T, attachments?: PendingAttachment[], options?: QueueInsertOptions): void {
        this.insert('pushIsolated', message, mode, { isolate: true, attachments, key: options?.key });
    }

    /**
     * Push a message to the beginning of the queue with a mode.
     */
    unshift(message: string, mode: T, attachments?: PendingAttachment[], options?: QueueInsertOptions): void {
        this.insert('unshift', message, mode, { isolate: false, attachments, key: options?.key, front: true });
    }

    /**
     * Drop a waiting message. False when nothing with that key is waiting —
     * it may already have been handed to the engine.
     */
    removeByKey(key: string): boolean {
        const index = this.queue.findIndex((item) => item.key === key);
        if (index === -1) return false;
        this.queue.splice(index, 1);
        logger.debug(`[MessageQueue2] removeByKey(${key}). Queue size: ${this.queue.length}`);
        this.emitChange();
        return true;
    }

    /**
     * Lift a waiting message out of the queue, remembering where it sat.
     *
     * For work that may not succeed — handing a queued prompt to a running
     * turn — take it out, try, and `restore` it unchanged if the engine
     * refuses. Null when nothing with that key is waiting.
     */
    takeByKey(key: string): TakenItem<T> | null {
        const index = this.queue.findIndex((item) => item.key === key);
        if (index === -1) return null;
        const [item] = this.queue.splice(index, 1);
        logger.debug(`[MessageQueue2] takeByKey(${key}) from position ${index}`);
        this.emitChange();
        return { ...item, index };
    }

    /** Put a taken message back where it was. */
    restore(taken: TakenItem<T>): void {
        const { index, ...item } = taken;
        this.queue.splice(Math.min(index, this.queue.length), 0, item);
        logger.debug(`[MessageQueue2] restore(${item.key}) at position ${index}`);
        this.emitChange();
    }

    /**
     * Move a waiting message to the front so it goes next. False when the
     * key is not waiting.
     */
    promote(key: string): boolean {
        const index = this.queue.findIndex((item) => item.key === key);
        if (index === -1) return false;
        if (index > 0) {
            const [item] = this.queue.splice(index, 1);
            this.queue.unshift(item);
        }
        logger.debug(`[MessageQueue2] promote(${key}) from position ${index}`);
        this.emitChange();
        return true;
    }

    /**
     * Reset the queue - clears all messages and resets to empty state
     */
    reset(): void {
        logger.debug(`[MessageQueue2] reset() called. Clearing ${this.queue.length} messages`);
        const hadItems = this.queue.length > 0;
        this.queue = [];
        this.closed = false;

        // Clear waiter without calling it since we're not closing
        this.waiter = null;
        if (hadItems) this.emitChange();
    }

    /**
     * Close the queue - no more messages can be pushed
     */
    close(): void {
        logger.debug(`[MessageQueue2] close() called`);
        this.closed = true;

        // Notify any waiting caller
        if (this.waiter) {
            const waiter = this.waiter;
            this.waiter = null;
            waiter(false);
        }
    }

    /**
     * Check if the queue is closed
     */
    isClosed(): boolean {
        return this.closed;
    }

    /**
     * Get the current queue size
     */
    size(): number {
        return this.queue.length;
    }

    /**
     * Wait for messages and return all messages with the same mode as a single string
     * Returns { message: string, mode: T } or null if aborted/closed
     */
    async waitForMessagesAndGetAsString(abortSignal?: AbortSignal): Promise<{ message: string, mode: T, isolate: boolean, hash: string, attachments?: PendingAttachment[] } | null> {
        // If we have messages, return them immediately
        if (this.queue.length > 0) {
            return this.collectBatch();
        }

        // If closed or already aborted, return null
        if (this.closed || abortSignal?.aborted) {
            return null;
        }

        // Wait for messages to arrive
        const hasMessages = await this.waitForMessages(abortSignal);

        if (!hasMessages) {
            return null;
        }

        return this.collectBatch();
    }

    private insert(
        origin: string,
        message: string,
        mode: T,
        opts: { isolate: boolean; attachments?: PendingAttachment[]; key?: string; front?: boolean },
    ): void {
        if (this.closed) {
            throw new Error(`Cannot ${origin === 'unshift' ? 'unshift' : 'push'} to closed queue`);
        }

        const modeHash = this.modeHasher(mode);
        logger.debug(`[MessageQueue2] ${origin}() called with mode hash: ${modeHash}`);

        const item: QueueItem<T> = {
            key: opts.key ?? randomUUID(),
            message,
            mode,
            modeHash,
            isolate: opts.isolate,
            attachments: opts.attachments,
            createdAt: Date.now(),
        };
        if (opts.front) {
            this.queue.unshift(item);
        } else {
            this.queue.push(item);
        }

        // Trigger message handler if set
        if (this.onMessageHandler) {
            this.onMessageHandler(message, mode);
        }
        this.emitChange();

        // Notify waiter if any
        if (this.waiter) {
            logger.debug(`[MessageQueue2] Notifying waiter`);
            const waiter = this.waiter;
            this.waiter = null;
            waiter(true);
        }

        logger.debug(`[MessageQueue2] ${origin}() completed. Queue size: ${this.queue.length}`);
    }

    private emitChange(): void {
        if (!this.onChangeHandler) return;
        try {
            this.onChangeHandler(this.snapshot());
        } catch (error) {
            logger.debug('[MessageQueue2] onChange handler failed', error);
        }
    }

    /**
     * Collect a batch of messages with the same mode, respecting isolation requirements
     */
    private collectBatch(): { message: string, mode: T, hash: string, isolate: boolean, attachments?: PendingAttachment[] } | null {
        if (this.queue.length === 0) {
            return null;
        }

        const firstItem = this.queue[0];
        const sameModeMessages: string[] = [];
        const collectedAttachments: PendingAttachment[] = [];
        let mode = firstItem.mode;
        let isolate = firstItem.isolate ?? false;
        const targetModeHash = firstItem.modeHash;

        // An isolated message is processed alone; so is every message when the
        // queue is sequential.
        if (firstItem.isolate || this.queueMode === 'sequential') {
            const item = this.queue.shift()!;
            sameModeMessages.push(item.message);
            if (item.attachments) collectedAttachments.push(...item.attachments);
            logger.debug(`[MessageQueue2] Collected single message (${firstItem.isolate ? 'isolated' : 'sequential'}) with mode hash: ${targetModeHash}`);
        } else {
            // Collect all messages with the same mode until we hit an isolated message
            while (this.queue.length > 0 &&
                this.queue[0].modeHash === targetModeHash &&
                !this.queue[0].isolate) {
                const item = this.queue.shift()!;
                sameModeMessages.push(item.message);
                if (item.attachments) collectedAttachments.push(...item.attachments);
            }
            logger.debug(`[MessageQueue2] Collected batch of ${sameModeMessages.length} messages with mode hash: ${targetModeHash}`);
        }
        this.emitChange();

        // Join all messages with newlines
        const combinedMessage = sameModeMessages.join('\n');

        return {
            message: combinedMessage,
            mode,
            hash: targetModeHash,
            isolate,
            attachments: collectedAttachments.length > 0 ? collectedAttachments : undefined,
        };
    }

    /**
     * Wait for messages to arrive
     */
    private waitForMessages(abortSignal?: AbortSignal): Promise<boolean> {
        return new Promise((resolve) => {
            let abortHandler: (() => void) | null = null;

            // Set up abort handler
            if (abortSignal) {
                abortHandler = () => {
                    logger.debug('[MessageQueue2] Wait aborted');
                    // Clear waiter if it's still set
                    if (this.waiter === waiterFunc) {
                        this.waiter = null;
                    }
                    resolve(false);
                };
                abortSignal.addEventListener('abort', abortHandler);
            }

            const waiterFunc = (hasMessages: boolean) => {
                // Clean up abort handler
                if (abortHandler && abortSignal) {
                    abortSignal.removeEventListener('abort', abortHandler);
                }
                resolve(hasMessages);
            };

            // Check again in case messages arrived or queue closed while setting up
            if (this.queue.length > 0) {
                if (abortHandler && abortSignal) {
                    abortSignal.removeEventListener('abort', abortHandler);
                }
                resolve(true);
                return;
            }

            if (this.closed || abortSignal?.aborted) {
                if (abortHandler && abortSignal) {
                    abortSignal.removeEventListener('abort', abortHandler);
                }
                resolve(false);
                return;
            }

            // Set the waiter
            this.waiter = waiterFunc;
            logger.debug('[MessageQueue2] Waiting for messages...');
        });
    }
}
