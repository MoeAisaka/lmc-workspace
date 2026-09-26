import { sessionCapabilities } from './sessionCapabilities';
import { storage } from './storage';
import { apiSocket } from './apiSocket';
import { t } from '@/text';
import { refreshProgress } from './sessionRefreshProgress';
import { machineResumeSession, sessionSetAgentModes } from './ops';
import { resolveMessageModeMeta } from './messageMeta';
import { isSwitchableEngine, mapPermissionMode, type SwitchableEngine } from './engineSwitch';
import { compileHandoff, formatHandoffBriefing } from './engineHandoff';
import { sync } from './sync';
const submitting = new Set<string>();

/** A model chosen alongside an engine, waiting for that engine to be the one running. */
const pendingEngineModel = new Map<string, { engine: SwitchableEngine; modelKey: string }>();

/** The model a switch in progress will apply on arrival, if one was chosen. */
export function peekPendingEngineModel(sessionId: string): { engine: SwitchableEngine; modelKey: string } | null {
    return pendingEngineModel.get(sessionId) ?? null;
}

/**
 * Applies a model that was chosen along with an engine, once the session is
 * actually on that engine. A no-op at every other moment, including the whole
 * stretch between asking for the switch and the relaunch landing.
 */
export function applyPendingEngineModel(sessionId: string, flavor: string | null | undefined): void {
    const pending = pendingEngineModel.get(sessionId);
    if (!pending || pending.engine !== flavor) return;
    pendingEngineModel.delete(sessionId);
    sessionSetAgentModes(sessionId, { modelMode: pending.modelKey, effortLevel: null });
}

/**
 * Ask a session to relaunch its engine at the next idle boundary.
 *
 * The request carries nothing but the ask: both runners keep the model, effort
 * and — for Codex — the context limits they are already running with, so a
 * refresh is a restart rather than a reconfiguration. It used to carry Codex's
 * context window and service tier too, back when those were editable per
 * session; they are set at launch now.
 */
export async function refreshSessionCli(sessionId: string) {
    const session = storage.getState().sessions[sessionId];
    if (!session?.metadata || !sessionCapabilities(session.metadata).refresh) throw new Error(t('localFeatures.legacySessionConfig'));
    if (submitting.has(sessionId) || refreshProgress(session.metadata, Date.now()).pending) return { status: 'queued' };
    submitting.add(sessionId);
    try {
        const result = await apiSocket.sessionRPC<{ status: string }, unknown>(sessionId, 'configure-session', { refreshCli: true });
        if (result.status !== 'queued') throw new Error(t('localFeatures.configRefreshing'));
        return result;
    } finally { submitting.delete(sessionId); }
}

/**
 * Move a running session to the other engine.
 *
 * Rides the safe refresh the session already knows how to do: the request is
 * queued, the current turn and anything waiting behind it finish, and the
 * relaunch comes back as the other engine on a new native thread. The engine
 * being left behind cannot hand over its context — neither engine can read the
 * other's transcript store — so the conversation crosses as text: a briefing,
 * armed here from the transcript and then replaced by the engine's own if it
 * writes one before the relaunch.
 *
 * The permission mode travels mapped here, because this is where a mode is
 * chosen. The current model and effort stay behind — they are named per engine
 * and mean nothing across — but a model picked from the destination's own list
 * travels with the request, so the runner launches the new engine on it and
 * records it for every device.
 */
export async function switchSessionEngine(sessionId: string, engine: SwitchableEngine, modelKey?: string | null, permissionMode?: string | null) {
    const session = storage.getState().sessions[sessionId];
    const current = session?.metadata?.flavor;
    if (!session?.metadata || !isSwitchableEngine(current)) throw new Error(t('localFeatures.legacySessionConfig'));
    if (!sessionCapabilities(session.metadata).refresh) throw new Error(t('localFeatures.legacySessionConfig'));
    if (current === engine) return { status: 'queued' as const };
    if (submitting.has(sessionId) || refreshProgress(session.metadata, Date.now()).pending) return { status: 'queued' as const };
    submitting.add(sessionId);
    try {
        // Armed with the fallback first. Asking the engine for a handoff is a
        // request it may ignore, crash during, or answer badly; arming before
        // asking means every one of those still hands something over.
        const messages = storage.getState().sessionMessages[sessionId]?.messages ?? [];
        const fallbackBriefing = formatHandoffBriefing(compileHandoff(messages), ENGINE_NAMES[current], 'compiled');
        // Asked before the switch is requested, not after.
        //
        // The relaunch waits for an idle boundary, and an idle session has one
        // the moment the request lands: the runner saw an empty queue, exited,
        // and the question — still in flight — was replayed to the engine that
        // had just arrived, which has nothing to hand over. Sending it first,
        // and waiting for the server to take it, puts it in the queue the
        // runner checks before it decides it is idle.
        await sync.sendMessage(sessionId, handoffRequestPrompt(ENGINE_NAMES[engine]), {
            source: 'engine_switch',
            displayText: t('lmc.engineSwitch.requestingHandoff', { engine: ENGINE_NAMES[engine] }),
            awaitDelivery: true,
        });

        const result = await apiSocket.sessionRPC<{ status: string }, unknown>(sessionId, 'configure-session', {
            engine,
            // The mode the composer shows is the one the person believes is in
            // force; metadata alone holds it only once it has been picked here.
            permissionMode: mapPermissionMode(current, engine, permissionMode ?? session.permissionMode ?? session.metadata.permissionMode),
            ...(modelKey ? { model: modelKey } : {}),
            fallbackBriefing,
        });
        if (result.status !== 'queued') throw new Error(t('localFeatures.configRefreshing'));

        // Held, not applied. The relaunch waits for an idle boundary, so the
        // session keeps running on the engine being left for as long as the
        // current turn takes — and the model rides every message's metadata.
        // Setting it now would hand the outgoing engine a model belonging to the
        // other one, starting with the handoff request above — the one turn
        // that must not fail. The request above already carries the pick to a
        // current runner; this copy covers runners that predate that and drop
        // it, and it only lasts while this app stays open.
        if (modelKey) pendingEngineModel.set(sessionId, { engine, modelKey });

        return result;
    } finally { submitting.delete(sessionId); }
}

const ENGINE_NAMES: Record<SwitchableEngine, string> = { claude: 'Claude Code', codex: 'Codex' };

/**
 * What the engine being left is asked for.
 *
 * Written at the engine rather than at the user: it names the tool, says who
 * the reader will be, and rules out doing anything else this turn — an engine
 * that treats the request as a new instruction would carry on working right up
 * to the moment it is replaced.
 */
function handoffRequestPrompt(target: string): string {
    return [
        '[engine switch requested]',
        `Your user is moving this session to ${target}. Before that happens, write a handoff by calling the submit_handoff tool.`,
        'The engine taking over has none of your memory and cannot see this conversation. Tell it what it needs in order to continue — the goal, what is done, which files and why, what you tried that did not work, and the specific next action. Not a summary of what you did.',
        'Call submit_handoff and stop. Do not start new work in this turn.',
    ].join('\n');
}

/**
 * Call a queued switch off.
 *
 * Only the runner can do it, and only while the request is still a request:
 * once it has started leaving, the cursor is mid-handover and the daemon may
 * hold a reservation, and the runner says so. The caller shows that answer
 * rather than pretending.
 */
export async function cancelSessionSwitch(sessionId: string): Promise<'cancelled' | 'too-late' | 'nothing-pending'> {
    const session = storage.getState().sessions[sessionId];
    if (!session?.metadata || !sessionCapabilities(session.metadata).cancelRefresh) throw new Error(t('lmc.engineSwitch.cancelUnsupported'));
    const result = await apiSocket.sessionRPC<{ status: string }, Record<string, never>>(sessionId, 'cancel-session-refresh', {});
    if (result.status === 'cancelled' || result.status === 'too-late' || result.status === 'nothing-pending') {
        if (result.status === 'cancelled') pendingEngineModel.delete(sessionId);
        return result.status;
    }
    throw new Error(t('lmc.engineSwitch.cancelFailed'));
}

/** The same RPC, for a refresh that is not a switch. */
export const cancelSessionRefresh = cancelSessionSwitch;

export async function retrySessionRefresh(sessionId: string) {
    const state = storage.getState();
    const session = state.sessions[sessionId];
    if (!session) throw new Error(t('localFeatures.configFailed'));
    if (session.active) return refreshSessionCli(sessionId);

    const machineId = session.metadata?.machineId;
    if (!machineId) throw new Error(t('sessionInfo.resumeSessionMissingMachine'));
    const mode = resolveMessageModeMeta(session, state.settings, state.machines[session.metadata?.machineId ?? '']?.metadata);
    const result = await machineResumeSession({
        machineId,
        sessionId,
        model: mode.model ?? undefined,
        permissionMode: mode.permissionMode,
    });
    if (result.type === 'error') throw new Error(result.errorMessage);
    if (result.type === 'requestToApproveDirectoryCreation') {
        throw new Error(t('sessionInfo.resumeSessionUnexpectedDirectoryPrompt'));
    }
    return result;
}
