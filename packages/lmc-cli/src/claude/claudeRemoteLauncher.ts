import { claudeTurnFailure } from '@/modules/orchestration/quota';
import { claudeTurnTotal, claudeTurnUsage } from '@/modules/orchestration/meter';
import { engineCapabilities } from '@/runtime/managedRuntime';
import { SafeSessionRefresh } from '@/utils/safeSessionRefresh';
import { readFallbackBriefing, readSwitchEngine, readSwitchSettings } from '@/utils/engineSwitchRequest';
import { applyQueueModeRequest, registerQueueControlHandlers } from '@/utils/sessionQueueControl';
import { checkEngineAuth, isEngineAuthError } from '@/utils/engineAuth';
import { EngineAuthPreflightError } from '@/utils/refreshErrors';
import { isPendingState } from '@/utils/refreshState';
import { prepareDaemonSessionRefresh } from '@/daemon/controlClient';
import { claudeCheckSession } from './utils/claudeCheckSession';
import { trackBackgroundTask, releaseForegroundTasks, type BackgroundTasks } from './utils/backgroundTasks';
import { render } from "ink";
import { Session } from "./session";
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { RemoteModeDisplay } from "@/ui/ink/RemoteModeDisplay";
import React from "react";
import { claudeRemote } from "./claudeRemote";
import { PermissionHandler } from "./utils/permissionHandler";
import { mergeUsageLimits } from "./utils/usageLimits";
import { Future } from "@/utils/future";
import { SDKAssistantMessage, SDKMessage, SDKUserMessage } from "./sdk";
import { formatClaudeMessageForInk } from "@/ui/messageFormatterInk";
import { logger } from "@/ui/logger";
import { SDKToLogConverter } from "./utils/sdkToLogConverter";
import { EnhancedMode } from "./loop";
import { RawJSONLines } from "@/claude/types";
import { OutgoingMessageQueue } from "./utils/OutgoingMessageQueue";
import { getToolName } from "./utils/getToolName";
import { getAskUserQuestionToolCallIds } from "./utils/questionNotification";
import { launchFailureMessage } from "./utils/launchFailureMessage";
import { cleanupStdinAfterInk } from "@/utils/terminalStdinCleanup";
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { saveAttachmentsToInbox, formatInboxNote } from '@/modules/common/attachmentInbox';
import { watchSessionConfiguration } from '@/modules/orchestration/workerConfig';
import { normalizeRemotePermissionMode } from './utils/permissionMode';

interface PermissionsField {
    date: number;
    result: 'approved' | 'denied';
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowedTools?: string[];
}

export async function claudeRemoteLauncher(session: Session): Promise<'switch' | 'exit'> {
    logger.debug('[claudeRemoteLauncher] Starting remote launcher');

    // Check if we have a TTY for UI rendering
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    logger.debug(`[claudeRemoteLauncher] TTY available: ${hasTTY}`);

    // Configure terminal
    let messageBuffer = new MessageBuffer();
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(RemoteModeDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? session.logPath : undefined,
            onExit: async () => {
                // Exit the entire client
                logger.debug('[remote]: Exiting client via Ctrl-C');
                if (!exitReason) {
                    exitReason = 'exit';
                }
                await abort();
            },
            onSwitchToLocal: () => {
                // Switch to local mode
                logger.debug('[remote]: Switching to local mode via double space');
                doSwitch();
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

    // Handle abort
    let exitReason: 'switch' | 'exit' | null = null;
    let abortController: AbortController | null = null;
    let abortFuture: Future<void> | null = null;

    async function abort() {
        if (abortController && !abortController.signal.aborted) {
            abortController.abort();
        }
        await abortFuture?.promise;
    }

    async function doAbort() {
        logger.debug('[remote]: doAbort');
        session.onAbort();
        await abort();
    }

    async function doSwitch() {
        logger.debug('[remote]: doSwitch');
        if (!exitReason) {
            exitReason = 'switch';
        }
        await abort();
    }

    // When to abort
    session.client.rpcHandlerManager.registerHandler('abort', doAbort); // When abort clicked
    session.client.rpcHandlerManager.registerHandler('switch', doSwitch); // When switch clicked
    // A message sent with intent 'interrupt' (runClaude) and the strip's
    // promote button both stop the running turn this way; the queue keeps
    // what is waiting and the loop picks the head up next.
    session.interruptTurn = abort;
    registerQueueControlHandlers(session.client, session.queue, {
        isBusy: () => session.thinking,
        interrupt: abort,
    });
    // Removed catch-all stdin handler - now handled by RemoteModeDisplay keyboard handlers

    // True only before input is consumed or after the SDK emits a result.
    let safeIdle = true;
    let pending: Awaited<ReturnType<typeof session.queue.waitForMessagesAndGetAsString>> = null;
    let backgroundTasks: BackgroundTasks = new Map();

    // Create permission handler
    const permissionHandler = new PermissionHandler(session);

    // Drop any permission requests left over in agent state from a
    // previous CLI process that died while a tool prompt was open. The
    // in-memory pendingRequests map is fresh and empty, but the server
    // still has `requests: { [id]: {...} }` and the app shows a spinner
    // + "Permission required" banner that no click can clear — the
    // previous process is gone and the new one has no record of the id.
    // reset() moves any stale entries to completedRequests with status
    // 'canceled' so the UI reflects what actually happened.
    permissionHandler.reset('Previous CLI process exited before responding');
    const stopWatchingConfiguration = watchSessionConfiguration(session.client, 'claude', metadata => {
        if (metadata.permissionMode !== undefined) return permissionHandler.handleModeChange(normalizeRemotePermissionMode(metadata.permissionMode ?? undefined));
        return undefined;
    });

    // Create outgoing message queue
    const messageQueue = new OutgoingMessageQueue(
        (logMessage) => session.client.sendClaudeSessionMessage(logMessage)
    );

    // Held between the request and the relaunch, which are separated by however
    // long the current turn takes to finish.
    let switchSettings: ReturnType<typeof readSwitchSettings> = {};
    const refresh = new SafeSessionRefresh({
        isIdle: () => safeIdle && !pending && !exitReason && session.queue.size() === 0
            && !permissionHandler.hasPendingRequests() && backgroundTasks.size === 0,
        // Named in the order a person would want to hear them: the ones they
        // can act on first. A session queued for hours is otherwise a mystery —
        // every one of these looks like "idle" from outside the process.
        idleBlocker: () => {
            if (permissionHandler.hasPendingRequests()) return '等你回复权限请求';
            if (backgroundTasks.size > 0) return `等 ${backgroundTasks.size} 个后台任务结束`;
            if (session.queue.size() > 0) return `等 ${session.queue.size()} 条排队消息`;
            if (pending) return '等当前回合换模式后重启';
            if (!safeIdle) return '等当前回合结束';
            if (exitReason) return '会话正在退出';
            return null;
        },
        pause: () => session.client.pauseIncomingMessages(),
        drain: () => session.client.waitForIncomingDelivery(),
        resume: seq => session.client.resumeIncomingMessagesFrom(seq),
        preflight: async target => {
            if (target && target !== 'claude') {
                // Switching away: there is no Claude thread to resume, and the
                // engine whose login matters is the one about to take over.
                const status = await checkEngineAuth(target, session.path, session.claudeEnvVars);
                if (status === 'required') throw new EngineAuthPreflightError(`${target} 尚未登录。请在此设备终端完成登录后重试；原会话已保留。`, target);
                if (status !== 'ready') throw new Error(`无法核验 ${target} 认证，请检查设备连接后重试。原会话已保留。`);
                await messageQueue.flush();
                return;
            }
            const id = session.sessionId;
            if (!id || !claudeCheckSession(id, session.path)) throw new Error('缺少 Claude 恢复记录，原会话已保留');
            const status = await checkEngineAuth('claude', session.path, session.claudeEnvVars);
            await session.client.updateMetadata(m => ({ ...m, engineAuth: { status, checkedAt: Date.now() } }));
            if (status === 'required') throw new EngineAuthPreflightError('Claude 尚未登录。请在此设备终端运行 claude auth login，完成后重新检查认证。原会话已保留。', 'claude');
            if (status !== 'ready') throw new Error('无法核验 Claude 认证，请检查设备连接后重试。原会话已保留。');
            await messageQueue.flush();
        },
        prepare: async (receiveSeq, target) => {
            // A switch never carries the model and effort held here: they are
            // named for this engine and mean nothing to the next one. What
            // travels is what the request named for the destination — the
            // mapped permission mode and the model picked from its own list.
            const settings = target && target !== 'claude'
                ? { engine: target, ...switchSettings }
                : session.getRefreshSettings();
            const result = await prepareDaemonSessionRefresh(session.client.sessionId, process.pid, { receiveSeq, ...settings });
            if (result.error) throw new Error(result.error);
        },
        exit: async () => { session.client.markRelaunching(); exitReason = 'exit'; abortController?.abort(); },
        state: async (state, error, kind) => {
            // The switch is off: drop the briefing rather than leave it for
            // whatever relaunches this session next.
            if (state === 'error' || state === 'applied') session.handoff?.disarm();
            await session.client.updateMetadata(m => ({ ...m,
                sessionConfigState: state, sessionConfigError: error, sessionConfigErrorKind: kind, sessionConfigStage: undefined, sessionConfigUpdatedAt: Date.now(),
                // Stamped once, as the refresh enters the queue; re-publishing a
                // changed wait reason is the same refresh, not a new one.
                sessionConfigRequestedAt: state === 'queued' ? (isPendingState(m.sessionConfigState) ? m.sessionConfigRequestedAt : Date.now()) : m.sessionConfigRequestedAt,
            }));
        },
        stage: async stage => {
            await session.client.updateMetadata(m => ({ ...m, sessionConfigStage: stage ?? undefined }));
        },
    });
    // Writing the handoff is the last thing this engine does for this session:
    // hold the cursor there, so anything sent afterwards reaches the engine
    // taking over instead of aging the notes it is about to read.
    if (session.handoff) session.handoff.onSubmitted = () => refresh.hold();
    session.client.rpcHandlerManager.registerHandler('configure-session', async (request: unknown) => {
        // Consumption mode only; no relaunch involved, so it applies at once.
        if (applyQueueModeRequest(request, session.queue, session.client)) return { status: 'applied' };
        const engine = readSwitchEngine(request);
        if (engine) {
            switchSettings = readSwitchSettings(request);
            // Armed with the fallback before the engine is asked for anything,
            // so a refusal or a crash still hands something over.
            session.handoff?.arm(readFallbackBriefing(request), engine);
            await refresh.request(engine);
            return { status: 'queued' };
        }
        if (!request || typeof request !== 'object' || (request as any).refreshCli !== true
            || Object.keys(request).some(key => key !== 'refreshCli')) throw new Error('Claude 仅支持安全刷新；模型与思考层级请在模型面板设置');
        await refresh.request();
        return { status: 'queued' };
    });
    // Calling a queued refresh or switch off. Answers honestly when it is too
    // late: once the boundary work has begun the daemon may hold a reservation.
    session.client.rpcHandlerManager.registerHandler('cancel-session-refresh', async () => {
        const target = await refresh.cancel();
        if (target === undefined) return { status: refresh.pending ? 'too-late' : 'nothing-pending' };
        switchSettings = {};
        if (target) session.client.sendSessionEvent({ type: 'engine-switch-cancelled', target });
        return { status: 'cancelled' };
    });
    await session.client.updateMetadata(m => ({ ...m,
        sessionCapabilities: { ...engineCapabilities('claude'), refresh: true, runtimeConfiguration: false },
    }));
    // Seed the resumed identity once. /clear deliberately resets this to null.
    session.sessionId ??= session.client.getMetadata()?.claudeSessionId ?? null;
    if (process.env.HAPPY_REFRESH_RECEIVE_SEQ !== undefined) {
        const id = session.client.getMetadata()?.claudeSessionId;
        const status = await checkEngineAuth('claude', session.path, session.claudeEnvVars);
        // A refresh resumes the thread it left, so its record has to be there.
        // A switch has no such thread by design — the conversation crosses as a
        // written handoff — and judging it by a record it was never meant to
        // have reported every completed switch as a failed one.
        const switched = process.env.HAPPY_REFRESH_ENGINE_SWITCH === '1';
        const resumable = switched || (!!id && claudeCheckSession(id, session.path));
        const valid = resumable && status === 'ready';
        await session.client.updateMetadata(m => ({ ...m, engineAuth: { status, checkedAt: Date.now() },
            sessionConfigState: valid ? 'applied' : 'error', sessionConfigUpdatedAt: Date.now(),
            sessionConfigErrorKind: valid ? undefined : 'verify',
            sessionConfigError: valid ? undefined
                : switched ? `Claude 已接手，但登录核验未通过（${status}）。请在此设备完成 claude 登录。`
                : 'Claude 刷新后认证或恢复记录核验失败，请检查设备；原会话身份已保留',
        }));
    }

    // Set up callback to release delayed messages when permission is requested
    permissionHandler.setOnPermissionRequest((toolCallId: string) => {
        messageQueue.releaseToolCall(toolCallId);
    });

    // Create SDK to Log converter (pass responses from permissions)
    const sdkToLogConverter = new SDKToLogConverter({
        sessionId: session.sessionId || 'unknown',
        cwd: session.path,
        version: process.env.npm_package_version
    }, permissionHandler.getResponseLookup());


    // Handle messages
    let ongoingToolCalls = new Map<string, { parentToolCallId: string | null }>();
    let notifiedQuestionToolCalls = new Set<string>();

    function onMessage(message: SDKMessage) {
        const failure = claudeTurnFailure(message);
        if (failure) session.onTurnFailure?.(failure);
        const usage = claudeTurnUsage(message);
        if (usage) session.onTurnUsage?.(usage);
        const total = claudeTurnTotal(message);
        if (total) session.onTurnTotal?.(total);
        if (message.type === 'result' && message.is_error && isEngineAuthError('result' in message ? String(message.result) : JSON.stringify(message.errors))) {
            void session.client.updateMetadata(m => ({ ...m, engineAuth: { status: 'required', checkedAt: Date.now() } }));
        } else if (message.type === 'assistant' && (message as any).error === 'authentication_failed') {
            void session.client.updateMetadata(m => ({ ...m, engineAuth: { status: 'required', checkedAt: Date.now() } }));
        }
        if (trackBackgroundTask(backgroundTasks, message)) void refresh.drain();

        // Write to message log
        formatClaudeMessageForInk(message, messageBuffer);

        // Track active tool calls
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use') {
                        logger.debug('[remote]: detected tool use ' + c.id! + ' parent: ' + umessage.parent_tool_use_id);
                        ongoingToolCalls.set(c.id!, { parentToolCallId: umessage.parent_tool_use_id ?? null });
                    }
                }
            }
        }

        // Notify once when Claude asks the user a native clarifying question
        for (const toolCallId of getAskUserQuestionToolCallIds(message)) {
            if (notifiedQuestionToolCalls.has(toolCallId)) {
                continue;
            }
            notifiedQuestionToolCalls.add(toolCallId);
            session.api.push().sendSessionNotification({
                kind: 'question',
                metadata: session.client.getMetadata(),
                data: {
                    sessionId: session.client.sessionId,
                    tool: 'AskUserQuestion',
                    toolCallId,
                    type: 'question_request',
                    provider: 'claude',
                }
            });
        }

        if (message.type === 'user') {
            let umessage = message as SDKUserMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        ongoingToolCalls.delete(c.tool_use_id);

                        // When tool result received, release any delayed messages for this tool call
                        messageQueue.releaseToolCall(c.tool_use_id);
                    }
                }
            }
        }

        // Convert SDK message to log format and send to client
        const logMessage = sdkToLogConverter.convert(message);
        if (logMessage) {
            // Add permissions field to tool result content
            if (logMessage.type === 'user' && logMessage.message?.content) {
                const content = Array.isArray(logMessage.message.content)
                    ? logMessage.message.content
                    : [];

                // Modify the content array to add permissions to each tool_result
                for (let i = 0; i < content.length; i++) {
                    const c = content[i];
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        const response = permissionHandler.getResponseForToolUseId(c.tool_use_id);

                        if (response) {
                            const permissions: PermissionsField = {
                                date: response.receivedAt || Date.now(),
                                result: response.approved ? 'approved' : 'denied'
                            };

                            // Add optional fields if they exist
                            if (response.mode) {
                                permissions.mode = response.mode;
                            }

                            if (response.allowTools && response.allowTools.length > 0) {
                                permissions.allowedTools = response.allowTools;
                            }

                            // Add permissions directly to the tool_result content object
                            content[i] = {
                                ...c,
                                permissions
                            };
                        }
                    }
                }
            }

            // Queue message with optional delay for tool calls
            if (logMessage.type === 'assistant' && message.type === 'assistant') {
                const assistantMsg = message as SDKAssistantMessage;
                const toolCallIds: string[] = [];

                if (assistantMsg.message.content && Array.isArray(assistantMsg.message.content)) {
                    for (const block of assistantMsg.message.content) {
                        if (block.type === 'tool_use' && block.id) {
                            toolCallIds.push(block.id);
                        }
                    }
                }

                if (toolCallIds.length > 0) {
                    // Check if this is a sidechain tool call (has parent_tool_use_id)
                    const isSidechain = assistantMsg.parent_tool_use_id !== undefined;

                    if (!isSidechain) {
                        // Top-level tool call - queue with delay
                        messageQueue.enqueue(logMessage, {
                            delay: 250,
                            toolCallIds
                        });
                        return; // Don't queue again below
                    }
                }
            }

            // Queue all other messages immediately (no delay)
            messageQueue.enqueue(logMessage);
        }

        // Insert a fake message to start the sidechain
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use' && c.name === 'Task' && c.input && typeof (c.input as any).prompt === 'string') {
                        const logMessage2 = sdkToLogConverter.convertSidechainUserMessage(c.id!, (c.input as any).prompt);
                        if (logMessage2) {
                            messageQueue.enqueue(logMessage2);
                        }
                    }
                }
            }
        }
    }

    try {

        // Track session ID to detect when it actually changes
        // This prevents context loss when mode changes (permission mode, model, etc.)
        // without starting a new session. Only reset parent chain when session ID
        // actually changes (e.g., new session started or /clear command used).
        // See: https://github.com/anthropics/happy-cli/issues/143
        let previousSessionId: string | null = null;
        while (!exitReason) {
            logger.debug('[remote]: launch');
            messageBuffer.addMessage('═'.repeat(40), 'status');

            // Only reset parent chain and show "new session" message when session ID actually changes
            const isNewSession = session.sessionId !== previousSessionId;
            if (isNewSession) {
                messageBuffer.addMessage('Starting new Claude session...', 'status');
                permissionHandler.reset(); // Reset permissions before starting new session
                sdkToLogConverter.resetParentChain(); // Reset parent chain for new conversation
                logger.debug(`[remote]: New session detected (previous: ${previousSessionId}, current: ${session.sessionId})`);
            } else {
                messageBuffer.addMessage('Continuing Claude session...', 'status');
                logger.debug(`[remote]: Continuing existing session: ${session.sessionId}`);
            }

            previousSessionId = session.sessionId;
            const controller = new AbortController();
            abortController = controller;
            abortFuture = new Future<void>();
            let modeHash: string | null = null;
            let mode: EnhancedMode | null = null;
            try {
                const remoteResult = await claudeRemote({
                    sessionId: session.sessionId,
                    path: session.path,
                    allowedTools: session.allowedTools ?? [],
                    allowWorkerPermissionControl: session.client.getMetadata()?.orchestration?.role === 'worker',
                    mcpServers: session.mcpServers,
                    hookSettingsPath: session.hookSettingsPath,
                    jsRuntime: session.jsRuntime,
                    canCallTool: permissionHandler.handleToolCall,
                    isAborted: (toolCallId: string) => {
                        return permissionHandler.isAborted(toolCallId);
                    },
                    nextMessage: async () => {
                        if (exitReason) return null;
                        // A batch carried across a query restart must go through the
                        // same attachment preparation and initialize the new mode hash.
                        const carried = pending;
                        pending = null;
                        let msg = carried ?? await session.queue.waitForMessagesAndGetAsString(controller.signal);

                        // Check if mode has changed
                        if (msg) {
                            safeIdle = false;
                            const latest = session.getRefreshSettings();
                            if (Object.prototype.hasOwnProperty.call(latest, 'permissionMode')) msg.mode = { ...msg.mode, permissionMode: normalizeRemotePermissionMode(latest.permissionMode) };
                            if ((modeHash && msg.hash !== modeHash) || (msg.isolate && !carried)) {
                                logger.debug('[remote]: mode has changed, pending message');
                                pending = msg;
                                return null;
                            }
                            modeHash = msg.hash;
                            mode = msg.mode;
                            await permissionHandler.handleModeChange(mode.permissionMode);

                            // Per-message attachments are already claimed by the message
                            // when it was pushed onto the queue, so there is no race window
                            // to wait out here — just consume what travelled with the batch.
                            const attachments = msg.attachments ?? [];
                            if (attachments.length > 0) {
                                // Every file lands on this Mac first; the note tells Claude
                                // where. Images additionally go along as image blocks.
                                const saved = await saveAttachmentsToInbox(attachments, { projectPath: session.path, sessionId: session.client.sessionId });
                                const messageText = msg.message + formatInboxNote(saved);
                                const contentBlocks: ContentBlockParam[] = [];
                                for (const att of attachments) {
                                    // Detect media type from the decrypted bytes' magic header
                                    // rather than trusting the wire-supplied mimeType. iOS image
                                    // pickers happily report things like "image/heic" or no
                                    // mimeType at all, which the Anthropic API rejects with a
                                    // strict enum validation error. If the bytes look like one
                                    // of the four formats Claude accepts, send that label —
                                    // otherwise skip the attachment with a debug log.
                                    const detected = detectClaudeImageMime(att.data);
                                    if (!detected) {
                                        logger.debug(`[remote] Attachment is not an image, delivered by path only: ${att.name}, claimed mimeType=${att.mimeType}`);
                                        continue;
                                    }
                                    contentBlocks.push({
                                        type: 'image' as const,
                                        source: {
                                            type: 'base64' as const,
                                            media_type: detected,
                                            data: Buffer.from(att.data).toString('base64'),
                                        },
                                    });
                                }
                                contentBlocks.push({ type: 'text' as const, text: messageText });
                                logger.debug(`[remote] Combined ${contentBlocks.length - 1} image(s) with text message; ${saved.length} file(s) saved to inbox`);
                                return {
                                    message: contentBlocks,
                                    goalText: msg.message,
                                    mode: msg.mode,
                                };
                            }

                            return {
                                message: msg.message,
                                goalText: msg.message,
                                mode: msg.mode
                            }
                        }

                        // Exit
                        return null;
                    },
                    onSessionFound: (sessionId) => {
                        // Update converter's session ID when new session is found
                        sdkToLogConverter.updateSessionId(sessionId);
                        session.onSessionFound(sessionId);
                    },
                    prepareGoalMessage: session.prepareGoalMessage,
                    onSDKMetadata: (metadata) => {
                        logger.debug('[remote] SDK metadata received, updating session:', metadata);
                        session.client.updateMetadata((currentMetadata) => ({
                            ...currentMetadata,
                            tools: metadata.tools,
                            slashCommands: metadata.slashCommands,
                            mcpServers: metadata.mcpServers,
                            skills: metadata.skills,
                        }));
                    },
                    onUsageLimits: (patch) => {
                        // Merging against currentAgentState re-hydrates window
                        // state across claudeRemote re-entries (mode switches).
                        session.client.updateAgentState((currentAgentState) => ({
                            ...currentAgentState,
                            usageLimits: mergeUsageLimits(currentAgentState.usageLimits, patch),
                        }));
                    },
                    onQueryReady: (q) => {
                        permissionHandler.setPermissionModeUpdater(async (mode) => {
                            await q.setPermissionMode(mode);
                        });
                    },
                    onThinkingChange: session.onThinkingChange,
                    claudeEnvVars: session.claudeEnvVars,
                    claudeArgs: session.claudeArgs,
                    onMessage,
                    onCompletionEvent: (message: string) => {
                        logger.debug(`[remote]: Completion event: ${message}`);
                        session.client.sendSessionEvent({ type: 'message', message });
                    },
                    onSessionReset: () => {
                        logger.debug('[remote]: Session reset');
                        session.clearSessionId();
                    },
                    onReady: async () => {
                        session.client.closeClaudeSessionTurn('completed');
                        safeIdle = true;
                        // The turn is over, so any task the engine did not mark
                        // backgrounded is over with it — including one whose
                        // terminal message never arrived.
                        releaseForegroundTasks(backgroundTasks);
                        await refresh.drain();
                        if (!pending && session.queue.size() === 0) {
                            session.api.push().sendSessionNotification({
                                kind: 'done',
                                metadata: session.client.getMetadata(),
                                data: {
                                    sessionId: session.client.sessionId,
                                    type: 'ready',
                                    provider: 'claude',
                                }
                            });
                        }
                    },
                    signal: abortController.signal,
                });
                
                // Consume one-time Claude flags after spawn
                session.consumeOneTimeFlags();
                
                if (!exitReason && abortController.signal.aborted) {
                    session.client.closeClaudeSessionTurn('cancelled');
                    session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                }
            } catch (e) {
                logger.debug('[remote]: launch error', e);
                if (e instanceof Error && isEngineAuthError(e.message)) {
                    void session.client.updateMetadata(m => ({ ...m, engineAuth: { status: 'required', checkedAt: Date.now() } }));
                }
                if (process.env.HAPPY_REFRESH_RECEIVE_SEQ !== undefined && e instanceof Error && e.message.includes('恢复记录不可用')) {
                    await session.client.updateMetadata(m => ({ ...m, sessionConfigState: 'error', sessionConfigError: e.message, sessionConfigUpdatedAt: Date.now() }));
                    exitReason = 'exit';
                }
                // The SDK reports our own abort as a thrown error ("Claude Code
                // process aborted by user"), which used to reach the transcript
                // as "Process exited unexpectedly". Stop, 打断 and promote all
                // land here; it is a cancelled turn, not a failure.
                if (!exitReason && abortController?.signal.aborted) {
                    session.client.closeClaudeSessionTurn('cancelled');
                    session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                    continue;
                }
                if (!exitReason) {
                    session.client.closeClaudeSessionTurn('failed');
                    session.client.sendSessionEvent({ type: 'message', message: launchFailureMessage(e) });
                    continue;
                }
            } finally {

                logger.debug('[remote]: launch finally');
                safeIdle = true;
                releaseForegroundTasks(backgroundTasks);

                // Terminate all ongoing tool calls
                for (let [toolCallId, { parentToolCallId }] of ongoingToolCalls) {
                    const converted = sdkToLogConverter.generateInterruptedToolResult(toolCallId, parentToolCallId);
                    if (converted) {
                        logger.debug('[remote]: terminating tool call ' + toolCallId + ' parent: ' + parentToolCallId);
                        session.client.sendClaudeSessionMessage(converted);
                    }
                }
                ongoingToolCalls.clear();

                // Flush any remaining messages in the queue
                logger.debug('[remote]: flushing message queue');
                await messageQueue.flush();
                messageQueue.destroy();
                logger.debug('[remote]: message queue flushed');

                // Reset abort controller and future
                abortController = null;
                abortFuture?.resolve(undefined);
                abortFuture = null;
                logger.debug('[remote]: launch done');
                permissionHandler.reset();
                modeHash = null;
                mode = null;
                if (!exitReason) await refresh.drain();
            }
        }
    } finally {
        stopWatchingConfiguration();
        session.client.rpcHandlerManager.unregisterHandler('configure-session');
        session.client.rpcHandlerManager.unregisterHandler('cancel-session-refresh');
        if ((exitReason as 'switch' | 'exit' | null) === 'switch') await session.client.updateMetadata(m => ({ ...m,
            sessionCapabilities: { ...engineCapabilities('claude'), refresh: false, runtimeConfiguration: false },
            ...(refresh.pending ? { sessionConfigState: 'error' as const, sessionConfigError: '已切换至本地终端，取消待执行刷新', sessionConfigUpdatedAt: Date.now() } : {}),
        }));
        // Clean up permission handler
        permissionHandler.reset();

        // Reset Terminal
        const t0 = Date.now();
        logger.debug(`[remote]: cleanup begin exitReason=${exitReason} hasInk=${!!inkInstance} rawMode=${(process.stdin as any).isRaw}`);
        if (inkInstance) {
            inkInstance.unmount();
        }
        logger.debug(`[remote]: ink.unmount() done +${Date.now() - t0}ms rawMode=${(process.stdin as any).isRaw}`);

        // Drain any keystrokes that landed in stdin while Ink owned it (e.g.
        // extra spaces from the double-space switch confirmation, or anything
        // typed before the user perceives that the switch has completed) so
        // they don't leak into the next interactive child process when local
        // mode takes stdin back via stdio: 'inherit'. Raw mode stays on for
        // the whole window so the kernel does not echo any in-flight bytes
        // at whatever screen position Ink last left the cursor.
        await cleanupStdinAfterInk({
            stdin: process.stdin,
            drainMs: 150,
            onDebug: (event) => {
                logger.debug(`[remote]: stdin drain ${event.bytes}B / ${event.chunks} chunk(s) +${Date.now() - t0}ms`);
            },
        });
        logger.debug(`[remote]: cleanup done +${Date.now() - t0}ms rawMode=${(process.stdin as any).isRaw}`);
        messageBuffer.clear();

        // Resolve abort future
        if (abortFuture) { // Just in case of error
            abortFuture.resolve(undefined);
        }
    }

    return exitReason || 'exit';
}

/**
 * Detect the image media type Claude accepts from the decrypted blob's
 * magic-byte header. The wire-supplied mimeType is unreliable (iOS picker
 * reports things like "image/heic" or no value at all), and the Anthropic
 * API enforces a strict enum on `image.source.base64.media_type`. Returning
 * null when the bytes don't match a supported format causes the caller to
 * drop the attachment instead of shipping an invalid request that the API
 * rejects with HTTP 400.
 */
function detectClaudeImageMime(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
        return 'image/png';
    }
    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return 'image/jpeg';
    }
    if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        return 'image/gif';
    }
    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
        return 'image/webp';
    }
    return null;
}
