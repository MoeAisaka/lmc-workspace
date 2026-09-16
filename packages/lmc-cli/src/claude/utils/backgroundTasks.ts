/**
 * A background task the session still owns blocks the safe refresh boundary, so
 * the bookkeeping has to survive every shape the engine uses to end one:
 * agent tasks emit `task_notification`, `local_bash` tasks only patch their
 * status through `task_updated`. Missing a terminal message pins the task
 * forever and the session can never be refreshed again.
 *
 * That is not hypothetical. A `local_bash` task — "Wait for the archive job to
 * release the lock" — announced itself and then never said another word: its id
 * appears exactly once in 32k lines of log, no process of its own survived, and
 * a sibling task in the same turn was released normally through
 * `task_notification`. Its session sat at `等 1 个后台任务结束` through two
 * Agent rollouts, because `decideRefresh` deliberately never blocks a session
 * that states what it is waiting on — so a lost terminal message is not a
 * delay, it is permanent.
 *
 * Hence `releaseForegroundTasks`. Whether a task outlives its turn is something
 * the engine tells us: `is_backgrounded`. A foreground task cannot still be
 * running once the turn is over, and the turn itself already holds the refresh
 * boundary through `safeIdle` — so releasing those at turn end costs nothing
 * and closes the leak. Backgrounded tasks are exactly the ones the boundary
 * exists for and are kept until they report.
 */
const finished = new Set(['completed', 'failed', 'killed', 'stopped']);

/** taskId → whether the engine said this task outlives its turn. */
export type BackgroundTasks = Map<string, boolean>;

export function isFinishedTaskStatus(status: unknown): boolean {
    return typeof status === 'string' && finished.has(status);
}

/** Returns true when the message ended a task, i.e. a refresh may now proceed. */
export function trackBackgroundTask(tasks: BackgroundTasks, message: unknown): boolean {
    const value = message as { type?: string; subtype?: string; task_id?: unknown; is_backgrounded?: unknown; patch?: { status?: unknown } };
    if (value?.type !== 'system' || typeof value.task_id !== 'string') return false;
    if (value.subtype === 'task_started') { tasks.set(value.task_id, value.is_backgrounded === true); return false; }
    if (value.subtype === 'task_notification'
        || (value.subtype === 'task_updated' && isFinishedTaskStatus(value.patch?.status))) {
        tasks.delete(value.task_id);
        return true;
    }
    return false;
}

/**
 * Drop the tasks that cannot have survived the turn that just ended.
 * Returns true when something was dropped, so the caller can retry the refresh.
 */
export function releaseForegroundTasks(tasks: BackgroundTasks): boolean {
    let released = false;
    for (const [id, backgrounded] of tasks) {
        if (backgrounded) continue;
        tasks.delete(id);
        released = true;
    }
    return released;
}
