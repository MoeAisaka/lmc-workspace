export type RefreshMetadata = {
    sessionConfigState?: 'queued' | 'refreshing' | 'verifying' | 'applied' | 'error';
    sessionConfigUpdatedAt?: number;
};
const REFRESH_SLOW_MS = 30_000;
const REFRESH_STALLED_MS = 90_000;

export function isRefreshPending(state: RefreshMetadata['sessionConfigState']) {
    return state === 'queued' || state === 'refreshing' || state === 'verifying';
}
export function refreshProgress(meta: RefreshMetadata, now: number) {
    const pendingState = isRefreshPending(meta.sessionConfigState);
    const elapsed = meta.sessionConfigUpdatedAt ? Math.max(0, now - meta.sessionConfigUpdatedAt) : 0;
    const handoffStarted = meta.sessionConfigState === 'refreshing' || meta.sessionConfigState === 'verifying';
    const stalled = pendingState && handoffStarted && !!meta.sessionConfigUpdatedAt && elapsed >= REFRESH_STALLED_MS;
    const pending = pendingState && !stalled;
    return {
        pending, stalled, elapsed,
        slow: pending && elapsed >= REFRESH_SLOW_MS,
        visible: pending || stalled || meta.sessionConfigState === 'error' ||
            (meta.sessionConfigState === 'applied' && !!meta.sessionConfigUpdatedAt && elapsed < 10_000),
    };
}

/**
 * What a queued refresh is actually waiting for.
 *
 * Only the runtime knows a real turn boundary, so the app cannot say when the
 * relaunch will happen — but it can say what is in the way, and the three cases
 * are not equally patient. A turn ends on its own; a permission request waits
 * for the person reading the banner, and saying nothing there leaves them
 * watching a counter climb over a prompt only they can clear.
 */
export type RefreshWaitReason = 'permission' | 'thinking' | 'queue';

export function refreshWaitReason(session: {
    thinking?: boolean;
    agentState?: { requests?: Record<string, unknown> | null } | null;
}): RefreshWaitReason {
    const requests = session.agentState?.requests;
    if (requests && Object.keys(requests).length > 0) return 'permission';
    if (session.thinking) return 'thinking';
    return 'queue';
}
