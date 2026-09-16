import type { Metadata } from './storageTypes';
import { refreshWaitReason, type RefreshWaitReason } from './sessionRefreshProgress';

/**
 * Where a plain CLI refresh is, read off the session's metadata.
 *
 * A refresh walks the same road as an engine switch minus the handoff: wait
 * for the turn, check the login, relaunch, verify. The runner records each
 * stretch — `queued` with its wait reason, `sessionConfigStage` for the login
 * check, `refreshing`, `verifying` — and stamps when it was asked, so every
 * device measures the same duration. This turns those into four steps.
 *
 * Unlike a switch there is no message anchoring it: a refresh does not change
 * hands and leaves nothing in the transcript. The card lives at the top of
 * the pane, appears when a refresh is pending, and folds to one line when it
 * lands.
 */
export type RefreshStepKey = 'turn' | 'preflight' | 'restart' | 'verify';
export type RefreshStepTone = 'done' | 'active' | 'todo' | 'failed';
export type RefreshStepDetail =
    | { kind: 'wait'; reason: RefreshWaitReason }
    | { kind: 'runner'; text: string }
    | { kind: 'checking' }
    | { kind: 'not-logged-in' }
    | { kind: 'restarting' }
    | { kind: 'verifying' }
    | { kind: 'stalled' };

export interface RefreshStep {
    key: RefreshStepKey;
    tone: RefreshStepTone;
    detail?: RefreshStepDetail;
}

export type RefreshSteps =
    | { phase: 'idle' }
    | { phase: 'running'; steps: RefreshStep[]; elapsedMs: number; slow: boolean; cancellable: boolean }
    | { phase: 'complete'; tookMs: number | null; finishedAt: number }
    | { phase: 'failed'; steps: RefreshStep[]; elapsedMs: number; error: string | null; stalled: boolean; notLoggedIn: boolean };

const ORDER: RefreshStepKey[] = ['turn', 'preflight', 'restart', 'verify'];
const SLOW_MS = 30_000;
const STALLED_MS = 90_000;
/** How long the one-line "complete" stays before the card goes. */
export const REFRESH_COMPLETE_LINGER_MS = 10_000;

export interface RefreshStepsInput {
    metadata: Metadata | null | undefined;
    session: { thinking?: boolean; agentState?: { requests?: Record<string, unknown> | null } | null };
    now: number;
    /**
     * When this device first saw the refresh pending. Only a fallback for a
     * runner too old to stamp `sessionConfigRequestedAt`; it under-measures on
     * every device but the one that asked.
     */
    observedAt?: number | null;
}

export function sessionRefreshSteps(input: RefreshStepsInput): RefreshSteps {
    const meta = input.metadata;
    const state = meta?.sessionConfigState;
    if (!meta || !state || (state === 'applied' && !meta.sessionConfigUpdatedAt)) return { phase: 'idle' };
    const startedAt = meta.sessionConfigRequestedAt ?? input.observedAt ?? meta.sessionConfigUpdatedAt ?? input.now;
    const elapsedMs = Math.max(0, input.now - startedAt);
    const sinceUpdate = meta.sessionConfigUpdatedAt ? Math.max(0, input.now - meta.sessionConfigUpdatedAt) : 0;

    if (state === 'applied') {
        const finishedAt = meta.sessionConfigUpdatedAt!;
        if (input.now - finishedAt >= REFRESH_COMPLETE_LINGER_MS) return { phase: 'idle' };
        // Without the runner's stamp there is no honest duration: the observed
        // moment is this device's, and the finish may predate it entirely.
        const tookMs = meta.sessionConfigRequestedAt ? Math.max(0, finishedAt - meta.sessionConfigRequestedAt) : null;
        return { phase: 'complete', tookMs, finishedAt };
    }

    let active: RefreshStepKey;
    let detail: RefreshStepDetail | undefined;
    if (state === 'verifying') { active = 'verify'; detail = { kind: 'verifying' }; }
    else if (state === 'refreshing') { active = 'restart'; detail = { kind: 'restarting' }; }
    else if (meta.sessionConfigStage === 'preflight') { active = 'preflight'; detail = { kind: 'checking' }; }
    else if (state === 'queued') {
        active = 'turn';
        detail = meta.sessionConfigError ? { kind: 'runner', text: meta.sessionConfigError } : { kind: 'wait', reason: refreshWaitReason(input.session) };
    } else {
        // error: the runner says which step, or an older one leaves it to the relaunch.
        active = ({ auth: 'preflight', preflight: 'preflight', relaunch: 'restart', verify: 'verify' } as const)[meta.sessionConfigErrorKind ?? 'relaunch'];
        detail = meta.sessionConfigErrorKind === 'auth' ? { kind: 'not-logged-in' } : undefined;
    }

    const build = (failedAt: RefreshStepKey | null): RefreshStep[] => ORDER.map((key) => {
        const index = ORDER.indexOf(key);
        const activeIndex = ORDER.indexOf(active);
        if (index < activeIndex) return { key, tone: 'done' };
        if (index > activeIndex) return { key, tone: 'todo' };
        return { key, tone: failedAt === key ? 'failed' : 'active', detail };
    });

    if (state === 'error') {
        return { phase: 'failed', steps: build(active), elapsedMs, error: meta.sessionConfigError ?? null, stalled: false, notLoggedIn: meta.sessionConfigErrorKind === 'auth' };
    }
    // The old process has left and nothing has reported for a long while: not
    // an error anyone wrote, but not progress either.
    const stalled = (state === 'refreshing' || state === 'verifying') && sinceUpdate >= STALLED_MS;
    if (stalled) {
        const steps = build(active).map((step) => step.tone === 'failed' ? { ...step, detail: { kind: 'stalled' as const } } : step);
        return { phase: 'failed', steps, elapsedMs, error: null, stalled: true, notLoggedIn: false };
    }
    return {
        phase: 'running',
        steps: build(null),
        elapsedMs,
        slow: elapsedMs >= SLOW_MS,
        cancellable: state === 'queued' && meta.sessionCapabilities?.cancelRefresh === true,
    };
}
