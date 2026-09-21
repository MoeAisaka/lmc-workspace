import type { Metadata } from '@/api/types';

// Reconnect starts with synthetic launch metadata, not an authoritative server snapshot.
// Force a version mismatch before any write so ApiSessionClient fetches and merges the
// current server fields; even revision zero must not accept the synthetic snapshot.
export const UNKNOWN_RECONNECT_REVISION = -1;

export const SESSION_STATE_REVISION = 'session-state-20260906-v3';

/** Reapply process-owned fields on every metadata conflict retry, preserving user fields. */
export function refreshSessionRuntimeMetadata(metadata: Metadata, launch: Metadata): Metadata {
    // The engine that is running is the engine the session is on. This used to
    // go without saying, because a session never changed engines and the stored
    // flavor could only agree. A switch reconnects the other engine's runner to
    // the same session, so whoever booted says which one it is — and the thread
    // id belonging to the engine left behind is now a pointer to a conversation
    // this session is no longer having.
    const switched = launch.flavor !== undefined && launch.flavor !== metadata.flavor;
    return {
        ...metadata,
        hostPid: launch.hostPid,
        startedBy: launch.startedBy,
        startedFromDaemon: launch.startedFromDaemon,
        version: launch.version,
        modelCatalogs: launch.modelCatalogs,
        sessionStateRevision: SESSION_STATE_REVISION,
        ...(launch.flavor !== undefined ? { flavor: launch.flavor } : {}),
        // Model and effort are each engine's own vocabulary, and the stored pair
        // names what the engine that just left was running. Carrying it over is
        // not merely stale text under a new icon: the app reads these fields back
        // as the next turn's meta.model, so the engine that just arrived would be
        // asked to run under a name it has never heard of. Whoever booted says
        // what is running; no value means the new engine's own default governs.
        ...(switched ? {
            claudeSessionId: undefined,
            codexThreadId: undefined,
            modelMode: launch.modelMode,
            effortLevel: launch.effortLevel,
        } : {}),
    };
}
