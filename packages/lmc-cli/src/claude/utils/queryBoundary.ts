/**
 * What the remote loop does with the next queued batch.
 *
 * A batch whose mode (model, effort, prompts…) differs from the running query
 * normally ends that query so the next one starts with the new mode. Ending a
 * query only works once Claude exits, and Claude does not exit while a
 * background task it started is still running — a watcher loop never does, so
 * the session sat with its queue full and never answered. While background
 * tasks run, the batch goes into the current query and the mode change waits
 * for the tasks to finish. Isolated batches (slash commands such as /clear)
 * still need a query of their own.
 */
export type QueryBoundaryDecision = 'continue' | 'restart' | 'defer-mode-change';

export function decideQueryBoundary(input: {
    runningModeHash: string | null;
    batchHash: string;
    isolate: boolean;
    carried: boolean;
    backgroundTasks: number;
}): QueryBoundaryDecision {
    if (input.isolate && !input.carried) return 'restart';
    if (input.runningModeHash && input.batchHash !== input.runningModeHash) {
        return input.backgroundTasks > 0 ? 'defer-mode-change' : 'restart';
    }
    return 'continue';
}
