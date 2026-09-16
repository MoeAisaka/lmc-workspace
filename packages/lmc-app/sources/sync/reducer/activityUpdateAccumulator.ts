import type { ApiEphemeralActivityUpdate } from '../apiTypes';

/**
 * A turn that has ended must stay ended for this long before the app believes
 * it.
 *
 * `thinking` is a per-process flag: every CLI attached to a session pushes its
 * own value on a 2s keepAlive (happy-cli claude/session.ts, codex/runCodex.ts).
 * When more than one process is bound to a session — the daemon used to spawn a
 * second one on a repeated resume — their turns start together but finish tens
 * of seconds apart, so the stream becomes true/false/true/false at heartbeat
 * rate and the session view flips between working and idle on every packet.
 *
 * Latching on `true` and settling `false` collapses that to the answer the user
 * actually wants: the session is working as long as ANY writer says it is. The
 * window has to outlast one keepAlive period plus jitter, hence 2.5s against a
 * 2s heartbeat — the cost is that a genuine turn end shows up that much later.
 */
const THINKING_STOP_SETTLE_MS = 2500;

export class ActivityUpdateAccumulator {
    private pendingUpdates = new Map<string, ApiEphemeralActivityUpdate>();
    private lastEmittedStates = new Map<string, { active: boolean; thinking: boolean; activeAt: number }>();
    private timeoutId: ReturnType<typeof setTimeout> | null = null;
    private thinkingStopTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(
        private flushHandler: (updates: Map<string, ApiEphemeralActivityUpdate>) => void,
        private debounceDelay: number = 500,
        private thinkingStopSettleDelay: number = THINKING_STOP_SETTLE_MS
    ) {}

    addUpdate(update: ApiEphemeralActivityUpdate): void {
        const sessionId = update.id;
        const lastState = this.lastEmittedStates.get(sessionId);

        const activeChanged = !lastState || lastState.active !== update.active;

        // Out-of-order heartbeat: it describes a moment we have already moved
        // past, so it carries no news and must not walk the state backwards.
        //
        // A presence flip is exempt. The server announces a disconnect with the
        // session's LAST active timestamp (happy-server presence/timeout.ts),
        // which is legitimately older than what we hold, and dropping it would
        // leave the session online forever.
        if (lastState && !activeChanged && update.activeAt < lastState.activeAt) {
            return;
        }

        // Check if this is a critical timestamp update (more than half of disconnect timeout old)
        const timeSinceLastUpdate = lastState ? update.activeAt - lastState.activeAt : 0;
        const isCriticalTimestamp = timeSinceLastUpdate > 60000; // Half of 120 second timeout

        const thinkingChanged = !lastState || lastState.thinking !== update.thinking;

        // Work starting is shown at once; work stopping has to settle first.
        // A disconnect is not a turn ending — it goes through immediately.
        if (thinkingChanged && !update.thinking && !activeChanged) {
            this.scheduleThinkingStop(update);
            return;
        }

        // Anything else is fresher evidence than a pending stop.
        this.cancelThinkingStop(sessionId);

        // Check if this is a significant state change that needs immediate emission
        const isSignificantChange = activeChanged || thinkingChanged || isCriticalTimestamp;

        if (isSignificantChange) {
            // Cancel any pending timeout
            if (this.timeoutId) {
                clearTimeout(this.timeoutId);
                this.timeoutId = null;
            }

            // Add the immediate update to pending updates
            this.pendingUpdates.set(sessionId, update);

            // Flush all pending updates together (batched)
            this.flushPendingUpdates();
        } else {
            // Accumulate for debounced emission (only timestamp updates)
            this.pendingUpdates.set(sessionId, update);

            // Only start a new timer if one isn't already running
            if (!this.timeoutId) {
                this.timeoutId = setTimeout(() => {
                    this.flushPendingUpdates();
                    this.timeoutId = null;
                }, this.debounceDelay);
            }
            // Don't reset the timer for subsequent updates - let it fire!
        }
    }

    /**
     * Arms the settle window on the first uncontested stop. Later stops refresh
     * the payload but keep the original deadline, so a second writer still
     * reporting idle cannot push the transition out indefinitely — only a
     * writer reporting `thinking: true` cancels it.
     */
    private scheduleThinkingStop(update: ApiEphemeralActivityUpdate): void {
        const sessionId = update.id;
        this.pendingUpdates.set(sessionId, update);
        if (this.thinkingStopTimers.has(sessionId)) {
            return;
        }
        this.thinkingStopTimers.set(sessionId, setTimeout(() => {
            this.thinkingStopTimers.delete(sessionId);
            this.flushPendingUpdates();
        }, this.thinkingStopSettleDelay));
    }

    private cancelThinkingStop(sessionId: string): void {
        const timer = this.thinkingStopTimers.get(sessionId);
        if (timer) {
            clearTimeout(timer);
            this.thinkingStopTimers.delete(sessionId);
        }
    }

    private flushPendingUpdates(): void {
        if (this.pendingUpdates.size > 0) {
            // Create a copy of the pending updates
            // A flush for another session must not bypass this session's stop deadline.
            const updatesToFlush = new Map([...this.pendingUpdates].filter(
                ([id]) => !this.thinkingStopTimers.has(id),
            ));
            if (updatesToFlush.size === 0) return;
            
            // Emit all updates in a single batch
            this.flushHandler(updatesToFlush);
            
            // Update last emitted states for all flushed updates
            for (const [sessionId, update] of updatesToFlush) {
                this.lastEmittedStates.set(sessionId, {
                    active: update.active,
                    thinking: update.thinking,
                    activeAt: update.activeAt
                });
            }
            
            // Remove only emitted updates; unsettled stops remain queued.
            for (const id of updatesToFlush.keys()) this.pendingUpdates.delete(id);
        }
    }

    cancel(): void {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        for (const timer of this.thinkingStopTimers.values()) {
            clearTimeout(timer);
        }
        this.thinkingStopTimers.clear();
        this.pendingUpdates.clear();
    }

    reset(): void {
        this.cancel();
        this.lastEmittedStates.clear();
    }

    flush(): void {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        for (const timer of this.thinkingStopTimers.values()) {
            clearTimeout(timer);
        }
        this.thinkingStopTimers.clear();
        this.flushPendingUpdates();
    }
}
