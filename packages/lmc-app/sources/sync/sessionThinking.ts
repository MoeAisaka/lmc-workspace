/**
 * `thinking` is the one Session field with three independent writers:
 *
 *  - the debounced activity flush (sync.ts flushActivityUpdates), which stamps
 *    thinkingAt from the ephemeral's activeAt,
 *  - the task_started / task_complete message path (sync.ts), which flips the
 *    flag but deliberately carries the stored thinkingAt forward,
 *  - the sessions fetch (sync.ts fetchSessions), which preserves both.
 *
 * applySessions merges by spreading whatever the caller read from storage, so
 * without a guard the merge is last-writer-wins on a field that means "is the
 * agent working right now". A heartbeat that arrives out of order — or, before
 * the daemon deduplicated resumes, one emitted by a second CLI process bound to
 * the same session — walks the flag backwards and flips the whole session view
 * between working and idle.
 *
 * Only activity-derived timestamps are ever compared here. thinkingAt comes
 * from activeAt, the emitting client's clock; the message path never stamps a
 * server timestamp onto it, so the two clocks never meet in this comparison.
 */

export interface SessionThinkingFacet {
    active: boolean;
    thinking: boolean;
    thinkingAt: number;
}

export interface ResolvedThinking {
    thinking: boolean;
    thinkingAt: number;
    /** True when the incoming update was rejected as stale. */
    stale: boolean;
}

export function resolveThinking(
    previous: SessionThinkingFacet | undefined,
    incoming: SessionThinkingFacet,
): ResolvedThinking {
    // A presence flip is exempt from the ordering rule. The server announces a
    // disconnect with the session's LAST active timestamp (happy-server
    // presence/timeout.ts), legitimately older than what we hold, and a dead
    // session can never send the ephemeral that would clear its own flag — so a
    // preserved `true` there would be immortal.
    const stale = previous !== undefined
        && previous.active === incoming.active
        && incoming.thinkingAt < previous.thinkingAt;

    if (stale) {
        return { thinking: previous!.thinking, thinkingAt: previous!.thinkingAt, stale: true };
    }
    return { thinking: incoming.thinking, thinkingAt: incoming.thinkingAt, stale: false };
}
