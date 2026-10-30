import { assertSessionReconnectAvailable } from '@/daemon/controlClient';
import { SessionOwnershipConflict } from '@/daemon/sessionOwnership';
/**
 * Agy Session Runner
 *
 * Entry point for agy (Antigravity CLI) agent sessions, following the runOpenClaw.ts
 * pattern. The daemon spawns this as:
 *   `node dist/index.mjs agy --happy-starting-mode remote --started-by daemon`
 *
 * This drives an AgyBackend that spawns structured `agy --print` per turn and
 * forwards its AgentMessage stream through the
 * same session pipeline used by the other backends.
 */

import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import React from 'react';
import { render, type Instance as InkInstance } from 'ink';
import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import { AcpSessionManager } from '@/agent/acp/AcpSessionManager';
import type { SessionEnvelope } from 'lmc-wire';
import { logger } from '@/ui/logger';
import { attachQueuePublisher, applyQueueModeRequest, bindQueuedReportConsumer, registerQueueControlHandlers } from '@/utils/sessionQueueControl';
import { readMessageIntent } from '@/utils/queueControlRequest';
import { createAgyTurnQueue, resolveAgyTurnMode } from './turnQueue';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import type { Session as ApiSession } from '@/api/types';
import { UNKNOWN_RECONNECT_REVISION, refreshSessionRuntimeMetadata } from '@/utils/sessionRuntimeMetadata';
import { consumePendingHandoff, createHandoffPort } from '@/utils/handoffPort';
import { agySessionRefresh } from './sessionRefresh';
import { decodeBase64, encodeBase64 } from '@/api/encryption';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { connectionState } from '@/utils/serverConnectionErrors';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { AgyDisplay } from '@/ui/ink/AgyDisplay';
import type { AgentMessage } from '@/agent/core';
import { normalizeRemotePermissionMode } from '@/claude/utils/permissionMode';
import { AgyBackend } from './AgyBackend';
import { inspectAgyCli } from './preflight';
import { getSharedRuntime } from '@/daemon/sharedRuntime';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { projectPath } from '@/projectPath';
import { readModelCatalogs } from '@/runtime/modelCatalogCache';
import { discoverAgyModels } from './modelDiscovery';
import { resolveAgySelection } from './modelSelection';
import { watchSessionConfiguration, WorkerConfigValidationError } from '@/modules/orchestration/workerConfig';
import { startAgentMail } from '@/modules/agentMail/agentMailLoop';
import { prepareAgyAttachmentPrompt, registerAgyAttachments } from './attachments';
import { AgyContextUsageTracker } from './contextUsage';
import { reportSessionRefreshFailure } from '@/codex/reportSessionRefreshFailure';

export interface RunAgyOptions {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  verbose?: boolean;
  model?: string;
  effort?: string;
  permissionMode?: string;
  resume?: string;
}

export async function runAgy(opts: RunAgyOptions): Promise<'stopped' | 'refresh-handoff' | 'killed'> {
  if (!inspectAgyCli().readyForSignIn) throw new Error('Antigravity CLI is missing or incompatible. Install the current official CLI and run lmc agy --check.');
  let modelCatalog = readModelCatalogs().agy;
  const currentCatalog = () => {
    const cached = readModelCatalogs().agy;
    if (cached && !cached.stale && cached.capturedAt > (modelCatalog?.capturedAt ?? 0)) modelCatalog = cached;
    return modelCatalog;
  };
  let initialSelection;
  try { initialSelection = resolveAgySelection(opts.model, opts.effort, modelCatalog); }
  catch {
    modelCatalog = await discoverAgyModels();
    initialSelection = resolveAgySelection(opts.model, opts.effort, modelCatalog);
  }
  const verbose = opts.verbose === true;
  const sessionTag = randomUUID();
  connectionState.setBackend('agy');

  const log = (msg: string) => {
    logger.debug(`[agy] ${msg}`);
    if (verbose) {
      console.log(`[agy] ${msg}`);
    }
  };

  const api = await ApiClient.create(opts.credentials);
  const settings = await readSettings();
  if (!settings?.machineId) {
    throw new Error('No machine ID found in settings');
  }

  await api.getOrCreateMachine({
    machineId: settings.machineId,
    metadata: initialMachineMetadata,
  });

  const { state, metadata } = createSessionMetadata({
    flavor: 'agy',
    machineId: settings.machineId,
    startedBy: opts.startedBy,
  });
  metadata.agentBuild = createHash('sha256').update(readFileSync(join(projectPath(), 'dist', 'index.mjs'))).digest('hex');
  metadata.modelMode = initialSelection.model;
  metadata.effortLevel = initialSelection.effort;
  metadata.permissionMode = normalizeRemotePermissionMode(opts.permissionMode) ?? 'default';
  metadata.sessionCapabilities = { refresh: true, cancelRefresh: true, engineHandoff: true,
    authentication: false, runtimeConfiguration: false, modelDiscovery: true, model: true, effort: true, resume: true,
    turnQueue: true, turnSteer: false, turnQueueLifecycle: true, fileInbox: true, largeFiles: true };
  const reconnectId = process.env.HAPPY_RECONNECT_SESSION_ID;
    if (reconnectId) await assertSessionReconnectAvailable(reconnectId);
  const key = process.env.HAPPY_RECONNECT_ENCRYPTION_KEY;
  const variant = process.env.HAPPY_RECONNECT_ENCRYPTION_VARIANT;
  let response: ApiSession | null;
  if (reconnectId) {
    if (!key || (variant !== 'legacy' && variant !== 'dataKey')) throw new Error('Invalid session reconnect identity');
    response = { id: reconnectId, seq: Number(process.env.HAPPY_RECONNECT_SEQ ?? 0), metadata,
      metadataVersion: UNKNOWN_RECONNECT_REVISION, agentState: state, agentStateVersion: UNKNOWN_RECONNECT_REVISION,
      encryptionKey: decodeBase64(key), encryptionVariant: variant };
  } else response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
  if (response) {
    log(`Happy Session ID: ${response.id}`);
  }

  if (response) {
    try {
      await notifyDaemonSessionStarted(response.id, metadata, {
        encryptionKey: encodeBase64(response.encryptionKey),
        encryptionVariant: response.encryptionVariant,
        seq: response.seq,
        metadataVersion: response.metadataVersion,
        agentStateVersion: response.agentStateVersion,
      });
    } catch (error) {
        if (error instanceof SessionOwnershipConflict) throw error;
      logger.debug('[agy] Failed to report session to daemon:', error);
    }
  }

  let session: ApiSessionClient;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      session = newSession;
      void session.updateMetadata(m => ({ ...m, sessionCapabilities: { ...metadata.sessionCapabilities!, refresh: false, engineHandoff: false, cancelRefresh: false } }));
    },
  });
  session = initialSession;
  if (reconnectId) {
    session.suppressNextArchiveSignal();
    const cursor = process.env.HAPPY_REFRESH_RECEIVE_SEQ;
    if (cursor !== undefined) session.resumeIncomingMessagesFrom(Number(cursor));
    else session.skipExistingMessages();
    await session.updateMetadata(m => ({ ...refreshSessionRuntimeMetadata(m, metadata),
      sessionCapabilities: metadata.sessionCapabilities, agentBuild: metadata.agentBuild, modelMode: metadata.modelMode, effortLevel: metadata.effortLevel,
      permissionMode: metadata.permissionMode, sessionConfigState: 'verifying', sessionConfigError: undefined,
      sessionConfigUpdatedAt: Date.now(), lifecycleState: 'running', archivedBy: undefined }));
  }


  const sessionManager = new AcpSessionManager();
  const messageQueue = createAgyTurnQueue();
  attachQueuePublisher(messageQueue, session, session.getMetadata()?.queueMode);
  const consumeQueuedReport = bindQueuedReportConsumer(messageQueue);
  let shouldExit = false;
  let refreshHandoff = false;
  let archiveRequested = false;
  let abortController = new AbortController();
  let thinking = false;
  let turnActive = false;

  let usageTurn = { id: '', model: null as string | null, startedAt: 0 };
  let displayedModel = initialSelection.model;
  let currentEffort = initialSelection.effort;
  let permissionMode = normalizeRemotePermissionMode(opts.permissionMode) ?? 'default';
  const handoff = createHandoffPort(session, 'Antigravity', 'agy', () => {
    const id = session.getMetadata()?.agyConversationId;
    return id ? { engine: 'Antigravity', id } : null;
  });
  const refresh = agySessionRefresh(session, handoff, {
    idle: () => !turnActive && messageQueue.size() === 0,
    settings: () => ({ model: displayedModel, effort: currentEffort, permissionMode }),
    configureQueue: request => applyQueueModeRequest(request, messageQueue, session),
    exit: () => { refreshHandoff = true; shouldExit = true; messageQueue.close(); abortController.abort(); },
  });
  const nativeEnvironment: NodeJS.ProcessEnv = {
    LMC_AGY_MCP_MODULE: join(projectPath(), 'dist', 'codex', 'happyMcpStdioBridge.mjs'),
  };
  let activeConversationId: string | undefined =
    opts.resume ??
    (getSharedRuntime()?.resume && typeof getSharedRuntime()?.metadata.agyConversationId === 'string'
      ? (getSharedRuntime()!.metadata.agyConversationId as string)
      : undefined) ??
    (reconnectId && typeof session.getMetadata()?.agyConversationId === 'string'
      ? session.getMetadata()!.agyConversationId
      : undefined);
  const contextUsage = new AgyContextUsageTracker();
  const backend = new AgyBackend({
    conversationId: activeConversationId,
    cwd: process.cwd(),
    permissionMode,
    model: displayedModel,
    onConversationId: id => {
      activeConversationId = id;
      session.updateMetadata(m => ({ ...m, agyConversationId: id }));
    },
    env: nativeEnvironment,
    log,
  });

  const applySelection = (model: string | null | undefined, effort: string | null | undefined) => {
    const selected = resolveAgySelection(model, effort, currentCatalog());
    displayedModel = selected.model;
    currentEffort = selected.effort;
  };
  const stopWatchingConfiguration = watchSessionConfiguration(session, 'agy', patch => {
    if (patch.modelMode !== undefined || patch.effortLevel !== undefined) {
      applySelection(patch.modelMode !== undefined ? patch.modelMode : displayedModel,
        patch.effortLevel !== undefined ? patch.effortLevel : patch.modelMode !== undefined ? undefined : currentEffort);
    }
    if (patch.permissionMode !== undefined) {
      permissionMode = normalizeRemotePermissionMode(patch.permissionMode ?? undefined) ?? 'default';
    }
  });

  // Terminal UI (only with a real TTY; the daemon runs headless).
  const messageBuffer = new MessageBuffer();
  const hasTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  let inkInstance: InkInstance | null = null;

  const sendEnvelopes = (envelopes: SessionEnvelope[]) => {
    for (const envelope of envelopes) {
      session.sendSessionProtocolMessage(envelope);
    }
  };

  const onBackendMessage = (msg: AgentMessage) => {
    if (verbose) {
      log(`Backend message: ${JSON.stringify(msg).slice(0, 200)}`);
    }

    if (msg.type === 'token-count' && msg.scope === 'step' && typeof msg.usageKey === 'string') {
      session.recordAgyUsage(msg.usage, msg.usageKey, usageTurn.model, usageTurn.startedAt);
      const colonIndex = msg.usageKey.indexOf(':');
      const stepConversationId = colonIndex > 0 ? msg.usageKey.slice(0, colonIndex) : activeConversationId;
      if (stepConversationId) activeConversationId = stepConversationId;
      const usageEnvelope = contextUsage.buildStepUsageEnvelope(
        msg.usage,
        stepConversationId,
        usageTurn.model ?? displayedModel,
      );
      if (usageEnvelope) sendEnvelopes([usageEnvelope]);
      return;
    }
    if (msg.type === 'token-count') {
      const reconciled = contextUsage.reconcileTurnEndEnvelope(
        activeConversationId,
        usageTurn.model ?? displayedModel,
      );
      if (reconciled) sendEnvelopes([reconciled]);
      return;
    }
    if (msg.type === 'model-output' && msg.textDelta) {
      messageBuffer.addMessage(msg.textDelta, 'assistant');
    } else if (msg.type === 'status') {
      const nextThinking = msg.status === 'running';
      if (thinking !== nextThinking) {
        thinking = nextThinking;
        session.keepAlive(thinking, 'remote');
      }
      if (msg.status === 'error' && msg.detail) {
        messageBuffer.addMessage(`Error: ${msg.detail}`, 'status');
        sendEnvelopes(sessionManager.mapMessage({ type: 'model-output', textDelta: `\nAntigravity: ${msg.detail}\n` }));
      }
    }

    sendEnvelopes(sessionManager.mapMessage(msg));
  };

  backend.onMessage(onBackendMessage);

  if (hasTTY) {
    const DisplayComponent = () =>
      React.createElement(AgyDisplay, {
        messageBuffer,
        logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
        currentModel: displayedModel,
        onExit: async () => {
          logger.debug('[agy] Exiting agent via Ctrl-C');
          shouldExit = true;
          await handleAbort();
        },
      });

    inkInstance = render(React.createElement(DisplayComponent), {
      exitOnCtrlC: false,
      patchConsole: false,
    });
    messageBuffer.addMessage(`[MODEL:${displayedModel}]`, 'system');

    process.stdin.resume();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding('utf8');
  }

  registerAgyAttachments(session, process.cwd());
  session.onUserMessage(async (message) => {
    const mode = resolveAgyTurnMode(message.meta, { model: displayedModel, effort: currentEffort, permissionMode }, currentCatalog());
    const prompt = await prepareAgyAttachmentPrompt(session, message.content.text ?? '', process.cwd());
    if (!prompt.trim()) return;
    displayedModel = mode.model;
    currentEffort = mode.effort;
    permissionMode = mode.permissionMode;
    messageBuffer.addMessage(message.content.text, 'user');
    const intent = readMessageIntent(message.meta);
    if (intent === 'interrupt') {
      messageQueue.unshift(prompt, mode, undefined, { key: message.localKey });
      if (turnActive) await handleAbort();
    } else {
      messageQueue.push(prompt, mode, undefined, { key: message.localKey });
      if (intent === 'steer' && turnActive) session.sendSessionEvent({ type: 'message', message: 'Antigravity 原生 CLI 暂不支持向执行中的回合追加消息，已排队等待下一轮。' });
    }
  });
  const agentMail = startAgentMail(session, opts.credentials.token, () => {
    const meta = session.getMetadata();
    return { machine: meta?.name || meta?.host || settings.machineId!, engine: 'Antigravity',
      title: meta?.summary?.text || meta?.path?.split(/[\\/]/).pop() || 'session', path: meta?.path };
  }, async (config, metadata) => {
    if (!config.model && !config.effort) return;
    const model = config.model ?? metadata.modelMode;
    const effort = config.effort ?? (config.model ? undefined : metadata.effortLevel);
    try { resolveAgySelection(model, effort, currentCatalog()); }
    catch {
      try {
        modelCatalog = await discoverAgyModels();
        resolveAgySelection(model, effort, modelCatalog);
      } catch { throw new WorkerConfigValidationError('无法确认所选 Antigravity 模型和思考深度，请检查这台设备的原生模型目录后重试。'); }
    }
  });
  const happyServer = await startHappyServer(session, agentMail.mail, handoff, {
    cwd: process.cwd(),
    machineId: settings.machineId,
    pollMail: () => agentMail.pollNow(),
    consumeQueuedReport,
  });
  nativeEnvironment.HAPPY_HTTP_MCP_URL = happyServer.url;
  session.keepAlive(thinking, 'remote');

  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 2000);

  async function handleAbort() {
    log('Abort requested');
    try {
      await backend.cancel();
    } catch (error) {
      logger.debug('[agy] Abort failed:', error);
    }
    thinking = false;
    session.keepAlive(false, 'remote');
    abortController.abort();
    abortController = new AbortController();
  }

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerQueueControlHandlers(session, messageQueue, { isBusy: () => turnActive, interrupt: handleAbort });
  registerKillSessionHandler(session.rpcHandlerManager, async () => {
    archiveRequested = true;
    shouldExit = true;
    messageQueue.close();
    await handleAbort();
  });

  try {
    await backend.startSession();
    log('Backend ready');
    await session.updateMetadata(m => ({ ...m, sessionConfigState: 'applied', sessionConfigError: undefined, sessionConfigUpdatedAt: Date.now() }));
    if (activeConversationId) {
      const resumedUsage = contextUsage.buildResumeUsageEnvelope(activeConversationId, displayedModel);
      if (resumedUsage) sendEnvelopes([resumedUsage]);
    }
    const inherited = await consumePendingHandoff(session);
    if (inherited) {
      session.sendSessionEvent({ type: 'engine-handoff', ...inherited });
      session.sendUserTextMessage(inherited.briefing, { displayText: `[handoff from ${inherited.from}]` });
    }

    while (!shouldExit) {
      const waitSignal = abortController.signal;
      const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
      if (!batch) {
        if (shouldExit) break;
        if (waitSignal.aborted) continue;
        break;
      }

      turnActive = true;
      backend.setModel(batch.mode.model);
      backend.setPermissionMode(batch.mode.permissionMode);
      if (hasTTY) messageBuffer.addMessage(`[MODEL:${batch.mode.model}]`, 'system');
      usageTurn = { id: randomUUID(), model: batch.mode.model, startedAt: Date.now() };
      contextUsage.startTurn();
      log(`Incoming prompt: ${batch.message.slice(0, 200)}`);
      sendEnvelopes(sessionManager.startTurn());
      try {
        await backend.sendPrompt(process.cwd(), batch.message);
        sendEnvelopes(sessionManager.endTurn('completed'));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log(`Turn ended: ${msg}`);
        sendEnvelopes(sessionManager.endTurn('failed'));
      }
      thinking = false;
      session.keepAlive(false, 'remote');
      session.sendSessionEvent({ type: 'ready' });
      turnActive = false;
      await refresh.drain();
    }
  } catch (error) {
    if (process.env.HAPPY_REFRESH_RECEIVE_SEQ !== undefined) {
      const report = await reportSessionRefreshFailure(error, updater => session.updateMetadata(updater));
      if (report !== 'reported') logger.debug(`[agy] Session refresh failure reporting ${report}; continuing cleanup`);
    }
    throw error;
  } finally {
    agentMail.stop();
    stopWatchingConfiguration();
    clearInterval(keepAliveInterval);
    reconnectionHandle?.cancel();

    backend.offMessage(onBackendMessage);
    await backend.dispose();
    happyServer.stop();
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch {}
    }
    if (hasTTY) {
      try { process.stdin.pause(); } catch {}
    }
    inkInstance?.unmount();
    messageBuffer.clear();

    try {
      // Backend failure or normal shutdown must not archive a session.
      if (archiveRequested) {
        session.updateMetadata((currentMetadata) => ({
          ...currentMetadata,
          lifecycleState: 'archived',
          lifecycleStateSince: Date.now(),
          archivedBy: 'cli',
          archiveReason: 'User terminated',
        }));
      }
      session.sendSessionDeath();
      await session.flush();
      await session.close();
    } catch (error) {
      logger.debug('[agy] Session close failed:', error);
    }
  }

  return refreshHandoff ? 'refresh-handoff' : archiveRequested ? 'killed' : 'stopped';
}
