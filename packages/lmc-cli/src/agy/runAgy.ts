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
import type { Metadata, Session as ApiSession } from '@/api/types';
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
import { isAgyTurnCancelledError } from './stream';
import { getSharedRuntime } from '@/daemon/sharedRuntime';
import { prepareAgySharedAccountIsolation } from '@/daemon/sharedAccountIsolation';
import { configuration } from '@/configuration';
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

export class AgyRunnerShutdownPersistenceError extends Error {
  readonly causeError: unknown;
  readonly retryShutdown: () => Promise<{ refreshHandoff: boolean }>;

  constructor(
    causeError: unknown,
    retryShutdown: () => Promise<{ refreshHandoff: boolean }>,
  ) {
    const detail = causeError instanceof Error ? causeError.message : String(causeError);
    super(`Antigravity runner shutdown blocked on unacknowledged usage persistence: ${detail}`);
    this.name = 'AgyRunnerShutdownPersistenceError';
    this.causeError = causeError;
    this.retryShutdown = retryShutdown;
  }
}

export interface FinalizeAgyRunnerShutdownSession {
  updateMetadata: (
    updater: (metadata: Metadata) => Metadata,
    opts?: { strict?: boolean },
  ) => Promise<void> | void;
  sendSessionDeath: () => void;
  flush: () => Promise<void>;
  close: () => Promise<void>;
}

export interface FinalizeAgyRunnerShutdownParams {
  backend: Pick<
    AgyBackend,
    | 'dispose'
    | 'offMessage'
    | 'transferUnpersistedHandoffs'
    | 'hasUnconfirmedChildExit'
    | 'hasUnpersistedCloseState'
  >;
  onBackendMessage: (msg: AgentMessage) => void;
  getSession: () => FinalizeAgyRunnerShutdownSession;
  persistFallbackHandoff?: (
    conversationId: string,
    serializedHandoff: string | null,
  ) => Promise<void>;
  archiveRequested: boolean;
  refreshHandoff: boolean;
  onAfterBackendSettled?: () => void;
}

export async function finalizeAgyRunnerShutdown(
  params: FinalizeAgyRunnerShutdownParams,
): Promise<{ refreshHandoff: boolean }> {
  let effectiveRefreshHandoff = params.refreshHandoff;
  let disposeError: unknown = null;

  try {
    await params.backend.dispose();
  } catch (firstErr) {
    disposeError = firstErr;
    if (params.backend.hasUnconfirmedChildExit) {
      effectiveRefreshHandoff = false;
      logger.debug('[agy] Backend dispose failed with unconfirmed child exit:', firstErr);
    }

    if (params.backend.hasUnpersistedCloseState || !params.backend.hasUnconfirmedChildExit) {
      try {
        await params.backend.dispose();
        disposeError = null;
      } catch (retryErr) {
        disposeError = retryErr;
        if (params.backend.hasUnconfirmedChildExit) {
          effectiveRefreshHandoff = false;
        }
        let transferred = false;
        if (!params.backend.hasUnconfirmedChildExit && params.persistFallbackHandoff) {
          try {
            transferred = await params.backend.transferUnpersistedHandoffs(
              params.persistFallbackHandoff,
            );
          } catch (transferErr) {
            logger.debug('[agy] Fallback usage handoff transfer failed:', transferErr);
            transferred = false;
          }
        }
        if (transferred) {
          disposeError = null;
        } else if (
          params.backend.hasUnpersistedCloseState ||
          !params.backend.hasUnconfirmedChildExit
        ) {
          // Do NOT detach `onBackendMessage` or close `session` while required usage
          // persistence/transfer remains unacknowledged; keep the live owner retryable!
          throw new AgyRunnerShutdownPersistenceError(retryErr, () =>
            finalizeAgyRunnerShutdown({
              ...params,
              refreshHandoff: effectiveRefreshHandoff,
            }),
          );
        }
      }
    }
  }

  params.backend.offMessage(params.onBackendMessage);
  params.onAfterBackendSettled?.();

  const currentSession = params.getSession();
  try {
    // Backend failure or normal shutdown must not archive a session.
    if (params.archiveRequested && !disposeError) {
      await currentSession.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        lifecycleState: 'archived',
        lifecycleStateSince: Date.now(),
        archivedBy: 'cli',
        archiveReason: 'User terminated',
      }));
    }
    if (!disposeError) {
      currentSession.sendSessionDeath();
    }
    await currentSession.flush();
    await currentSession.close();
  } catch (error) {
    logger.debug('[agy] Session close failed:', error);
  }

  if (disposeError) {
    throw disposeError;
  }

  return { refreshHandoff: effectiveRefreshHandoff };
}

export async function runAgy(opts: RunAgyOptions): Promise<'stopped' | 'refresh-handoff' | 'killed'> {
  const cliInfo = inspectAgyCli();
  if (!cliInfo.readyForSignIn) throw new Error('Antigravity CLI is missing or incompatible. Install the current official CLI and run lmc agy --check.');
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
  let autonomousTurnActive = false;
  let autonomousCancelRequested = false;
  const autonomousSettledWaiters: Array<() => void> = [];
  const notifyAutonomousTurnSettled = () => {
    if (autonomousSettledWaiters.length === 0) return;
    const waiters = autonomousSettledWaiters.splice(0, autonomousSettledWaiters.length);
    for (const resolve of waiters) {
      resolve();
    }
  };
  const waitForAutonomousTurnSettled = (signal: AbortSignal): Promise<void> => {
    if (!autonomousTurnActive || shouldExit || signal.aborted) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const done = () => {
        signal.removeEventListener('abort', done);
        resolve();
      };
      signal.addEventListener('abort', done, { once: true });
      autonomousSettledWaiters.push(done);
    });
  };

  let usageTurn = { id: '', model: null as string | null, startedAt: 0 };
  let displayedModel = initialSelection.model;
  let currentEffort = initialSelection.effort;
  let permissionMode = normalizeRemotePermissionMode(opts.permissionMode) ?? 'default';
  const handoff = createHandoffPort(session, 'Antigravity', 'agy', () => {
    const id = session.getMetadata()?.agyConversationId;
    return id ? { engine: 'Antigravity', id } : null;
  });
  const refresh = agySessionRefresh(session, handoff, {
    idle: () => !turnActive && !autonomousTurnActive && messageQueue.size() === 0,
    settings: () => ({ model: displayedModel, effort: currentEffort, permissionMode }),
    retireBackend: () => backend.closeForHandoff(),
    configureQueue: request => applyQueueModeRequest(request, messageQueue, session),
    exit: () => { refreshHandoff = true; shouldExit = true; messageQueue.close(); abortController.abort(); notifyAutonomousTurnSettled(); },
  });
  const sharedRuntime = getSharedRuntime();
  const agyIsolation = sharedRuntime
    ? prepareAgySharedAccountIsolation({
        accountId: sharedRuntime.accountId,
        workspaceDir: process.cwd(),
        lmcHomeDir: configuration.lmcHomeDir,
      })
    : null;
  const nativeEnvironment: NodeJS.ProcessEnv = {
    ...(agyIsolation?.env ?? {}),
    LMC_AGY_MCP_MODULE: join(projectPath(), 'dist', 'codex', 'happyMcpStdioBridge.mjs'),
  };
  let activeConversationId: string | undefined =
    opts.resume ??
    (sharedRuntime?.resume && typeof sharedRuntime.metadata.agyConversationId === 'string'
      ? (sharedRuntime.metadata.agyConversationId as string)
      : undefined) ??
    (reconnectId && typeof session.getMetadata()?.agyConversationId === 'string'
      ? session.getMetadata()!.agyConversationId
      : undefined);
  const contextUsage = new AgyContextUsageTracker(
    agyIsolation ? { agyHomeDir: agyIsolation.agyCliHomeDir } : undefined,
  );
  const persistFallbackHandoff = async (
    conversationId: string,
    serializedHandoff: string | null,
  ): Promise<void> => {
    await session.updateMetadata(
      (m) => {
        const next = { ...(m.agyUsageHandoffs ?? {}) };
        if (serializedHandoff === null) {
          delete next[conversationId];
        } else {
          next[conversationId] = serializedHandoff;
        }
        return {
          ...m,
          agyUsageHandoffs: Object.keys(next).length > 0 ? next : undefined,
        };
      },
      { strict: true },
    );
  };
  const backend = new AgyBackend({
    conversationId: activeConversationId,
    cwd: process.cwd(),
    permissionMode,
    model: displayedModel,
    transport: cliInfo.supportsAcp === false ? 'print' : undefined,
    onConversationId: id => {
      activeConversationId = id;
      session.updateMetadata(m => ({ ...m, agyConversationId: id }));
    },
    confirmUsageDurable: () => session.ensureUsageDurable(),
    loadFallbackHandoff: (id) => session.getMetadata()?.agyUsageHandoffs?.[id] ?? null,
    persistFallbackHandoff,
    env: nativeEnvironment,
    agyHomeDir: agyIsolation?.agyCliHomeDir,
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
      const hasExplicitModel = 'usageModel' in msg && (typeof msg.usageModel === 'string' || msg.usageModel === null);
      const stepModel = hasExplicitModel
        ? (typeof msg.usageModel === 'string' && msg.usageModel ? msg.usageModel : null)
        : usageTurn.model;
      const hasExplicitStartedAt = 'usageStartedAt' in msg;
      const stepStartedAt = hasExplicitStartedAt
        ? (typeof msg.usageStartedAt === 'number' && Number.isFinite(msg.usageStartedAt) && msg.usageStartedAt > 0
            ? msg.usageStartedAt
            : undefined)
        : (usageTurn.startedAt || undefined);
      session.recordAgyUsage(msg.usage, msg.usageKey, stepModel, stepStartedAt);
      const colonIndex = msg.usageKey.indexOf(':');
      const stepConversationId = colonIndex > 0 ? msg.usageKey.slice(0, colonIndex) : activeConversationId;
      if (stepConversationId) activeConversationId = stepConversationId;
      // Accounting adjustments (such as multi-step turn residuals) pass `contextUsage: null`
      // so they never inflate the single-generation context window gauge, while credit-adjusted
      // SQLite steps pass `contextUsage: rawStepUsage` to report true context fill.
      if (msg.contextUsage !== null) {
        const rawContextUsage =
          msg.contextUsage !== undefined && typeof msg.contextUsage === 'object'
            ? msg.contextUsage
            : msg.usage;
        const contextModel = hasExplicitModel
          ? stepModel
          : (usageTurn.model ?? displayedModel);
        const usageEnvelope = contextUsage.buildStepUsageEnvelope(
          rawContextUsage,
          stepConversationId,
          contextModel,
          {
            genIdx: typeof msg.genIdx === 'number' ? msg.genIdx : undefined,
            stepIndex: typeof msg.stepIndex === 'number' ? msg.stepIndex : undefined,
            contextWindowTokens:
              typeof msg.contextWindowTokens === 'number' ? msg.contextWindowTokens : undefined,
            belongsToCurrentTurn:
              typeof msg.belongsToCurrentTurn === 'boolean' ? msg.belongsToCurrentTurn : undefined,
          },
        );
        if (usageEnvelope) sendEnvelopes([usageEnvelope]);
      }
      return;
    }
    if (msg.type === 'token-count' && msg.scope === 'context') {
      const stepConversationId =
        typeof msg.conversationId === 'string' && msg.conversationId
          ? msg.conversationId
          : activeConversationId;
      if (stepConversationId) activeConversationId = stepConversationId;
      const hasExplicitModel = 'usageModel' in msg && (typeof msg.usageModel === 'string' || msg.usageModel === null);
      const contextModel = hasExplicitModel
        ? (typeof msg.usageModel === 'string' && msg.usageModel ? msg.usageModel : null)
        : (usageTurn.model ?? displayedModel);
      const usageEnvelope = contextUsage.buildStepUsageEnvelope(
        msg.usage,
        stepConversationId,
        contextModel,
        {
          genIdx: typeof msg.genIdx === 'number' ? msg.genIdx : undefined,
          contextWindowTokens:
            typeof msg.contextWindowTokens === 'number' ? msg.contextWindowTokens : undefined,
          belongsToCurrentTurn:
            typeof msg.belongsToCurrentTurn === 'boolean' ? msg.belongsToCurrentTurn : undefined,
        },
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
      if (msg.status === 'running' && !turnActive && !autonomousTurnActive) {
        autonomousTurnActive = true;
        autonomousCancelRequested = false;
        usageTurn = { id: randomUUID(), model: displayedModel, startedAt: Date.now() };
        contextUsage.startTurn();
        sendEnvelopes(sessionManager.startTurn());
        abortController.abort();
        abortController = new AbortController();
      }
      if (msg.status === 'error' && msg.detail) {
        messageBuffer.addMessage(`Error: ${msg.detail}`, 'status');
        sendEnvelopes(sessionManager.mapMessage({ type: 'model-output', textDelta: `\nAntigravity: ${msg.detail}\n` }));
      }
      if ((msg.status === 'idle' || msg.status === 'error') && !turnActive && autonomousTurnActive) {
        const endStatus =
          msg.status === 'error'
            ? 'failed'
            : autonomousCancelRequested
              ? 'cancelled'
              : 'completed';
        autonomousTurnActive = false;
        autonomousCancelRequested = false;
        sendEnvelopes(sessionManager.endTurn(endStatus));
        session.sendSessionEvent({ type: 'ready' });
        notifyAutonomousTurnSettled();
        void refresh.drain();
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
      if (turnActive || autonomousTurnActive) await handleAbort();
    } else {
      messageQueue.push(prompt, mode, undefined, { key: message.localKey });
      if (intent === 'steer' && (turnActive || autonomousTurnActive)) session.sendSessionEvent({ type: 'message', message: 'Antigravity 原生 CLI 暂不支持向执行中的回合追加消息，已排队等待下一轮。' });
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
  agyIsolation?.syncWorkspaceMcpConfig();
  session.keepAlive(thinking, 'remote');

  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 2000);

  async function handleAbort() {
    log('Abort requested');
    if (autonomousTurnActive && !turnActive) {
      autonomousCancelRequested = true;
    }
    try {
      await backend.cancel();
    } catch (error) {
      logger.debug('[agy] Abort failed:', error);
    }
    thinking = false;
    session.keepAlive(false, 'remote');
    abortController.abort();
    abortController = new AbortController();
    notifyAutonomousTurnSettled();
  }

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerQueueControlHandlers(session, messageQueue, { isBusy: () => turnActive || autonomousTurnActive, interrupt: handleAbort });
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
      while (autonomousTurnActive && !shouldExit) {
        await waitForAutonomousTurnSettled(abortController.signal);
      }
      if (shouldExit) break;
      const waitSignal = abortController.signal;
      const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
      if (!batch) {
        if (shouldExit) break;
        if (waitSignal.aborted) continue;
        break;
      }

      if (autonomousTurnActive) {
        autonomousTurnActive = false;
        autonomousCancelRequested = false;
        notifyAutonomousTurnSettled();
      }
      turnActive = true;
      backend.setModel(batch.mode.model);
      backend.setPermissionMode(batch.mode.permissionMode);
      if (hasTTY) messageBuffer.addMessage(`[MODEL:${batch.mode.model}]`, 'system');
      usageTurn = { id: randomUUID(), model: batch.mode.model, startedAt: Date.now() };
      backend.setTurnStartedAt(usageTurn.startedAt);
      contextUsage.startTurn();
      log(`Incoming prompt: ${batch.message.slice(0, 200)}`);
      sendEnvelopes(sessionManager.startTurn());
      try {
        agyIsolation?.syncWorkspaceMcpConfig();
        await backend.sendPrompt(process.cwd(), batch.message);
        sendEnvelopes(sessionManager.endTurn('completed'));
      } catch (error) {
        if (isAgyTurnCancelledError(error)) {
          log('Turn cancelled');
          sendEnvelopes(sessionManager.endTurn('cancelled'));
        } else {
          const msg = error instanceof Error ? error.message : String(error);
          log(`Turn ended: ${msg}`);
          sendEnvelopes(sessionManager.endTurn('failed'));
        }
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

    let afterSettledCleaned = false;
    const shutdownOutcome = await finalizeAgyRunnerShutdown({
      backend,
      onBackendMessage,
      getSession: () => session,
      persistFallbackHandoff,
      archiveRequested,
      refreshHandoff,
      onAfterBackendSettled: () => {
        if (afterSettledCleaned) return;
        afterSettledCleaned = true;
        reconnectionHandle?.cancel();
        happyServer.stop();
        if (process.stdin.isTTY) {
          try { process.stdin.setRawMode(false); } catch {}
        }
        if (hasTTY) {
          try { process.stdin.pause(); } catch {}
        }
        inkInstance?.unmount();
        messageBuffer.clear();
      },
    });
    refreshHandoff = shutdownOutcome.refreshHandoff;
  }

  return refreshHandoff ? 'refresh-handoff' : archiveRequested ? 'killed' : 'stopped';
}
