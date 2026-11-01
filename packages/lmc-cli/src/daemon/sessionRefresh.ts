import type { CodexContextLimits } from '@/codex/contextLimits';
import type { CodexServiceTier } from '@/codex/serviceTier';
import type { TrackedSession } from './types';
import type { Metadata } from '@/api/types';
import { findOrphanedSessionPid, type RunningProcess } from './sessionSpawnGuard';
import { REFRESH_EXIT_TIMEOUT } from './lateRefreshRecovery';
/** Detached sessions survive daemon restarts; persisted records intentionally have pid 0. */
export async function canRefreshSession(session: TrackedSession | undefined, pid: number, listProcesses: () => Promise<RunningProcess[]>): Promise<boolean> {
    if (!Number.isSafeInteger(pid) || pid <= 0 || !session?.encryption || !['claude', 'codex', 'agy'].includes(session.happySessionMetadataFromLocalWebhook?.flavor ?? '')) return false;
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
export type SwitchableEngine = 'claude' | 'codex' | 'agy';

/**
 * `engine` turns a refresh into a switch: the same wait-for-idle-then-relaunch,
 * but coming back as the other engine on a new native thread. Absent, this is
 * the ordinary refresh that keeps the engine it has.
 */
export type SessionRefreshOptions = { receiveSeq?: number; model?: string; effort?: string; permissionMode?: string; fastMode?: boolean; codexContextLimits?: CodexContextLimits; codexServiceTier?: CodexServiceTier; engine?: SwitchableEngine };
/** Older Antigravity runners report their last executed model during refresh. */
export function preserveAgyRefreshSelection(options: SessionRefreshOptions, metadata: Metadata): SessionRefreshOptions {
    if (options.engine !== undefined || metadata.flavor !== 'agy') return options;
    return { ...options,
        ...(metadata.modelMode ? { model: metadata.modelMode } : {}),
        ...(metadata.effortLevel ? { effort: metadata.effortLevel } : {}),
        ...(metadata.permissionMode ? { permissionMode: metadata.permissionMode } : {}),
    };
}
/** The daemon never kills the old process; the session exits at its own idle boundary. */
export async function resumeAfterExit(pid: number, alive: (pid: number) => boolean, resume: () => Promise<void>, delay: () => Promise<void>, attempts = 120) {
    for (let i = 0; i < attempts; i++) {
        if (!alive(pid)) { await resume(); return; }
        await delay();
    }
    throw new Error(REFRESH_EXIT_TIMEOUT);
}
