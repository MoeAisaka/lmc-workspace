/**
 * Which freshly-bound workers are still waiting on a duty pick, and until
 * when — the state behind the post-drop duty chip row in
 * DeviceEngineSessionList. Kept as pure Map operations, independent of any
 * one worker: arming one must never touch another's entry or clear its
 * timer, which a single shared `{ workerId, timer }` pair cannot promise
 * once two drops land close together.
 *
 * Free of React Native imports, like collaborationDuty.ts, so it can be
 * unit tested directly.
 */

/** Worker session id -> the timestamp its pick offer expires at. */
export type PendingDutyState = ReadonlyMap<string, number>;

export const PENDING_DUTY_MS = 4000;

export function armPendingDuty(state: PendingDutyState, workerId: string, now: number, durationMs: number = PENDING_DUTY_MS): PendingDutyState {
    const next = new Map(state);
    next.set(workerId, now + durationMs);
    return next;
}

export function clearPendingDuty(state: PendingDutyState, workerId: string): PendingDutyState {
    if (!state.has(workerId)) return state;
    const next = new Map(state);
    next.delete(workerId);
    return next;
}

export function isPendingDuty(state: PendingDutyState, workerId: string, now: number): boolean {
    const expiresAt = state.get(workerId);
    return expiresAt !== undefined && expiresAt > now;
}

/** Drops every entry that has timed out by `now`; returns `state` itself when nothing changed. */
export function pruneExpired(state: PendingDutyState, now: number): PendingDutyState {
    let next: Map<string, number> | null = null;
    for (const [workerId, expiresAt] of state) {
        if (expiresAt <= now) {
            if (!next) next = new Map(state);
            next.delete(workerId);
        }
    }
    return next ?? state;
}
