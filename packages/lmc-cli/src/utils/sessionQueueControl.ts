import { logger } from '@/ui/logger';
import type { AgentState, Metadata } from '@/api/types';
import type { MessageQueue2, QueueSnapshotItem, TakenItem } from './MessageQueue2';
import { isQueueMode, readQueueKey, readQueueMode } from './queueControlRequest';

/**
 * The slice of ApiSessionClient the queue needs: publishing what is waiting,
 * persisting the consumption mode, and taking the two queue RPCs.
 */
export type QueueSessionClient = {
    updateAgentState(handler: (state: AgentState) => AgentState): void;
    updateMetadata(handler: (metadata: Metadata) => Metadata): void;
    sendSessionEvent(event: { type: 'message'; message: string } | { type: 'queue-withdrawn'; key: string }): void;
    rpcHandlerManager: {
        registerHandler<TRequest = any, TResponse = any>(method: string, handler: (data: TRequest) => Promise<TResponse> | TResponse): void;
    };
};

/**
 * Mirror the queue into agentState so the app can show the strip. Called
 * once per engine process, right after the queue is created: it also adopts
 * the persisted consumption mode and clears any queue a previous process
 * left behind in agentState.
 */
export function attachQueuePublisher<T>(queue: MessageQueue2<T>, client: QueueSessionClient, persistedMode: unknown): void {
    if (isQueueMode(persistedMode)) queue.setQueueMode(persistedMode);
    const publish = (snapshot: QueueSnapshotItem[]) => {
        client.updateAgentState((state) => ({ ...state, queue: snapshot.length > 0 ? snapshot : undefined }));
    };
    queue.setOnChange(publish);
    publish(queue.snapshot());
}

/**
 * `configure-session` with only `{ queueMode }`: switch how queued prompts
 * are consumed and remember it on the session. True when the request was
 * that shape and has been handled.
 */
export function applyQueueModeRequest<T>(request: unknown, queue: MessageQueue2<T>, client: QueueSessionClient): boolean {
    const mode = readQueueMode(request);
    if (!mode) return false;
    queue.setQueueMode(mode);
    client.updateMetadata((metadata) => ({ ...metadata, queueMode: mode }));
    logger.debug(`[queue] mode set to ${mode}`);
    return true;
}

/**
 * The three RPCs behind the strip's buttons — sending is only ever queueing,
 * and what to do with a queued prompt is decided here, on the prompt itself.
 *
 * `dequeue { key }` withdraws one. `promote { key }` moves it to the front and,
 * when the engine is busy, interrupts the current turn so it runs next.
 * `steer { key }` hands it to the turn already running, without stopping it.
 * All three answer with what actually happened: a key that is no longer
 * waiting was already handed to the engine.
 */
export function registerQueueControlHandlers<T>(
    client: QueueSessionClient,
    queue: MessageQueue2<T>,
    opts: {
        isBusy: () => boolean;
        interrupt: () => Promise<void>;
        /**
         * Hand one waiting prompt to the running turn. Absent on engines that
         * cannot (Claude Code), which answer `unsupported` rather than quietly
         * doing something else. The item is already out of the queue when this
         * runs; returning `restore: false` keeps it out — used when delivery
         * could not be disproved and resending might duplicate it.
         */
        steer?: (item: TakenItem<T>) => Promise<{ steered: boolean; reason?: string; restore?: boolean }>;
    },
): void {
    client.rpcHandlerManager.registerHandler('dequeue', async (request: unknown) => {
        const key = readQueueKey(request);
        if (!key) throw new Error('dequeue needs { key }');
        if (!queue.snapshot().some(item => item.key === key)) return { removed: false };
        // Enqueue the durable receipt before publishing removal. No await here:
        // the consumer cannot take this key between the check and the removal.
        client.sendSessionEvent({ type: 'queue-withdrawn', key });
        return { removed: queue.removeByKey(key) };
    });
    client.rpcHandlerManager.registerHandler('promote', async (request: unknown) => {
        const key = readQueueKey(request);
        if (!key) throw new Error('promote needs { key }');
        const promoted = queue.promote(key);
        if (!promoted) return { promoted: false, interrupted: false };
        if (!opts.isBusy()) return { promoted: true, interrupted: false };
        await opts.interrupt();
        return { promoted: true, interrupted: true };
    });
    // `steer { key }`: put a waiting prompt into the turn already running,
    // without stopping it. Every refusal names itself, because the app shows
    // the reason rather than a generic failure — and an engine that cannot
    // steer at all must not look like one that merely declined this time.
    client.rpcHandlerManager.registerHandler('steer', async (request: unknown) => {
        const key = readQueueKey(request);
        if (!key) throw new Error('steer needs { key }');
        if (!opts.steer) return { steered: false, reason: 'unsupported' };
        if (!opts.isBusy()) return { steered: false, reason: 'idle' };
        const taken = queue.takeByKey(key);
        if (!taken) return { steered: false, reason: 'gone' };
        let outcome: { steered: boolean; reason?: string; restore?: boolean };
        try {
            outcome = await opts.steer(taken);
        } catch (error) {
            logger.debug('[queue] steer handler failed', error);
            queue.restore(taken);
            return { steered: false, reason: 'refused' };
        }
        if (!outcome.steered && outcome.restore !== false) queue.restore(taken);
        return { steered: outcome.steered, ...(outcome.reason ? { reason: outcome.reason } : {}) };
    });
}
