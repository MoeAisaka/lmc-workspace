import type { CodexContextLimits } from '@/codex/contextLimits';
import type { CodexServiceTier } from '@/codex/serviceTier';
import type { TrackedSession } from './types';
import { findOrphanedSessionPid, type RunningProcess } from './sessionSpawnGuard';
/** Detached sessions survive daemon restarts; persisted records intentionally have pid 0. */
export async function canRefreshSession(session: TrackedSession | undefined, pid: number, listProcesses: () => Promise<RunningProcess[]>): Promise<boolean> {
    if (!Number.isSafeInteger(pid) || pid <= 0 || !session?.encryption || !['claude', 'codex'].includes(session.happySessionMetadataFromLocalWebhook?.flavor ?? '')) return false;
    if (session.pid === pid) return true;
    // Only the restart placeholder may fall back to persisted identity. Never
    // override another tracked owner, and never trust the caller's pid alone.
    if (session.startedBy !== 'persisted' || session.pid !== 0 || session.happySessionMetadataFromLocalWebhook?.hostPid !== pid) return false;
    try {
        return await findOrphanedSessionPid(session, listProcesses) === pid;
    } catch {
        return false;
    }
}
/** The two engines a session can move between. */
export type SwitchableEngine = 'claude' | 'codex';

/**
 * `engine` turns a refresh into a switch: the same wait-for-idle-then-relaunch,
 * but coming back as the other engine on a new native thread. Absent, this is
 * the ordinary refresh that keeps the engine it has.
 */
export type SessionRefreshOptions = { receiveSeq?: number; model?: string; effort?: string; permissionMode?: string; codexContextLimits?: CodexContextLimits; codexServiceTier?: CodexServiceTier; engine?: SwitchableEngine };
/** The daemon never kills the old process; the session exits at its own idle boundary. */
export async function resumeAfterExit(pid: number, alive: (pid: number) => boolean, resume: () => Promise<void>, delay: () => Promise<void>, attempts = 120) {
    for (let i = 0; i < attempts; i++) {
        if (!alive(pid)) { await resume(); return; }
        await delay();
    }
    throw new Error('Old session did not exit; refusing a duplicate process');
}
