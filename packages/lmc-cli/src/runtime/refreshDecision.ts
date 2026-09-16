import type { UpgradeSession } from './upgradeManager';

/**
 * What the upgrade job should do about one session, given what the server
 * says about it and whether its process is still there.
 *
 * Pulled out of the daemon so the one part of a rollout that actually decides
 * things can be tested without a daemon, a socket or a session.
 */
export const REFRESH_REASK_MS = 120_000;
export const REFRESH_MAX_ATTEMPTS = 4;

export type RefreshMetadataView = {
    sessionConfigState?: string;
    sessionConfigError?: string;
    sessionConfigUpdatedAt?: number;
    /** True when the running build already is the release being rolled out. */
    matched: boolean;
    refreshSupported: boolean;
};

export type RefreshDecision =
    | { kind: 'complete' }
    | { kind: 'waiting'; attempts?: number }
    | { kind: 'ask'; attempts: number }
    | { kind: 'blocked'; error: string };

const PENDING = new Set(['queued', 'refreshing', 'verifying']);

export function decideRefresh(session: UpgradeSession, meta: RefreshMetadataView, alive: boolean, now: number): RefreshDecision {
    if (meta.matched && meta.sessionConfigState === 'applied') return { kind: 'complete' };
    if (meta.sessionConfigState === 'error' && session.state !== 'pending') return { kind: 'blocked', error: meta.sessionConfigError || '会话刷新失败' };
    if (!meta.refreshSupported) return { kind: 'blocked', error: '当前会话不支持安全刷新，原会话已保留' };

    const pending = PENDING.has(meta.sessionConfigState ?? '');
    const since = meta.sessionConfigUpdatedAt ? now - meta.sessionConfigUpdatedAt : Infinity;
    if (pending && since < REFRESH_REASK_MS) return { kind: 'waiting' };

    // Past here the state has stopped advancing. Three very different things
    // look like that from the outside, and only one of them deserves a block.
    if (!alive) return { kind: 'blocked', error: '会话进程已不在，原会话身份已保留；请在 app 中恢复该会话' };

    // The runner is alive and has said what it is waiting on — a turn still
    // running, a permission request nobody has answered, a background task.
    // That is a session doing its job, not a stuck one: it is asked again
    // (harmless; a pending refresh returns early) and never counted against.
    // Blocking it was how a session working for nine minutes got left on the
    // old Agent with a message calling it unresponsive.
    if (pending && meta.sessionConfigError) return { kind: 'ask', attempts: session.attempts ?? 0 };

    const attempts = (session.attempts ?? 0) + 1;
    if (attempts > REFRESH_MAX_ATTEMPTS) return { kind: 'blocked', error: '会话多次未响应刷新请求，原会话已保留；请手动重启该会话' };
    if (!pending && session.state === 'waiting' && attempts > 1) return { kind: 'blocked', error: '刷新后版本与目标不一致，请重试' };
    return { kind: 'ask', attempts };
}
