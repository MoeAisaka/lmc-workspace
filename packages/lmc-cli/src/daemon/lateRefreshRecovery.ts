import type { RefreshJob, RefreshJournal } from './refreshJournal';

export const REFRESH_EXIT_TIMEOUT = 'Old session did not exit; refusing a duplicate process';

/** A slow, successful exit can arrive after the first watcher expired. Replay
 * its accepted handoff only while the same owner still expects a refresh. */
export async function recoverLateRefreshes(ports: {
    journal: Pick<RefreshJournal, 'list' | 'put'>;
    alive(pid: number): boolean;
    inFlight(id: string): boolean;
    metadata(id: string): Promise<{ hostPid?: number; sessionConfigState?: string; lifecycleState?: string } | null>;
    watch(job: RefreshJob): void;
}) {
    for (const job of await ports.journal.list()) {
        if (job.state !== 'error' || job.error !== REFRESH_EXIT_TIMEOUT
            || !Number.isSafeInteger(job.options.receiveSeq) || job.options.receiveSeq! < 0
            || ports.inFlight(job.sessionId) || ports.alive(job.pid)) continue;
        const metadata = await ports.metadata(job.sessionId);
        if (!metadata || metadata.hostPid !== job.pid || metadata.sessionConfigState !== 'refreshing'
            || ['archiveRequested', 'archived'].includes(metadata.lifecycleState ?? '')
            || ports.inFlight(job.sessionId) || ports.alive(job.pid)) continue;
        const retry: RefreshJob = { ...job, state: 'waiting', updatedAt: Date.now(), error: undefined };
        // Keep the original cursor and settings; this is continuation of the
        // accepted handoff, not a fresh resume that skips pending messages.
        await ports.journal.put(retry);
        ports.watch(retry);
    }
}
