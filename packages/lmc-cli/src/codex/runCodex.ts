import { cachedDefaultEffort } from '@/runtime/modelCatalogCache';
import { codexUsageLimits } from './usageLimits';
import { engineCapabilities } from '@/runtime/managedRuntime';
import { registerEngineAuth, isEngineAuthError } from '@/utils/engineAuth';
import { reportSessionRefreshFailure } from './reportSessionRefreshFailure';
import { UNKNOWN_RECONNECT_REVISION, refreshSessionRuntimeMetadata } from '@/utils/sessionRuntimeMetadata';
import { SessionRefreshQueue } from './sessionRefresh';
import { checkEngineAuth } from '@/utils/engineAuth';
import { EngineAuthPreflightError, refreshErrorKind, tagRefreshError } from '@/utils/refreshErrors';
import { isPendingState } from '@/utils/refreshState';
import { prepareDaemonSessionRefresh } from '@/daemon/controlClient';
import { readFallbackBriefing, readSwitchEngine } from '@/utils/engineSwitchRequest';
import { applyQueueModeRequest, registerQueueControlHandlers } from '@/utils/sessionQueueControl';
import { validateCodexServiceTier, type CodexServiceTier } from '@/codex/serviceTier';
import { validateCodexContextLimits, type CodexContextLimits } from './contextLimits';
import { render } from "ink";
import React from "react";
import { ApiClient } from '@/api/api';
import { CodexAppServerClient } from './codexAppServerClient';
import type { ReasoningEffort } from './codexAppServerTypes';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { configuration } from '@/configuration';
import { AutomaticGoalPolicy, automaticGoalStatePath } from '@/utils/automaticGoal';
import { AsyncLock } from '@/utils/lock';
import { createCodexAutomaticGoal } from './codexAutomaticGoal';
import packageJson from '../../package.json';
import { MessageQueue2, type PendingAttachment } from '@/utils/MessageQueue2';
import { attachQueuePublisher } from '@/utils/sessionQueueControl';
import { readMessageIntent } from '@/utils/queueControlRequest';
import { projectPath } from '@/projectPath';
import { join } from 'node:path';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { CodexDisplay } from "@/ui/ink/CodexDisplay";
import { trimIdent } from "@/utils/trimIdent";
import { notifyDaemonSessionStarted } from "@/daemon/controlClient";
import { encodeBase64, decodeBase64 } from '@/api/encryption';
import type { Session as ApiSession, UserMessage } from '@/api/types';
import { registerKillSessionHandler } from "@/claude/registerKillSessionHandler";
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import type { PermissionMode } from '@/api/types';
import type { ApiSessionClient } from '@/api/apiSession';
import { resolveCodexExecutionPolicy, resolveCodexApprovalDecision } from './executionPolicy';
import {
    mapCodexMcpMessageToSessionEnvelopes,
    mapCodexProcessorMessageToSessionEnvelopes,
} from './utils/sessionProtocolMapper';
import { resumeExistingThread } from './resumeExistingThread';
import { emitReadyIfIdle } from './emitReadyIfIdle';
import { enqueueCodexUserText, isCodexClearText } from './codexClearCommand';
import { downloadCodexFileEventAttachment } from './utils/attachmentEvents';
import { prepareCodexImageInputItems } from './utils/imageInput';
import { steerCodexPrompt } from './steerPrompt';
import { createSerialAsyncHandler } from './utils/serialAsyncHandler';
import { buildCodexThreadBackfillEnvelopes } from './utils/threadImageBackfill';
import { threadHasLmcSystemBlock } from './utils/threadHasLmcSystem';
import {
    buildCodexTurnPrompt,
    hashCodexEnhancedMode,
    type CodexEnhancedMode,
} from './codexPrompt';
import { discoverCodexSkillCommands } from './codexSkills';
import { CodexRemoteModeState } from './remoteModeState';
import { assertCodexModelEffort, UnsupportedCodexEffortError } from './modelEffort';
import { saveAttachmentsToInbox, formatInboxNote } from '@/modules/common/attachmentInbox';
import {
    codexGoalActionCapabilities,
    mapCodexGoalEventToAgentGoalStatus,
    parseCodexGoalActionParams,
    parseCodexGoalCommand,
    type CodexGoalCommand,
} from './codexGoalStatus';
import { startAgentMail } from '@/modules/agentMail/agentMailLoop';
import { watchSessionConfiguration } from '@/modules/orchestration/workerConfig';
import { consumePendingHandoff, createHandoffPort } from '@/utils/handoffPort';
import { createQuotaReporter } from '@/modules/orchestration/quota';
import { codexTurnUsage, createTaskMeter } from '@/modules/orchestration/meter';
import { hubCodexPermissionMode, hubCodexApprovalDenied, isHub, HUB_CODEX_DENIAL, hubCodexMcpTools } from '@/modules/orchestration/hubGuard';
import { resolveWorkerPermissionMode } from '@/modules/orchestration/workerPermission';

/**
 * Extracts a human-readable error from a codex task_complete/turn_aborted event.
 * Returns null if the event represents a successful/clean completion.
 */
function describeCodexFailure(msg: any): string | null {
    const hasFailure = msg?.status === 'failed' || (msg?.error !== undefined && msg?.error !== null);
    if (!hasFailure) return null;
    const err = msg.error;
    if (typeof err === 'string' && err.length > 0) return err;
    if (err && typeof err === 'object' && typeof err.message === 'string' && err.message.length > 0) {
        return err.message;
    }
    return 'Unknown error';
}

function hasCodexSubagentReference(message: Record<string, unknown>): boolean {
    for (const key of ['subagent', 'parent_call_id', 'parentCallId', 'agent_thread_id', 'agentThreadId']) {
        const value = message[key];
        if (typeof value === 'string' && value.length > 0) {
            return true;
        }
    }
    return false;
}

// What a Codex session launches on when neither the CLI flags nor the app sent
// a model. Exported so the pairing with the effort below stays testable without
// starting a session.
export const DEFAULT_CODEX_MODEL = 'gpt-6-astra';
export const DEFAULT_CODEX_EFFORT: ReasoningEffort = 'medium';
// Codex's app-server protocol requires a concrete approval policy and sandbox
// on every turn, so unlike Claude there is no "send nothing" here. This is the
// closest honest equivalent: `auto` is Codex's own shipped default preset
// (on-request approvals inside the workspace sandbox), so leaving the picker on
// Default lands where plain `codex` would. It used to be 'yolo', which quietly
// gave full access to anyone who never touched the picker.
const DEFAULT_CODEX_PERMISSION_MODE: PermissionMode = 'auto';

/**
 * Main entry point for the codex command with ink UI
 */
export async function runCodex(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    noSandbox?: boolean;
    resumeThreadId?: string;
    permissionMode?: PermissionMode;
    model?: string;
    effort?: ReasoningEffort;
    codexServiceTier?: CodexServiceTier; codexContextLimits?: CodexContextLimits;
}): Promise<'stopped' | 'refresh-handoff'> {
    let serviceTier = validateCodexServiceTier(opts.codexServiceTier);
    let contextLimits = validateCodexContextLimits(opts.codexContextLimits);
    const initialEffort = opts.effort ?? cachedDefaultEffort('codex', opts.model ?? DEFAULT_CODEX_MODEL, DEFAULT_CODEX_EFFORT) as ReasoningEffort | undefined;
    assertCodexModelEffort(opts.model ?? DEFAULT_CODEX_MODEL, initialEffort);

    // Early check: ensure Codex CLI is installed before proceeding
    try {
        execSync('codex --version', { encoding: 'utf8', stdio: 'pipe', windowsHide: true });
    } catch {
        console.error('\n\x1b[1m\x1b[33mCodex CLI is not installed\x1b[0m\n');
        console.error('Please install Codex CLI using one of these methods:\n');
        console.error('\x1b[1mOption 1 - npm (recommended):\x1b[0m');
        console.error('  \x1b[36mnpm install -g @openai/codex\x1b[0m\n');
        console.error('\x1b[1mOption 2 - Homebrew (macOS):\x1b[0m');
        console.error('  \x1b[36mbrew install --cask codex\x1b[0m\n');
        console.error('Alternatively, use Claude Code:');
        console.error('  \x1b[36mhappy claude\x1b[0m\n');
        process.exit(1);
    }

    type EnhancedMode = CodexEnhancedMode;

    //
    // Define session
    //

    const sessionTag = randomUUID();

    // Set backend for offline warnings (before any API calls)
    connectionState.setBackend('Codex');

    const api = await ApiClient.create(opts.credentials);

    // Log startup options
    logger.debug(`[codex] Starting with options: startedBy=${opts.startedBy || 'terminal'}`);

    //
    // Machine
    //

    const settings = await readSettings();
    let machineId = settings?.machineId;
    const sandboxConfig = opts.noSandbox ? undefined : settings?.sandboxConfig;
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/happy-cli/issues`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);
    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    //
    // Create session
    //

    const initialPermissionMode = opts.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE;
    // Lineage from the daemon's spawn RPC (set by app-side fork / duplicate).
    const forkedFromSessionId = process.env.HAPPY_FORKED_FROM_SESSION_ID;
    const forkedFromMessageId = process.env.HAPPY_FORKED_FROM_MESSAGE_ID;
    const isSideChat = process.env.HAPPY_SIDE_CHAT === '1';

    const { state, metadata } = createSessionMetadata({
        flavor: 'codex',
        machineId,
        startedBy: opts.startedBy,
        sandbox: sandboxConfig,
        dangerouslySkipPermissions: initialPermissionMode === 'yolo' || initialPermissionMode === 'bypassPermissions',
        ...(forkedFromSessionId ? { parentSessionId: forkedFromSessionId } : {}),
        ...(forkedFromMessageId ? { forkedFromMessageId } : {}),
        ...(isSideChat ? { isSideChat: true } : {}),
    });

    metadata.sessionConfiguration = true;
    metadata.modelMode = opts.model ?? DEFAULT_CODEX_MODEL;
    metadata.effortLevel = initialEffort;
    metadata.permissionMode = initialPermissionMode;
    metadata.permissionModeSource = opts.permissionMode ? 'explicit' : 'ambient';
    metadata.sessionCapabilities = engineCapabilities('codex');
    metadata.sessionConfigState = process.env.HAPPY_REFRESH_RECEIVE_SEQ !== undefined ? 'verifying' : 'applied';
    metadata.sessionConfigError = undefined;
    metadata.codexServiceTier = serviceTier;
    metadata.codexContextLimits = contextLimits;

    const skillCommands = await discoverCodexSkillCommands();
    if (skillCommands.length > 0) {
        metadata.skills = skillCommands;
        metadata.slashCommands = Array.from(new Set([...(metadata.slashCommands ?? []), ...skillCommands]));
    }

    // Check for session reconnection env vars (set by daemon for resume-in-place)
    const reconnectSessionId = process.env.HAPPY_RECONNECT_SESSION_ID;
    const reconnectKeyBase64 = process.env.HAPPY_RECONNECT_ENCRYPTION_KEY;
    const reconnectVariant = process.env.HAPPY_RECONNECT_ENCRYPTION_VARIANT as 'legacy' | 'dataKey' | undefined;
    const reconnectSeq = process.env.HAPPY_RECONNECT_SEQ;

    let response: ApiSession | null;
    if (reconnectSessionId && reconnectKeyBase64 && reconnectVariant) {
        logger.debug(`[START] Reconnecting to existing session ${reconnectSessionId}`);
        response = {
            id: reconnectSessionId,
            seq: parseInt(reconnectSeq || '0', 10),
            encryptionKey: decodeBase64(reconnectKeyBase64),
            encryptionVariant: reconnectVariant,
            metadata,
            metadataVersion: UNKNOWN_RECONNECT_REVISION,
            agentState: state,
            agentStateVersion: UNKNOWN_RECONNECT_REVISION,
        };
    } else {
        response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    }

    // Handle server unreachable case - create offline stub with hot reconnection
    let session: ApiSessionClient;
    let checkAuthentication: ReturnType<typeof registerEngineAuth>;
    // Permission handler declared here so it can be updated in onSessionSwap callback
    // (assigned later at line ~385 after client setup)
    let permissionHandler: CodexPermissionHandler;
    let stopWatchingConfiguration: (() => void) | undefined;
    let attachConfiguration: ((nextSession: ApiSessionClient) => void) | undefined;
    let client!: CodexAppServerClient;
    let reasoningProcessor!: ReasoningProcessor;
    let abortInProgress: Promise<void> | null = null;
    const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
        api,
        sessionTag,
        metadata,
        state,
        response,
        onSessionSwap: (newSession) => {
            session = newSession;
            attachConfiguration?.(newSession);
            checkAuthentication = registerEngineAuth(newSession, 'codex', process.cwd());
            void checkAuthentication().catch(() => logger.warn('[Codex] Authentication status unavailable'));
            // Offline stubs do not transfer runtime RPC registrations on reconnect.
            void newSession.updateMetadata(m => ({ ...m, sessionCapabilities: { ...engineCapabilities('codex'), refresh: false, runtimeConfiguration: false } }));
            // Update permission handler with new session to avoid stale reference
            if (permissionHandler) {
                permissionHandler.updateSession(newSession);
            }
        }
    });
    session = initialSession;
    checkAuthentication = registerEngineAuth(session, 'codex', process.cwd());
    void checkAuthentication().catch(() => logger.warn('[Codex] Authentication status unavailable'));

    // On reconnect, un-archive the session and skip replaying old messages.
    if (reconnectSessionId) {
        session.suppressNextArchiveSignal();
        const refreshCursor = process.env.HAPPY_REFRESH_RECEIVE_SEQ;
        if (refreshCursor !== undefined) session.resumeIncomingMessagesFrom(Number(refreshCursor));
        else session.skipExistingMessages();
        session.updateMetadata((meta) => ({
            ...refreshSessionRuntimeMetadata(meta, metadata),
            sessionCapabilities: metadata.sessionCapabilities,
            sessionConfiguration: true, sessionConfigState: refreshCursor !== undefined ? 'verifying' : 'applied', sessionConfigError: undefined,
            ...(refreshCursor !== undefined ? { sessionConfigUpdatedAt: Date.now() } : {}),
            codexContextLimits: contextLimits, codexServiceTier: serviceTier,
            lifecycleState: 'running',
            archivedBy: undefined,
        }));
    }

    // Always report to daemon if it exists (skip if offline)
    if (response) {
        try {
            logger.debug(`[START] Reporting session ${response.id} to daemon`);
            const result = await notifyDaemonSessionStarted(response.id, metadata, {
                encryptionKey: encodeBase64(response.encryptionKey),
                encryptionVariant: response.encryptionVariant,
                seq: response.seq,
                metadataVersion: response.metadataVersion,
                agentStateVersion: response.agentStateVersion,
            });
            if (result.error) {
                logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
            } else {
                logger.debug(`[START] Reported session ${response.id} to daemon`);
            }
        } catch (error) {
            logger.debug('[START] Failed to report to daemon (may not be running):', error);
        }
    }

    const messageQueue = new MessageQueue2<EnhancedMode>(hashCodexEnhancedMode);
    // The app sees the queue through agentState; the consumption mode survives
    // relaunches through metadata.
    attachQueuePublisher(messageQueue, session, session.getMetadata()?.queueMode);
    let activeTurnModeHash: string | null = null;
    let activeTurnIsHub = false;

    session.onFileEvent((fileEvent) => {
        const ev = fileEvent.content.data.ev;
        logger.debug('[Codex] File event received', {
            size: ev.size,
            hasMimeType: Boolean(ev.mimeType),
        });
        session.trackAttachmentDownload(downloadCodexFileEventAttachment(session, fileEvent));
    });

    // Track current overrides to apply per message
    // Use shared PermissionMode type from api/types for cross-agent compatibility
    const remoteModeState = new CodexRemoteModeState({
        permissionMode: initialPermissionMode,
        model: opts.model ?? DEFAULT_CODEX_MODEL,
        effort: initialEffort,
    });
    attachConfiguration = nextSession => {
        stopWatchingConfiguration?.();
        stopWatchingConfiguration = watchSessionConfiguration(nextSession, 'codex', metadata => {
            remoteModeState.resolve({
                ...(metadata.permissionMode ? { permissionMode: metadata.permissionMode } : {}),
                ...(metadata.modelMode !== undefined ? { model: metadata.modelMode } : {}),
                ...(metadata.effortLevel !== undefined ? { effort: metadata.effortLevel as ReasoningEffort } : {}),
            });
            permissionHandler?.onPolicyChange(remoteModeState.currentPermissionMode, hubCodexApprovalDenied(session.getMetadata(), activeTurnIsHub));
        });
    };
    attachConfiguration(session);
    let currentAppendSystemPrompt: string | undefined = undefined;

    const resetCurrentModeDefaults = () => {
        // Reset permission mode and prompts to what the session was launched
        // with. Note this is NOT
        // a safety guarantee by itself — for plain `lmc codex` the launch
        // mode IS yolo; the post-abort grace window is protected by the
        // approval handler only trusting explicitly-picked modes.
        // Model and effort deliberately remain sticky. Current apps also
        // reassert all three visible values on the next message.
        remoteModeState.resetAfterAbort();
        currentAppendSystemPrompt = undefined;
        logger.debug('[Codex] Reset current mode defaults after abort');
    };

    const handleUserMessage = createSerialAsyncHandler<UserMessage>(async (message) => {
        const metadata = session.getMetadata();
        const workerMode = metadata?.orchestration?.role === 'worker' ? resolveWorkerPermissionMode(metadata, 'codex') : undefined;
        const modeResolution = remoteModeState.resolve({ ...message.meta, ...(!message.meta?.permissionMode && workerMode ? { permissionMode: workerMode } : {}) });
        permissionHandler?.onPolicyChange(modeResolution.permissionMode, hubCodexApprovalDenied(session.getMetadata(), activeTurnIsHub));
        const attachmentsForThisMessage = await session.drainAttachmentsForUserMessage();
        if (modeResolution.permission.kind === 'updated') {
            logger.debug(`[Codex] Permission mode updated from user message to: ${modeResolution.permissionMode}`);
        } else if (modeResolution.permission.kind === 'ignored') {
            logger.debug(`[Codex] Ignoring invalid permission mode from user message: ${String(modeResolution.permission.incoming)}`);
        } else {
            logger.debug(`[Codex] User message received with no permission mode override, using current: ${modeResolution.permissionMode}`);
        }
        if (modeResolution.modelResolution.kind === 'updated') {
            logger.debug(`[Codex] Model updated from user message: ${modeResolution.model || 'reset to default'}`);
        } else {
            logger.debug(`[Codex] User message received with no model override, using current: ${modeResolution.model || 'default'}`);
        }
        if (modeResolution.effortResolution.kind === 'updated') {
            logger.debug(modeResolution.effort
                ? `[Codex] Effort updated from user message: ${modeResolution.effort}`
                : '[Codex] Effort reset to default');
        } else if (modeResolution.effortResolution.kind === 'ignored') {
            logger.debug(`[Codex] Ignoring invalid effort from user message: ${String(modeResolution.effortResolution.incoming)}`);
        } else {
            logger.debug(`[Codex] User message received with no effort override, using current: ${modeResolution.effort ?? 'default'}`);
        }

        let messageAppendSystemPrompt = currentAppendSystemPrompt;
        if (message.meta?.hasOwnProperty('appendSystemPrompt')) {
            messageAppendSystemPrompt = message.meta.appendSystemPrompt || undefined;
            currentAppendSystemPrompt = messageAppendSystemPrompt;
            logger.debug(`[Codex] Append system prompt updated from user message: ${messageAppendSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[Codex] User message received with no append system prompt override, using current: ${currentAppendSystemPrompt ? 'set' : 'none'}`);
        }

        const enhancedMode: EnhancedMode = {
            permissionMode: modeResolution.permissionMode,
            model: modeResolution.model,
            appendSystemPrompt: messageAppendSystemPrompt,
            effort: modeResolution.effort,
        };
        const intent = readMessageIntent(message.meta);
        const queueKey = message.localKey;
        const turnRunning = activeTurnModeHash !== null || thinking;
        if (intent === 'interrupt') {
            // Goes next: head of the queue, and the running turn is stopped.
            // An idle engine just picks it up. The queue survives the abort.
            messageQueue.unshift(message.content.text, enhancedMode, attachmentsForThisMessage, { key: queueKey });
            if (turnRunning) {
                session.sendSessionEvent({ type: 'message', message: '已打断当前回合，接下来处理这条。' });
                await handleAbort();
            }
            return;
        }
        // Steering belongs to the running turn only when nothing about it
        // changes: same settings, not a command, nothing
        // already waiting ahead. Apps that predate `intent` send none and get
        // the old behaviour (steer when possible); an explicit 'queue' never
        // steers, and an explicit 'steer' that cannot be honoured says why.
        const steerEligible = activeTurnModeHash === hashCodexEnhancedMode(enhancedMode, 'steer')
            // A role change needs a new guarded turn, not a steer into the
            // existing turn's old sandbox policy.
            && activeTurnIsHub === isHub(session.getMetadata())
            && messageQueue.size() === 0
            && (attachmentsForThisMessage.length === 0 || intent === 'steer')
            && (message.content.text.trim().length > 0 || attachmentsForThisMessage.length > 0)
            && !message.content.text.trimStart().startsWith('/');
        if ((intent === 'steer' || intent === undefined) && steerEligible) {
            try {
                if ((await steerCodexPrompt(client, message.content.text, attachmentsForThisMessage, {
                    sessionId: session.sessionId,
                    canSteer: () => activeTurnModeHash === hashCodexEnhancedMode(enhancedMode, 'steer') && activeTurnIsHub === isHub(session.getMetadata()),
                })).steered) {
                    if (client.hasPendingTurnCompletion()) {
                        thinking = true;
                        session.keepAlive(true, 'remote');
                    }
                    session.sendSessionEvent({ type: 'message', message: 'Codex 已接收补充回复，将在当前工作中处理。' });
                    return;
                }
            } catch {
                // A lost response is not evidence of failed delivery. Never
                // silently enqueue the same potentially accepted reply again.
                session.sendSessionEvent({ type: 'message', message: '补充回复尚未确认送达 Codex；未自动重复发送，请检查连接和后续回应。' });
                return;
            }
        }
        const enqueueResult = enqueueCodexUserText({
            text: message.content.text,
            mode: enhancedMode,
            queue: messageQueue,
            attachments: attachmentsForThisMessage,
            key: queueKey,
        });
        if (intent === 'steer' && turnRunning && enqueueResult === 'queued') {
            session.sendSessionEvent({ type: 'message', message: '这条暂时无法补充进当前回合（设置变化、附件未能读取、命令或前面还有排队消息），仍在队列中等本轮结束。' });
        } else if (intent === undefined && activeTurnModeHash !== null && enqueueResult === 'queued') {
            // Older apps have no queue strip; the transcript is their only notice.
            session.sendSessionEvent({ type: 'message', message: '回复已排队，将在当前轮次结束后发送（含附件、命令或配置变化的消息不插入当前轮次）。' });
        }
        if (enqueueResult === 'clear') {
            logger.debug('[Codex] /clear command pushed to isolated queue');
        }
    }, (error, message) => {
        if (message.meta?.queueKey) session.sendSessionEvent({ type: 'queue-released', keys: [message.meta.queueKey] });
        if (error instanceof UnsupportedCodexEffortError) {
            session.sendSessionEvent({ type: 'message', message: error.message });
            return;
        }
        logger.warn('[Codex] Failed to handle user message', {
            errorName: error instanceof Error ? error.name : typeof error,
        });
        if (message.meta?.queueKey) session.sendSessionEvent({ type: 'message', message: '消息未能排入队列，请重试。' });
    });
    session.onUserMessage(handleUserMessage);
    let thinking = false;
    let currentTurnId: string | null = null;
    let codexStartedSubagents = new Set<string>();
    let codexActiveSubagents = new Set<string>();
    let codexProviderSubagentToSessionSubagent = new Map<string, string>();
    let codexSubagentTitles = new Map<string, string>();
    let codexCollabReceiverThreadIdsByCall = new Map<string, string[]>();
    let codexCollabToolByCall = new Map<string, string>();
    let activeTurnPermissionMode: PermissionMode | undefined = undefined;
    let hubDenialSent = false;
    session.keepAlive(thinking, 'remote');
    // Periodic keep-alive; store handle so we can clear on exit
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(thinking, 'remote');
    }, 2000);

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
        try {
            api.push().sendSessionNotification({
                kind: 'done',
                metadata: session.getMetadata(),
                data: {
                    sessionId: session.sessionId,
                    type: 'ready',
                    provider: 'codex',
                }
            });
        } catch (pushError) {
            logger.debug('[Codex] Failed to send ready push', pushError);
        }
    };

    // Debug helper: log active handles/requests if DEBUG is enabled
    function logActiveHandles(tag: string) {
        if (!process.env.DEBUG) return;
        const anyProc: any = process as any;
        const handles = typeof anyProc._getActiveHandles === 'function' ? anyProc._getActiveHandles() : [];
        const requests = typeof anyProc._getActiveRequests === 'function' ? anyProc._getActiveRequests() : [];
        logger.debug(`[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`);
        try {
            const kinds = handles.map((h: any) => (h && h.constructor ? h.constructor.name : typeof h));
            logger.debug(`[codex][handles] kinds=${JSON.stringify(kinds)}`);
        } catch { }
    }

    //
    // Abort handling
    // IMPORTANT: There are two different operations:
    // 1. Abort (handleAbort): Stops the current inference/task but keeps the session alive
    //    - Used by the 'abort' RPC from mobile app
    //    - Similar to Claude Code's abort behavior
    //    - Allows continuing with new prompts after aborting
    // 2. Kill (handleKillSession): Terminates the entire process
    //    - Used by the 'killSession' RPC
    //    - Completely exits the CLI process
    //

    // AbortController is used ONLY to wake messageQueue.waitForMessages when idle.
    // Turn cancellation uses client.interruptTurn() — no AbortController hack needed.
    let abortController = new AbortController();
    let shouldExit = false;
    const configurationQueue = new SessionRefreshQueue();
    let configurationBlocked = false;
    let refreshHandoff = false;
    // Held between the request and the boundary the relaunch waits for.
    let switchTarget: 'claude' | 'codex' | undefined;
    let switchPermissionMode: string | undefined;
    // What a queued refresh is waiting on, as this runner sees it. Published
    // into the metadata so the daemon can tell a busy session from a wedged
    // one — a queued refresh with no stated reason is counted against the
    // session, and blocked after a few re-asks — and so the app's refresh card
    // can say what it is waiting for rather than guess.
    let publishedWait: string | null | undefined;
    const publishRefreshWait = () => {
        if (!configurationQueue.hasPendingRefresh || refreshHandoff) { publishedWait = undefined; return; }
        const reason = thinking ? '等当前回合结束' : messageQueue.size() > 0 ? `等 ${messageQueue.size()} 条排队消息` : null;
        if (publishedWait !== undefined && publishedWait === reason) return;
        publishedWait = reason;
        session.updateMetadata(m => m.sessionConfigState === 'queued' ? { ...m, sessionConfigError: reason ?? undefined } : m);
    };
    session.rpcHandlerManager.registerHandler('configure-session', async (params: any) => {
        // Consumption mode only; no relaunch involved, so it applies at once.
        if (applyQueueModeRequest(params, messageQueue, session)) return { status: 'applied' };
        if (refreshHandoff) return { status: 'refreshing' };
        // A switch rides the refresh queue: same wait for a real boundary, but
        // the relaunch comes back as the other engine.
        const switchEngine = readSwitchEngine(params);
        if (switchEngine && switchEngine !== 'codex') {
            switchTarget = switchEngine;
            switchPermissionMode = typeof params?.permissionMode === 'string' ? params.permissionMode : undefined;
            // Armed with the fallback up front, so a refusal or a crash still
            // hands something over and no timer has to decide when to give up.
            handoffPort.arm(readFallbackBriefing(params), switchEngine);
            params = { refreshCli: true };
        }
        if (params?.refreshCli === true && configurationQueue.hasPendingRefresh && !configurationBlocked) return { status: 'queued' };
        configurationQueue.request(params?.contextLimits ?? contextLimits,
            params && Object.prototype.hasOwnProperty.call(params, 'serviceTier') ? (params.serviceTier ?? undefined) : serviceTier,
            params?.refreshCli === true);
        configurationBlocked = false;
        session.updateMetadata(m => ({ ...m, sessionConfigState: 'queued', sessionConfigError: undefined, sessionConfigErrorKind: undefined, sessionConfigUpdatedAt: Date.now(),
            sessionConfigRequestedAt: isPendingState(m.sessionConfigState) ? m.sessionConfigRequestedAt : Date.now() }));
        publishedWait = undefined;
        publishRefreshWait();
        if (!thinking) { abortController.abort(); abortController = new AbortController(); }
        return { status: 'queued' };
    });


    /**
     * Handles aborting the current task/inference without exiting the process.
     * This is the equivalent of Claude Code's abort - it stops what's currently
     * happening but keeps the session alive for new prompts.
     */
    async function handleAbort() {
        if (abortInProgress) {
            await abortInProgress;
            return;
        }

        logger.debug('[Codex] Abort requested - stopping current task');
        abortInProgress = (async () => {
            try {
                // Resolve any pending permission requests as 'abort' first.
                if (permissionHandler) {
                    permissionHandler.abortAll();
                }

                // Request interruption, then force-restart Codex app-server if
                // it doesn't settle quickly (long-running shell commands).
                if (client) {
                    const abortResult = await client.abortTurnWithFallback({
                        gracePeriodMs: 3000,
                        forceRestartOnTimeout: true,
                    });
                    if (abortResult.forcedRestart) {
                        logger.warn('[Codex] Forced app-server restart after interrupt timeout');
                        session.sendSessionEvent({
                            type: 'message',
                            message: abortResult.resumedThread
                                ? '已停止当前回合并恢复原 Codex 会话，接下来处理排队消息。'
                                : '当前回合已停止，原 Codex 会话尚未恢复。会话标识和排队消息已保留，正在重试恢复。',
                        });
                    }
                }

                if (reasoningProcessor) {
                    reasoningProcessor.abort();
                }
                logger.debug('[Codex] Abort completed - session remains active');
            } catch (error) {
                logger.debug('[Codex] Error during abort:', error);
            } finally {
                resetCurrentModeDefaults();
                // Wake up message queue wait if idle
                abortController.abort();
                abortController = new AbortController();
            }
        })();

        await abortInProgress;
        abortInProgress = null;
    }

    /**
     * Handles session termination and process exit.
     * This is called when the session needs to be completely killed (not just aborted).
     * Abort stops the current inference but keeps the session alive.
     * Kill terminates the entire process.
     */
    const handleKillSession = async () => {
        logger.debug('[Codex] Kill session requested - terminating process');
        await handleAbort();
        logger.debug('[Codex] Abort completed, proceeding with termination');

        try {
            // Update lifecycle state to archived before closing
            if (session) {
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: 'User terminated'
                }));
                
                // Send session death message
                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }

            // Force close Codex transport (best-effort) so we don't leave stray processes
            try {
                await client.disconnect();
            } catch (e) {
                logger.debug('[Codex] Error disconnecting Codex during termination', e);
            }

            // Stop Happy MCP server
            happyServer.stop();
            agentMail.stop();
            stopWatchingConfiguration?.();

            logger.debug('[Codex] Session termination complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[Codex] Error during session termination:', error);
            process.exit(1);
        }
    };

    // Register abort handler
    session.rpcHandlerManager.registerHandler('abort', handleAbort);
    // The queue strip's withdraw / go-next buttons.
    registerQueueControlHandlers(session, messageQueue, {
        isBusy: () => thinking || activeTurnModeHash !== null,
        interrupt: handleAbort,
        // Same conditions the send path checks before steering: the running
        // turn must still be the one this prompt was written against, and the
        // prompt may include supported images. Each refusal names itself so the app can
        // say which condition failed rather than "not possible".
        steer: async (item) => {
            if (activeTurnModeHash === null) return { steered: false, reason: 'idle' };
            if (activeTurnModeHash !== hashCodexEnhancedMode(item.mode, 'steer')) return { steered: false, reason: 'settings' };
            // A role change needs a new guarded turn, not a steer into the
            // existing turn's old sandbox policy.
            if (activeTurnIsHub !== isHub(session.getMetadata())) return { steered: false, reason: 'settings' };
            if (item.isolate || item.message.trimStart().startsWith('/')) return { steered: false, reason: 'command' };
            try {
                const outcome = await steerCodexPrompt(client, item.message, item.attachments, {
                    sessionId: session.sessionId,
                    canSteer: () => activeTurnModeHash === hashCodexEnhancedMode(item.mode, 'steer') && activeTurnIsHub === isHub(session.getMetadata()),
                });
                if (!outcome.steered) return outcome;
            } catch {
                // A lost response is not evidence of failed delivery. Never
                // put it back where it would be sent a second time.
                session.sendSessionEvent({ type: 'message', message: '补充回复尚未确认送达 Codex；未自动重复发送，请检查连接和后续回应。' });
                return { steered: false, reason: 'unconfirmed', restore: false };
            }
            if (client.hasPendingTurnCompletion()) {
                thinking = true;
                session.keepAlive(true, 'remote');
            }
            session.sendSessionEvent({ type: 'message', message: 'Codex 已接收补充回复，将在当前工作中处理。' });
            return { steered: true };
        },
    });

    registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

    //
    // Initialize Ink UI
    //

    const messageBuffer = new MessageBuffer();
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(CodexDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
            onExit: async () => {
                // Exit the agent
                logger.debug('[codex]: Exiting agent via Ctrl-C');
                shouldExit = true;
                await handleAbort();
            }
        }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding("utf8");
    }

    //
    // Start Context 
    //

    client = new CodexAppServerClient(sandboxConfig, contextLimits, serviceTier);

    permissionHandler = new CodexPermissionHandler(session);
    // Drop any permission requests left in agent state from a previous CLI
    // process that died while a tool prompt was open — see the matching
    // call in claudeRemoteLauncher for the full rationale.
    permissionHandler.reset('Previous CLI process exited before responding');
    reasoningProcessor = new ReasoningProcessor((message) => {
        const envelopes = mapCodexProcessorMessageToSessionEnvelopes(message, { currentTurnId });
        for (const envelope of envelopes) {
            session.sendSessionProtocolMessage(envelope);
        }
    });
    const diffProcessor = new DiffProcessor((message) => {
        const envelopes = mapCodexProcessorMessageToSessionEnvelopes(message, { currentTurnId });
        for (const envelope of envelopes) {
            session.sendSessionProtocolMessage(envelope);
        }
    });
    const updateCodexGoalState = (message: Record<string, unknown>) => {
        const capabilities = codexGoalActionCapabilities(client.supportsGoalActions());
        const goalStatus = mapCodexGoalEventToAgentGoalStatus(
            message,
            client.threadId,
            capabilities ? { capabilities } : undefined,
        );
        if (!goalStatus) {
            return;
        }
        session.updateAgentState((currentState) => ({
            ...currentState,
            agentGoalStatus: goalStatus,
        }));
    };
    const goalLock = new AsyncLock();
    const automaticGoals = new AutomaticGoalPolicy(automaticGoalStatePath(configuration.lmcHomeDir, session.sessionId));
    const handleCodexGoalCommand = async (
        command: CodexGoalCommand,
        threadId: string,
    ): Promise<boolean> => {
        try {
            if (command.type === 'clear') {
                const result = await client.clearGoal({ threadId });
                if (result.cleared !== false) {
                    updateCodexGoalState({
                        type: 'thread_goal_cleared',
                        threadId,
                    });
                }
                messageBuffer.addMessage('Goal cleared', 'status');
                return true;
            }

            const result = await client.setGoal({
                threadId,
                objective: command.objective,
            });
            updateCodexGoalState({
                type: 'thread_goal_updated',
                threadId,
                goal: result.goal,
            });
            messageBuffer.addMessage('Goal updated', 'status');
            return true;
        } catch (error) {
            logger.debug('[Codex] Goal command API failed; falling back to normal turn:', error);
            return false;
        }
    };
    session.rpcHandlerManager.registerHandler('goal-action', async (params: Record<string, unknown>) => {
        const command = parseCodexGoalActionParams(params);
        if (!command) {
            throw new Error('Unsupported Codex goal action');
        }

        const threadId = client.threadId;
        if (!threadId) {
            throw new Error('No active Codex thread');
        }

        const handled = await goalLock.inLock(() => handleCodexGoalCommand(command, threadId));
        if (!handled) {
            throw new Error('Codex goal actions are not supported by this runtime');
        }

        return { ok: true };
    });

    // Approval handler: routes server → client approval requests to our permission handler
    client.setApprovalHandler(async (params) => {
        const toolName = params.type === 'exec'
            ? 'CodexBash'
            : params.type === 'patch'
                ? 'CodexPatch'
                : (params.toolName ?? 'McpTool');
        const input = params.type === 'exec'
            ? { command: params.command, cwd: params.cwd }
            : params.type === 'patch'
                ? { changes: params.fileChanges }
                : (params.input ?? {});
        const activePermissionMode = activeTurnPermissionMode ?? remoteModeState.currentPermissionMode;
        // Check the latest session mode too: a turn pinned under an untrusted
        // policy keeps prompting after the user flips to yolo mid-turn
        // otherwise. Only when the mode was EXPLICITLY picked by the user —
        // the abort-reset restores the launch default (yolo for plain codex),
        // and a straggler approval from the dying turn (the ~3s abort grace
        // window, when the pinned turn mode is still set) must not be waved
        // through by that reset value.
        const latestPermissionMode = remoteModeState.currentPermissionModeExplicitlySet
            ? remoteModeState.currentPermissionMode
            : undefined;

        const decision = resolveCodexApprovalDecision(activePermissionMode, client.sandboxEnabled, {
            hubGuarded: hubCodexApprovalDenied(session.getMetadata(), activeTurnIsHub),
            latestPermissionMode,
        });
        if (decision === 'denied') {
            logger.debug(`[Codex] Hub guard denied ${params.type} approval`);
            // The approval wire carries only a decision. Steer the explanation
            // separately, without waiting on an RPC while Codex awaits denial.
            if (!hubDenialSent) {
                hubDenialSent = true;
                void client.steerTurn(HUB_CODEX_DENIAL).catch(() => logger.debug('[Codex] Hub denial notice could not be steered'));
            }
            return 'denied';
        }
        if (decision === 'approved' && !params.requiresInput) {
            logger.debug(`[Codex] Auto-approving ${params.type} approval in ${activePermissionMode} mode (latest: ${latestPermissionMode ?? 'n/a'})`);
            return 'approved';
        }

        try {
            const result = await permissionHandler.handleToolCall(params.callId, toolName, input, { policyAutoApprove: params.type === 'exec' || params.type === 'patch' });
            logger.debug('[Codex] Permission result:', result.decision);
            return result.decision;
        } catch (error) {
            logger.debug('[Codex] Error handling permission:', error);
            return 'denied';
        }
    });

    let quotaStopped = false;
    let quotaPolling = false;
    let quotaRevision = 0;
    const publishQuota = (value: unknown) => {
        const limits = codexUsageLimits(value);
        if (!quotaStopped && limits) {
            session.updateAgentState(state => ({ ...state, usageLimits: limits }));
        }
    };
    client.setRateLimitsHandler(value => { quotaRevision++; publishQuota(value); });
    const refreshQuota = async () => {
        if (quotaStopped || quotaPolling) return;
        quotaPolling = true;
        const revision = quotaRevision;
        try {
            const value = await client.readRateLimits();
            if (revision === quotaRevision) publishQuota(value);
        } catch { /* Older servers and API-key accounts may not expose plan limits. */ }
        finally { quotaPolling = false; }
    };
    let quotaTimer: ReturnType<typeof setInterval> | undefined;

    // Event handler: same EventMsg types as the legacy MCP server — no changes needed
    client.setEventHandler((msg) => {
        logger.debug(`[Codex] Event: ${JSON.stringify(msg)}`);
        const isSubagentScopedEvent = hasCodexSubagentReference(msg as Record<string, unknown>);

        // Add messages to the ink UI buffer based on message type
        if (msg.type === 'agent_message') {
            messageBuffer.addMessage((msg as any).message, 'assistant');
        } else if (msg.type === 'agent_reasoning_delta') {
            // Skip reasoning deltas in the UI to reduce noise
        } else if (msg.type === 'agent_reasoning' && !isSubagentScopedEvent) {
            messageBuffer.addMessage(`[Thinking] ${(msg as any).text.substring(0, 100)}...`, 'system');
        } else if (msg.type === 'exec_command_begin') {
            messageBuffer.addMessage(`Executing: ${(msg as any).command}`, 'tool');
        } else if (msg.type === 'exec_command_end') {
            const output = (msg as any).output || (msg as any).error || 'Command completed';
            const truncatedOutput = output.substring(0, 200);
            messageBuffer.addMessage(
                `Result: ${truncatedOutput}${output.length > 200 ? '...' : ''}`,
                'result'
            );
        } else if (msg.type === 'task_started') {
            messageBuffer.addMessage('Starting task...', 'status');
        } else if (msg.type === 'token_count') {
            const usage = codexTurnUsage(msg);
            if (usage) meter.add(usage);
        } else if (msg.type === 'task_complete') {
            // Ready is emitted from the main loop's idle check so pushes only fire once
            // after the queue is actually drained.
            const failure = describeCodexFailure(msg);
            if (failure) {
                if (isEngineAuthError(failure)) void session.updateMetadata(m => ({ ...m, engineAuth: { status: 'required', checkedAt: Date.now() } }));
                void quota.onFailure(failure);
                messageBuffer.addMessage(`Task failed: ${failure}`, 'status');
                session.sendSessionEvent({ type: 'message', message: `Codex error: ${failure}` });
            } else {
                messageBuffer.addMessage('Task completed', 'status');
            }
        } else if (msg.type === 'turn_aborted') {
            const failure = describeCodexFailure(msg);
            if (failure) {
                if (isEngineAuthError(failure)) void session.updateMetadata(m => ({ ...m, engineAuth: { status: 'required', checkedAt: Date.now() } }));
                void quota.onFailure(failure);
                messageBuffer.addMessage(`Turn aborted: ${failure}`, 'status');
                session.sendSessionEvent({ type: 'message', message: `Codex error: ${failure}` });
            } else {
                messageBuffer.addMessage('Turn aborted', 'status');
            }
        }

        if (msg.type === 'task_started' && !isSubagentScopedEvent) {
            if (!thinking) {
                logger.debug('thinking started');
                thinking = true;
                session.keepAlive(thinking, 'remote');
                publishRefreshWait();
            }
        }
        if (!isSubagentScopedEvent && (msg.type === 'task_complete' || msg.type === 'turn_aborted')) {
            if (thinking) {
                logger.debug('thinking completed');
                thinking = false;
                session.keepAlive(thinking, 'remote');
                publishRefreshWait();
            }
            // Reset diff processor on task end or abort
            diffProcessor.reset();
        }
        if (msg.type === 'agent_reasoning_section_break' && !isSubagentScopedEvent) {
            reasoningProcessor.handleSectionBreak();
        }
        if (msg.type === 'agent_reasoning_delta' && !isSubagentScopedEvent) {
            reasoningProcessor.processDelta((msg as any).delta);
        }
        if (msg.type === 'agent_reasoning' && !isSubagentScopedEvent) {
            reasoningProcessor.complete((msg as any).text);
        }
        if (msg.type === 'patch_apply_begin') {
            const { changes } = msg as any;
            const changeCount = Object.keys(changes).length;
            const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
            messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');
        }
        if (msg.type === 'patch_apply_end') {
            const { stdout, stderr, success } = msg as any;
            if (success) {
                const message = stdout || 'Files modified successfully';
                messageBuffer.addMessage(message.substring(0, 200), 'result');
            } else {
                const errorMsg = stderr || 'Failed to modify files';
                messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
            }
        }
        if (msg.type === 'turn_diff') {
            if ((msg as any).unified_diff) {
                diffProcessor.processDiff((msg as any).unified_diff);
            }
        }
        if (msg.type === 'thread_goal_updated' || msg.type === 'thread_goal_cleared') {
            updateCodexGoalState(msg);
        }

        // Convert events into the unified session-protocol envelope stream.
        // Reasoning deltas are handled by ReasoningProcessor to avoid duplicate text output.
        // Subagent-scoped reasoning bypasses the processor, so only forward the
        // FINAL agent_reasoning for subagents — the mapper renders deltas and
        // the final text identically, and forwarding both would emit one
        // thinking bubble per fragment plus a duplicate full-text bubble.
        const isReasoningEvent = msg.type === 'agent_reasoning_delta'
            || msg.type === 'agent_reasoning'
            || msg.type === 'agent_reasoning_section_break';
        const isForwardableSubagentReasoning = isSubagentScopedEvent && msg.type === 'agent_reasoning';
        if (msg.type !== 'turn_diff' && (!isReasoningEvent || isForwardableSubagentReasoning)) {
            const mapped = mapCodexMcpMessageToSessionEnvelopes(msg, {
                currentTurnId,
                startedSubagents: codexStartedSubagents,
                activeSubagents: codexActiveSubagents,
                providerSubagentToSessionSubagent: codexProviderSubagentToSessionSubagent,
                subagentTitles: codexSubagentTitles,
                collabReceiverThreadIdsByCall: codexCollabReceiverThreadIdsByCall,
                collabToolByCall: codexCollabToolByCall,
            });
            currentTurnId = mapped.currentTurnId;
            codexStartedSubagents = mapped.startedSubagents;
            codexActiveSubagents = mapped.activeSubagents;
            codexProviderSubagentToSessionSubagent = mapped.providerSubagentToSessionSubagent;
            codexSubagentTitles = mapped.subagentTitles;
            codexCollabReceiverThreadIdsByCall = mapped.collabReceiverThreadIdsByCall;
            codexCollabToolByCall = mapped.collabToolByCall;
            for (const envelope of mapped.envelopes) {
                session.sendSessionProtocolMessage(envelope);
            }
        }
    });

    // Agent mail, same as Claude: the tools ride the MCP server the bridge
    // already forwards to, and the loop only polls for sessions that opted in.
    const agentMail = startAgentMail(session, opts.credentials.token, () => {
        const meta = session.getMetadata();
        return {
            machine: meta?.name || meta?.host || machineId,
            engine: 'Codex',
            title: meta?.summary?.text || meta?.path?.split('/').pop() || 'session',
            path: meta?.path,
        };
    });

    // Start Happy MCP server (HTTP) and prepare STDIO bridge config for Codex
    // A worker refused for quota reports itself to its hub; the model cannot.
    const meter = createTaskMeter();
    const quota = createQuotaReporter({ selfId: session.sessionId, metadata: () => session.getMetadata(), updateMetadata: (u) => session.updateMetadata(u), sendMail: (id, text) => agentMail.mail.send(id, text, 1) });
    const handoffPort = createHandoffPort(session, 'Codex', 'codex', () => {
        const id = session.getMetadata()?.codexThreadId;
        return id ? { engine: 'Codex', id } : null;
    });
    // Writing the handoff is the last thing this engine does for this session:
    // hold the cursor there, so anything sent afterwards reaches the engine
    // taking over instead of aging the notes it is about to read.
    let heldReceiveSeq: number | undefined;
    handoffPort.onSubmitted = () => {
        if (heldReceiveSeq === undefined) heldReceiveSeq = session.pauseIncomingMessages();
    };
    // Calling a queued refresh or switch off. Honest about being too late: once
    // the drain is applying, the cursor is mid-handover and the daemon may
    // already hold a reservation.
    session.rpcHandlerManager.registerHandler('cancel-session-refresh', async () => {
        if (refreshHandoff || configurationQueue.isApplying) return { status: 'too-late' };
        if (!configurationQueue.hasPendingRefresh) return { status: 'nothing-pending' };
        configurationQueue.clear();
        const target = switchTarget;
        switchTarget = undefined;
        switchPermissionMode = undefined;
        handoffPort.disarm();
        if (heldReceiveSeq !== undefined) { session.resumeIncomingMessagesFrom(heldReceiveSeq); heldReceiveSeq = undefined; }
        session.updateMetadata(m => ({ ...m, sessionConfigState: 'applied', sessionConfigError: undefined, sessionConfigErrorKind: undefined, sessionConfigStage: undefined, sessionConfigUpdatedAt: Date.now() }));
        if (target) session.sendSessionEvent({ type: 'engine-switch-cancelled', target });
        return { status: 'cancelled' };
    });
    const happyServer = await startHappyServer(session, agentMail.mail, handoffPort, { cwd: process.cwd(), machineId, meter });
    // Taking a session over: same door as agent mail, for the same reason.
    const inherited = await consumePendingHandoff(session);
    if (inherited) {
        logger.debug(`[Codex] Delivering a ${inherited.source} handoff from the previous engine`);
        // Two deliveries of the same text for two audiences: the event is the
        // boundary the transcript draws and opens, the message is what the
        // engine actually reads. The app hides the message, since showing a
        // briefing as something the user said would be wrong twice over; the
        // display text is what an older client falls back to showing.
        session.sendSessionEvent({ type: 'engine-handoff', from: inherited.from, fromFlavor: inherited.fromFlavor, source: inherited.source, briefing: inherited.briefing });
        session.sendUserTextMessage(inherited.briefing, { displayText: `[handoff from ${inherited.from}]` });
        // A worker's hub chose a model when it dispatched; after a switch that
        // choice no longer describes who is doing the work, and the hub should
        // hear it from the session rather than notice it in a report.
        const orchestration = session.getMetadata()?.orchestration;
        if (orchestration?.role === 'worker') {
            void agentMail.mail.send(orchestration.hub.sessionId, `[notice] worker ${session.sessionId} now runs on ${inherited.from === 'Codex' ? 'Claude Code' : 'Codex'} after an engine switch; the model it was dispatched with may no longer apply.`, 1);
        }
    }
    // Launch the bridge via `node <path>` (rather than relying on the .mjs shebang)
    // so it works on Windows, where Windows can't execute shebang scripts directly.
    // codex would otherwise fail to start the MCP server, the change_title tool would
    // not be visible to the model, and the model would improvise with shell echoes.
    const bridgeEntrypoint = join(projectPath(), 'bin', 'happy-mcp.mjs');
    const mcpServersForRole = () => ({
        happy: {
            command: process.execPath,
            args: ['--no-warnings', '--no-deprecation', bridgeEntrypoint, '--url', happyServer.url],
            // Explicit per-tool trust preserves hub orchestration under `never`
            // without granting approval to other MCP servers or native tools.
            tools: hubCodexMcpTools(session.getMetadata()),
        },
    });
    let threadToolsKey = JSON.stringify(mcpServersForRole().happy.tools);
    let first = true;
    let appendSystemPromptInjected = false;

    try {
        logger.debug('[codex]: client.connect begin');
        await client.connect();
        logger.debug('[codex]: client.connect done');
        void refreshQuota();
        quotaTimer = setInterval(() => { void refreshQuota(); }, 30_000);
        quotaTimer.unref();

        if (opts.resumeThreadId) {
            await resumeExistingThread({
                client: {
                    resumeThread: (options) => client.resumeThread(options),
                },
                session,
                messageBuffer,
                threadId: opts.resumeThreadId,
                cwd: process.cwd(),
                mcpServers: mcpServersForRole(),
                // Side chats start empty — keep the resume notice out of the UI.
                announce: !isSideChat,
            });
            first = false;
            // Whether this thread already carries our injected instructions is a
            // question about the thread, not something to assume. Resuming used
            // to set this flag unconditionally, so a thread that never received
            // them (created before the feature, or resumed from a process that
            // exited before its first turn) stayed without them for good — the
            // flag only resets on /clear. The agent then never learned to emit
            // <options>, and its answers never became chips.
            try {
                const { thread } = await client.readThread({
                    threadId: opts.resumeThreadId,
                    includeTurns: true,
                });
                appendSystemPromptInjected = threadHasLmcSystemBlock(thread);
                if (!appendSystemPromptInjected) {
                    logger.debug('[codex]: resumed thread carries no happy-system block; will inject on the next turn');
                }
            } catch (error) {
                // Reading the thread is a check, not a requirement. If it fails,
                // inject again: the instructions are idempotent and wrapped, so a
                // duplicate costs nothing, while skipping loses chips entirely.
                logger.debug('[codex]: could not read resumed thread, will inject instructions:', error);
                appendSystemPromptInjected = false;
            }
        }

        if (process.env.HAPPY_REFRESH_RECEIVE_SEQ !== undefined) {
            // A refresh resumes the thread it left, and checking that thread is
            // how we know the replacement really came back. A switch has no
            // thread to resume — it starts Codex on a new one, exactly as a
            // brand-new session does, and that path is not verified either.
            // Asking for a resume record here reported every completed switch
            // to Codex as a failure, over a session that had in fact changed
            // hands: verifyConfigurationReady's first line demands the thread id
            // a switch is defined by not having.
            const switched = process.env.HAPPY_REFRESH_ENGINE_SWITCH === '1';
            try {
                if (!switched) await client.verifyConfigurationReady();
                session.updateMetadata(m => ({ ...m, sessionConfigState: 'applied', sessionConfigError: undefined, sessionConfigUpdatedAt: Date.now() }));
            } catch (error) {
                session.updateMetadata(m => ({ ...m, sessionConfigState: 'error', sessionConfigErrorKind: 'verify', sessionConfigError: error instanceof Error ? error.message : 'Configuration verification failed', sessionConfigUpdatedAt: Date.now() }));
            }
        }

        const forkCodexThreadId = process.env.HAPPY_FORK_CODEX_THREAD_ID;
        if (!reconnectSessionId && forkCodexThreadId) {
            // Side chats inherit the forked thread's context inside the model
            // (thread/fork copies it), but we deliberately do NOT replay the
            // pre-fork history into the UI: a side chat starts empty from the
            // moment it was opened, so the user only sees the aside they began.
            if (!isSideChat) {
                try {
                    const { thread } = await client.readThread({
                        threadId: forkCodexThreadId,
                        includeTurns: true,
                    });
                    const envelopes = await buildCodexThreadBackfillEnvelopes({
                        thread,
                        uploadLocalImage: (attachment, imageOpts) => (
                            session.uploadLocalImageAttachmentEnvelope(attachment, imageOpts)
                        ),
                    });
                    for (const envelope of envelopes) {
                        session.sendSessionProtocolMessage(envelope);
                    }
                    logger.debug(`[CODEX FORK BACKFILL] Replayed ${envelopes.length} historical envelopes from thread ${forkCodexThreadId}`);
                } catch (error) {
                    logger.debug(`[CODEX FORK BACKFILL] Failed to read thread ${forkCodexThreadId}:`, error);
                }
            }
            session.updateMetadata((currentMetadata) => ({
                ...currentMetadata,
                codexThreadId: forkCodexThreadId,
            }));
        }

        let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string; attachments?: PendingAttachment[] } | null = null;
        let recoveryNoticeSent = false;

        while (!shouldExit) {
            if (abortInProgress) await abortInProgress;
            logActiveHandles('loop-top');
            if (!configurationBlocked && !pending && messageQueue.size() === 0) {
                try {
                    await configurationQueue.drain(thinking, messageQueue.size(), async config => {
                        if (config.refreshCli) {
                            await handleUserMessage.idle();
                            if (messageQueue.size()) throw new Error('Wait for queued messages before refreshing');
                            refreshHandoff = true;
                            const receiveSeq = heldReceiveSeq ?? session.pauseIncomingMessages();
                            heldReceiveSeq = undefined;
                            let prepared;
                            try {
                            await session.waitForIncomingDelivery();
                            await handleUserMessage.idle();
                            if (messageQueue.size()) throw new Error('有消息等待处理，请在本轮结束后重试刷新');
                            // The login check is its own stage, so the app can show it
                            // as its own step and point at the fix when it fails.
                            session.updateMetadata(m => ({ ...m, sessionConfigStage: 'preflight' }));
                            try {
                                if (switchTarget) {
                                    // The engine taking over is the one whose login has to be good.
                                    const targetAuth = await checkEngineAuth(switchTarget, process.cwd());
                                    if (targetAuth === 'required') throw new EngineAuthPreflightError(`${switchTarget} 尚未登录，请在会话设备完成登录；原会话已保留`, switchTarget);
                                    if (targetAuth !== 'ready') throw new Error(`无法核验 ${switchTarget} 认证，原会话已保留`);
                                } else {
                                    const auth = await checkAuthentication();
                                    if (auth.status === 'required') throw new EngineAuthPreflightError('Codex 尚未登录，请在会话设备执行 codex login；原会话已保留', 'codex');
                                    if (auth.status !== 'ready') throw new Error('无法核验 Codex 认证，原会话已保留');
                                }
                            } catch (error) {
                                throw tagRefreshError(error, 'preflight');
                            } finally {
                                session.updateMetadata(m => ({ ...m, sessionConfigStage: undefined }));
                            }
                            prepared = switchTarget
                                // Model, effort and the Codex-only settings stay behind: they are
                                // named for this engine and mean nothing to the next one.
                                ? await prepareDaemonSessionRefresh(session.sessionId, process.pid, {
                                    receiveSeq, engine: switchTarget, permissionMode: switchPermissionMode,
                                })
                                : await prepareDaemonSessionRefresh(session.sessionId, process.pid, {
                                    receiveSeq, model: remoteModeState.currentModel, effort: remoteModeState.currentEffort,
                                    permissionMode: remoteModeState.currentPermissionMode,
                                    codexContextLimits: config.contextLimits, codexServiceTier: config.serviceTier,
                                });
                            if (prepared.error) throw tagRefreshError(new Error(prepared.error), 'relaunch');
                            } catch (error) { refreshHandoff = false; switchTarget = undefined; handoffPort.disarm(); session.resumeIncomingMessagesFrom(receiveSeq); throw error; }

                            session.updateMetadata(m => ({ ...m, sessionConfigState: 'refreshing', sessionConfigUpdatedAt: Date.now() }));
                            session.markRelaunching();
                            shouldExit = true;
                        } else {
                            await client.applyRuntimeConfiguration(config.contextLimits, config.serviceTier);
                            contextLimits = config.contextLimits; serviceTier = config.serviceTier;
                            session.updateMetadata(m => ({ ...m, codexContextLimits: contextLimits, codexServiceTier: serviceTier, sessionConfigState: 'applied', sessionConfigError: undefined, sessionConfigUpdatedAt: Date.now() }));
                        }
                    });
                } catch (error) {
                    configurationBlocked = true;
                    session.updateMetadata(m => ({ ...m, sessionConfigState: 'error', sessionConfigError: error instanceof Error ? error.message : 'Configuration update failed', sessionConfigErrorKind: refreshErrorKind(error), sessionConfigUpdatedAt: Date.now() }));
                }
                if (shouldExit) break;
                if (!configurationBlocked && configurationQueue.hasPending && !thinking && messageQueue.size() === 0) continue;
            }

            // Recovery must succeed BEFORE the queue emits a release receipt.
            // Otherwise an inserted reply disappears from the strip while its
            // provider thread is still unavailable.
            try {
                await client.ensureThreadReady();
                recoveryNoticeSent = false;
            } catch (error) {
                logger.debug('[Codex] Waiting for original thread recovery:', error);
                if (!recoveryNoticeSent) {
                    session.sendSessionEvent({ type: 'message', message: '原 Codex 会话暂时无法恢复，排队消息仍保留；正在重试，不会新建上下文。' });
                    recoveryNoticeSent = true;
                }
                await new Promise(resolve => setTimeout(resolve, 5_000));
                continue;
            }

            let message: { message: string; mode: EnhancedMode; isolate: boolean; hash: string; attachments?: PendingAttachment[] } | null = pending;
            pending = null;
            if (!message) {
                // Capture the current signal to distinguish idle-abort from queue close
                const waitSignal = abortController.signal;
                const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
                if (!batch) {
                    // If wait was aborted (e.g., remote abort with no active inference), ignore and continue
                    if (waitSignal.aborted && !shouldExit) {
                        logger.debug('[codex]: Wait aborted while idle; ignoring and continuing');
                        continue;
                    }
                    logger.debug(`[codex]: batch=${!!batch}, shouldExit=${shouldExit}`);
                    break;
                }
                message = batch;
            }

            // Defensive check for TS narrowing
            if (!message) {
                break;
            }

            if (isCodexClearText(message.message)) {
                logger.debug('[Codex] Handling /clear command - resetting Codex thread state');
                client.clearThreadState();
                currentTurnId = null;
                codexStartedSubagents = new Set<string>();
                codexActiveSubagents = new Set<string>();
                codexProviderSubagentToSessionSubagent = new Map<string, string>();
                codexSubagentTitles = new Map<string, string>();
                codexCollabReceiverThreadIdsByCall = new Map<string, string[]>();
                codexCollabToolByCall = new Map<string, string>();
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                appendSystemPromptInjected = false;
                thinking = false;
                session.keepAlive(thinking, 'remote');
                messageBuffer.addMessage('Context was reset', 'status');
                session.sendSessionEvent({ type: 'message', message: 'Context was reset' });
                session.updateMetadata((currentMetadata) => {
                    const nextMetadata = { ...currentMetadata };
                    delete nextMetadata.codexThreadId;
                    return nextMetadata;
                });
                emitReadyIfIdle({
                    pending,
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    sendReady,
                });
                continue;
            }

            // Display user messages in the UI
            if (message.message.trim().length > 0) {
                messageBuffer.addMessage(message.message, 'user');
            }

            try {
                // Map permission mode to approval policy and sandbox.
                // With app-server, these are per-turn — no restart needed on mode change.
                const sandboxManagedByLmc = client.sandboxEnabled;
                activeTurnIsHub = isHub(session.getMetadata());
                hubDenialSent = false;
                activeTurnPermissionMode = hubCodexPermissionMode(session.getMetadata(), remoteModeState.currentPermissionMode);
                const executionPolicy = resolveCodexExecutionPolicy(
                    activeTurnPermissionMode,
                    activeTurnPermissionMode === 'read-only' ? false : sandboxManagedByLmc,
                );

                // Start thread on first turn (thread persists across mode changes)
                let activeThreadId = client.threadId;
                const turnMcpServers = mcpServersForRole();
                const turnToolsKey = JSON.stringify(turnMcpServers.happy.tools);
                if (!client.hasActiveThread() || !activeThreadId) {
                    const startedThread = await client.startThread({
                        model: message.mode.model,
                        cwd: process.cwd(),
                        approvalPolicy: executionPolicy.approvalPolicy,
                        sandbox: executionPolicy.sandbox,
                        mcpServers: turnMcpServers,
                    });
                    threadToolsKey = turnToolsKey;
                    activeThreadId = startedThread.threadId;
                    session.updateMetadata((currentMetadata) => ({
                        ...currentMetadata,
                        codexThreadId: startedThread.threadId,
                    }));
                }

                // Promotion/dissolution changes the bridge trust and thread
                // defaults at the next idle turn boundary, including a thread
                // that was created before this session became a hub.
                if (threadToolsKey !== turnToolsKey) {
                    await client.resumeThread({
                        threadId: activeThreadId,
                        ...executionPolicy,
                        mcpServers: turnMcpServers,
                    });
                    threadToolsKey = turnToolsKey;
                }

                const goalCommand = parseCodexGoalCommand(message.message);
                if (goalCommand && await goalLock.inLock(() => handleCodexGoalCommand(goalCommand, activeThreadId))) {
                    continue;
                }

                const automaticGoalText = message.message;
                const automaticGoalPermissionMode = message.mode.permissionMode;
                const includeAppendSystemPrompt = Boolean(
                    message.mode.appendSystemPrompt && !appendSystemPromptInjected,
                );
                const savedFiles = await saveAttachmentsToInbox(message.attachments ?? [], { projectPath: process.cwd(), sessionId: session.sessionId });
                if (savedFiles.length > 0) message = { ...message, message: message.message + formatInboxNote(savedFiles) };
                const imageInputs = await prepareCodexImageInputItems(message.attachments, {
                    sessionId: session.sessionId,
                });
                if ((message.attachments?.length ?? 0) > 0) {
                    logger.debug('[Codex] Prepared image inputs for turn', {
                        inputCount: imageInputs.inputItems.length,
                        skippedCount: imageInputs.skipped,
                    });
                }
                const hasUserText = message.message.trim().length > 0;
                if ((message.attachments?.length ?? 0) > 0 && imageInputs.inputItems.length === 0 && !hasUserText) {
                    session.sendSessionEvent({
                        type: 'message',
                        message: 'No supported images were available to send to Codex.',
                    });
                    continue;
                }
                const turnPrompt = buildCodexTurnPrompt({
                    message: message.message,
                    mode: message.mode,
                    includeAppendSystemPrompt,
                    includeTitleInstruction: first,
                });

                activeTurnModeHash = hashCodexEnhancedMode(message.mode, 'steer');
                const result = await client.sendTurnAndWait(turnPrompt, {
                    model: message.mode.model,
                    approvalPolicy: executionPolicy.approvalPolicy,
                    sandbox: executionPolicy.sandbox,
                    effort: message.mode.effort,
                    extraInputItems: imageInputs.inputItems,
                    onStarted: () => goalLock.inLock(() => createCodexAutomaticGoal(automaticGoalText, {
                        policy: automaticGoals,
                        supported: client.supportsGoalActions(),
                        permissionMode: automaticGoalPermissionMode,
                        isTurnActive: () => client.threadId === activeThreadId && client.hasPendingTurnCompletion(),
                        getGoal: () => client.getGoal({ threadId: activeThreadId }),
                        setGoal: async (objective) => {
                            const result = await client.setGoal({ threadId: activeThreadId, objective, status: 'active' });
                            updateCodexGoalState({ type: 'thread_goal_updated', threadId: activeThreadId, goal: result.goal });
                        },
                    })),
                });
                first = false;
                if (includeAppendSystemPrompt) {
                    appendSystemPromptInjected = true;
                }

                if (result.aborted) {
                    // Turn was aborted (user abort or permission cancel).
                    // UI handling already done by the event handler (turn_aborted).
                    logger.debug('[Codex] Turn aborted');
                }
            } catch (error) {
                // Only actual errors reach here (process crash, connection failure, etc.)
                logger.warn('Error in codex session:', error);
                if (error instanceof Error && isEngineAuthError(error.message)) {
                    void session.updateMetadata(m => ({ ...m, engineAuth: { status: 'required', checkedAt: Date.now() } }));
                }
                messageBuffer.addMessage('Process exited unexpectedly', 'status');
                session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
            } finally {
                // Reset permission handler, reasoning processor, and diff processor
                permissionHandler.reset();
                reasoningProcessor.abort();  // Use abort to properly finish any in-progress tool calls
                diffProcessor.reset();
                activeTurnModeHash = null;
                activeTurnPermissionMode = undefined;
                activeTurnIsHub = false;
                hubDenialSent = false;
                thinking = false;
                session.keepAlive(thinking, 'remote');
                emitReadyIfIdle({
                    pending,
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    sendReady,
                });
                logActiveHandles('after-turn');
            }
        }

    } catch (error) {
        if (process.env.HAPPY_REFRESH_RECEIVE_SEQ !== undefined) {
            const report = await reportSessionRefreshFailure(error, updater => session.updateMetadata(updater));
            if (report !== 'reported') logger.debug(`[codex]: Session refresh failure reporting ${report}; continuing cleanup`);
        }
        throw error;
    } finally {
        // Clean up resources when main loop exits
        quotaStopped = true;
        if (quotaTimer) clearInterval(quotaTimer);
        logger.debug('[codex]: Final cleanup start');
        logActiveHandles('cleanup-start');

        // Cancel offline reconnection if still running
        if (reconnectionHandle) {
            logger.debug('[codex]: Cancelling offline reconnection');
            reconnectionHandle.cancel();
        }

        try {
            logger.debug('[codex]: sendSessionDeath');
            session.sendSessionDeath();
            logger.debug('[codex]: flush begin');
            await session.flush();
            logger.debug('[codex]: flush done');
            logger.debug('[codex]: session.close begin');
            await session.close();
            logger.debug('[codex]: session.close done');
        } catch (e) {
            logger.debug('[codex]: Error while closing session', e);
        }
        logger.debug('[codex]: client.disconnect begin');
        await client.disconnect();
        logger.debug('[codex]: client.disconnect done');
        // Stop Happy MCP server
        agentMail.stop();
        stopWatchingConfiguration?.();
        logger.debug('[codex]: happyServer.stop');
        happyServer.stop();

        // Clean up ink UI
        if (process.stdin.isTTY) {
            logger.debug('[codex]: setRawMode(false)');
            try { process.stdin.setRawMode(false); } catch { }
        }
        // Stop reading from stdin so the process can exit
        if (hasTTY) {
            logger.debug('[codex]: stdin.pause()');
            try { process.stdin.pause(); } catch { }
        }
        // Clear periodic keep-alive to avoid keeping event loop alive
        logger.debug('[codex]: clearInterval(keepAlive)');
        clearInterval(keepAliveInterval);
        if (inkInstance) {
            logger.debug('[codex]: inkInstance.unmount()');
            inkInstance.unmount();
        }
        messageBuffer.clear();

        logActiveHandles('cleanup-end');
        logger.debug('[codex]: Final cleanup completed');
    }

    return refreshHandoff ? 'refresh-handoff' : 'stopped';
}
