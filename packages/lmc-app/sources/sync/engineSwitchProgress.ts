import type { Message, UserTextMessage } from './typesMessage';
import type { Metadata } from './storageTypes';
import { ENGINE_NAMES } from './engineModelCatalog';
import type { SwitchableEngine } from './engineSwitch';
import { isRefreshPending, refreshWaitReason, type RefreshWaitReason } from './sessionRefreshProgress';

/**
 * Where an engine switch is, read off what the session already records.
 *
 * A switch crosses two processes and, for most of its length, looks to the app
 * like a session that has gone quiet: the request is a user message, the
 * relaunch is a refresh, the arrival is an event. None of those knows about the
 * others. This module reads all three against one request message and says
 * which of the four steps the switch is on, so the transcript can show one
 * card from the confirmation to the arrival instead of three fragments.
 *
 * Nothing here is stored. The request message is the anchor, the metadata is
 * the present, and the handoff event is the proof of completion; every device
 * looking at the session derives the same picture.
 */

/** The first line of the request the app sends the engine being left. */
export const SWITCH_REQUEST_MARKER = '[engine switch requested]';

export function isEngineSwitchRequest(text: string): boolean {
    return text.startsWith(SWITCH_REQUEST_MARKER);
}

/** Which engine the request asks the session to move to. */
export function switchRequestTarget(text: string): SwitchableEngine | null {
    const match = /moving this session to ([^.\n]+)\./.exec(text);
    const name = match?.[1]?.trim();
    const entry = (Object.entries(ENGINE_NAMES) as [SwitchableEngine, string][]).find(([, label]) => label === name);
    return entry ? entry[0] : null;
}

export type SwitchStepKey = 'handoff' | 'turn' | 'preflight' | 'restart' | 'read';
export type SwitchStepState = 'done' | 'active' | 'todo' | 'failed';
/**
 * What the step's second line says. A code, not text, so the derivation stays
 * free of translation; `runner` carries the runtime's own wording when it
 * reported what it is waiting on.
 */
export type SwitchStepDetail =
    | { kind: 'writing' }
    | { kind: 'engine' }
    | { kind: 'compiled' }
    | { kind: 'wait'; reason: RefreshWaitReason }
    | { kind: 'runner'; text: string }
    | { kind: 'checking' }
    | { kind: 'not-logged-in' }
    | { kind: 'restarting' }
    | { kind: 'verifying' }
    | { kind: 'reading' };

export interface SwitchStep {
    key: SwitchStepKey;
    state: SwitchStepState;
    detail?: SwitchStepDetail;
}

interface SwitchIdentity {
    from: SwitchableEngine;
    to: SwitchableEngine;
}

export type EngineSwitchProgress =
    | (SwitchIdentity & { phase: 'complete'; elapsedMs: number; source: 'engine' | 'compiled' })
    | (SwitchIdentity & { phase: 'superseded' })
    | (SwitchIdentity & { phase: 'cancelled' })
    | (SwitchIdentity & {
        phase: 'running'; steps: SwitchStep[]; elapsedMs: number;
        /** Whether the runner would still take the request back: only while it is queued, on an Agent that answers the RPC. */
        cancellable: boolean;
    })
    | (SwitchIdentity & {
        phase: 'failed'; steps: SwitchStep[]; elapsedMs: number; error: string | null; afterRestart: boolean;
        /** The engine the session reports being on now — where the user actually is after the failure. */
        stillOn: SwitchableEngine | null;
    });

/**
 * How long a request may sit with no sign of it in metadata before it counts
 * as lost. The RPC that arms the handoff follows the request message, so for
 * a moment the message exists and nothing else does.
 */
const ARM_GRACE_MS = 20_000;
/**
 * How long the arriving engine may run before its missing handoff event is
 * a failure rather than a delay. It emits the event during startup, so this
 * is generous.
 */
const READ_GRACE_MS = 90_000;

const STEP_ORDER: SwitchStepKey[] = ['handoff', 'turn', 'preflight', 'restart', 'read'];

export interface SwitchProgressInput {
    request: UserTextMessage;
    messages: Message[];
    metadata: Metadata | null | undefined;
    session: { thinking?: boolean; agentState?: { requests?: Record<string, unknown> | null } | null };
    now: number;
}

export function engineSwitchProgress(input: SwitchProgressInput): EngineSwitchProgress | null {
    const to = switchRequestTarget(input.request.text);
    if (!to) return null;
    const from: SwitchableEngine = to === 'claude' ? 'codex' : 'claude';
    const identity = { from, to };

    const later = input.messages.filter((message) => message.createdAt > input.request.createdAt && message.id !== input.request.id);
    const nextRequest = later.find((message) => message.kind === 'user-text' && isEngineSwitchRequest(message.text));
    const beforeNext = (message: Message) => !nextRequest || message.createdAt < nextRequest.createdAt;
    const arrival = later.find((message) => message.kind === 'agent-event' && message.event.type === 'engine-handoff' && beforeNext(message));
    if (arrival && arrival.kind === 'agent-event' && arrival.event.type === 'engine-handoff') {
        return { ...identity, phase: 'complete', elapsedMs: arrival.createdAt - input.request.createdAt, source: arrival.event.source };
    }
    if (later.some((message) => message.kind === 'agent-event' && message.event.type === 'engine-switch-cancelled' && beforeNext(message))) {
        return { ...identity, phase: 'cancelled' };
    }
    if (nextRequest) return { ...identity, phase: 'superseded' };

    const meta = input.metadata ?? null;
    const state = meta?.sessionConfigState;
    const pending = meta?.pendingHandoff;
    const arrived = meta?.flavor === to;
    const stillOn: SwitchableEngine | null = meta?.flavor === 'claude' || meta?.flavor === 'codex' ? meta.flavor : null;
    const elapsedMs = Math.max(0, input.now - input.request.createdAt);
    const sinceUpdate = meta?.sessionConfigUpdatedAt ? input.now - meta.sessionConfigUpdatedAt : 0;

    // The step the switch is on, judged from what is in the way of the next one.
    let active: SwitchStepKey;
    let detail: SwitchStepDetail | undefined;
    if (arrived) {
        active = 'read';
        detail = { kind: 'reading' };
    } else if (state === 'refreshing' || state === 'verifying') {
        active = 'restart';
        detail = { kind: state === 'verifying' ? 'verifying' : 'restarting' };
    } else if (meta?.sessionConfigStage === 'preflight') {
        active = 'preflight';
        detail = { kind: 'checking' };
    } else if (pending?.source === 'engine') {
        active = 'turn';
        // The runner's own answer wins when it gave one: it can see which of
        // its conditions is holding the relaunch.
        detail = state === 'queued' && meta?.sessionConfigError
            ? { kind: 'runner', text: meta.sessionConfigError }
            : { kind: 'wait', reason: refreshWaitReason(input.session) };
    } else {
        active = 'handoff';
        detail = { kind: 'writing' };
    }

    const handoffSource: SwitchStepDetail | undefined = pending ? { kind: pending.source } : undefined;
    const build = (failedAt: SwitchStepKey | null): SwitchStep[] => STEP_ORDER.map((key) => {
        const index = STEP_ORDER.indexOf(key);
        const activeIndex = STEP_ORDER.indexOf(active);
        if (index < activeIndex) return { key, state: 'done', detail: key === 'handoff' ? handoffSource : undefined };
        if (index > activeIndex) return { key, state: 'todo' };
        return { key, state: failedAt === key ? 'failed' : 'active', detail };
    });

    // A reported error is the relaunch failing: the runner that took over
    // reports its own startup, which is the restart step whatever the flavor
    // says by then — unless the briefing is still armed, in which case the
    // old engine never got as far as leaving. Reading the handoff has no
    // error of its own; it can only fail silently, by never happening.
    if (state === 'error') {
        // The login check has its own kind, so it can be drawn on its own step
        // with the command that fixes it; an armed briefing means the old
        // engine never got as far as leaving; anything else is the relaunch.
        const failedAt: SwitchStepKey = meta?.sessionConfigErrorKind === 'auth' ? 'preflight'
            : pending ? (pending.source === 'engine' ? 'turn' : 'handoff') : 'restart';
        active = failedAt;
        detail = failedAt === 'preflight' ? { kind: 'not-logged-in' } : undefined;
        return { ...identity, phase: 'failed', steps: build(failedAt), elapsedMs, error: meta?.sessionConfigError ?? null, afterRestart: false, stillOn };
    }
    const lostBeforeArming = !arrived && !isRefreshPending(state) && !pending && elapsedMs >= ARM_GRACE_MS;
    const lostAfterArrival = arrived && state === 'applied' && sinceUpdate >= READ_GRACE_MS;
    if (lostBeforeArming || lostAfterArrival) {
        return { ...identity, phase: 'failed', steps: build(active), elapsedMs, error: null, afterRestart: arrived, stillOn };
    }
    // Cancellable only while the runner would still take it back: the request
    // is queued, not yet at its boundary, on an Agent that answers the RPC.
    const cancellable = !arrived && state !== 'refreshing' && state !== 'verifying' && meta?.sessionConfigStage !== 'preflight'
        && meta?.sessionCapabilities?.cancelRefresh === true;
    return { ...identity, phase: 'running', steps: build(null), elapsedMs, cancellable };
}

/** The most recent switch request in a transcript, or null. */
export function latestSwitchRequest(messages: Message[]): UserTextMessage | null {
    let latest: UserTextMessage | null = null;
    for (const message of messages) {
        if (message.kind !== 'user-text' || !isEngineSwitchRequest(message.text)) continue;
        if (!latest || message.createdAt > latest.createdAt) latest = message;
    }
    return latest;
}

/**
 * How long the switch that ended at this handoff took, or null when the
 * request that started it is not in the transcript any more.
 */
export function switchDurationEndingAt(messages: Message[], arrivedAt: number): number | null {
    let request: UserTextMessage | null = null;
    for (const message of messages) {
        if (message.kind !== 'user-text' || !isEngineSwitchRequest(message.text) || message.createdAt >= arrivedAt) continue;
        if (!request || message.createdAt > request.createdAt) request = message;
    }
    return request ? arrivedAt - request.createdAt : null;
}
