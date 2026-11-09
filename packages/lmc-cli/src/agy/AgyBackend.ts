import { sanitizeSessionEnvironment } from '@/daemon/sessionEnvironment';
/**
 * Agy AgentBackend Implementation
 *
 * Drives the official Antigravity CLI via persistent `agy acp --stdio` by default
 * (falling back to structured `agy --print` when `transport: 'print'` or an older
 * CLI lacks `acp`):
 *
 *   ACP mode (`transport: 'acp'`, default):
 *     - Lazy persistent `agy acp --stdio` child kept warm across turns
 *     - `session/new` for fresh conversations; `session/resume` (zero replay) on resume
 *     - `session/cancel` JSON-RPC notification on user interrupt (keeps server + subagents alive)
 *     - Step-boundary mid-turn `output-complete` flushing (tool/thought transitions + SQLite-confirmed `DONE` planner steps) + SQLite `gen_metadata` step usage
 *
 *   Print mode (`transport: 'print'`, legacy fallback):
 *     - One `agy --print --output-format stream-json` process per turn
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { PermissionMode } from '@/api/types';
import type {
  AgentBackend,
  AgentMessage,
  AgentMessageHandler,
  SessionId,
  StartSessionResult,
} from '@/agent/core/AgentBackend';
import {
  resolveAgyBin,
  resolveAgyPrintTimeout,
  resolveAgyTransport,
  type AgyTransport,
} from './constants';
import { buildAgyArgs } from './cliArgs';
import {
  AgyStream,
  AgyTurnCancelledError,
  appendBoundedStderr,
  extractAgyStderrError,
  isAgyTurnCancelledError,
  isInvalidArgumentAgyError,
  isTransientAgyAuthError,
  isTransientAgyStreamError,
  type SpawnFn,
} from './stream';
import {
  repairCorruptedAgyConversationMedia,
  type AgyConversationMediaRepairResult,
} from './conversationRepair';
import { readAgyConversationStateSnapshot } from './contextUsage';
import {
  AgyAcpSession,
  combineRetrySafety,
  type AgyAcpAttemptRef,
  type AgyAcpRetryGate,
  type AgyRetrySafety,
  type AgyUsageHandoffFs,
} from './AgyAcpSession';

export { appendBoundedStderr, extractAgyStderrError, type SpawnFn };

const DEFAULT_AUTH_RETRY_DELAY_MS = 3_500;
const DEFAULT_TRANSIENT_STREAM_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000];
const DEFAULT_MAX_BG_WAKEUP_RETRIES = 3;
const DEFAULT_PRINT_CLOSE_SIGTERM_MS = 1_000;
const DEFAULT_PRINT_CLOSE_SIGKILL_MS = 2_000;
const POST_EXIT_PRINT_DRAIN_MS = 200;
const UNSAFE_PRINT_SHUTDOWN_TIMEOUT_MESSAGE =
  'Antigravity print process did not exit within shutdown timeout; refusing unsafe state transition';
/** Max signed 32-bit integer accepted by Node's `setTimeout` without overflowing to 1ms. */
export const MAX_SAFE_NODE_TIMEOUT_MS = 2_147_483_647;
const AGY_AUTH_RETRY_PROMPT = '[System: Previous generation was interrupted by a transient OAuth token refresh (HTTP 401). Continue and complete the response to the latest user request from the current state without repeating already completed work.]';
const AGY_MEDIA_REPAIR_RETRY_PROMPT = '[System: Previous generation failed with HTTP 400 INVALID_ARGUMENT because a corrupted or truncated image file had been read into conversation history. The corrupted media payload has been sanitized in-place. Continue and complete the response to the latest user request without re-reading corrupted image files.]';
const AGY_STREAM_RETRY_PROMPT = '[System: Previous generation stream was interrupted by a transient upstream connection drop or idle timeout. Inspect the current workspace and conversation state, then continue and complete the response to the latest user request without repeating already completed work.]';
const AGY_BG_WAKEUP_RETRY_PROMPT = '[System: The previous Antigravity CLI print window closed while background task(s) or a long-running turn were still active. Check the latest task logs/state in the workspace and continue or wrap up the current user request without repeating already completed work.]';

/**
 * Extract the count of active non-daemon background tasks killed when `agy --print` exits.
 *
 * Matches `terminating N background task(s) on exit` and
 * `terminating N background task(s) and M daemon task(s) on exit`, while deliberately
 * ignoring `terminating M daemon task(s) on exit` (standing daemons cleaned up normally).
 */
export function extractTerminatedBackgroundTaskCount(stderrText: string): number {
  if (!stderrText.trim()) return 0;
  let terminated = 0;
  for (const rawLine of stderrText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = /^terminating\s+(\d+)\s+background task\(s\)(?:\s+and\s+\d+\s+daemon task\(s\))?\s+on exit$/i.exec(line);
    if (match) {
      const count = Number(match[1]);
      if (Number.isFinite(count) && count > terminated) {
        terminated = count;
      }
    }
  }
  return terminated;
}

export interface AgyBackendOptions {
  /** Working directory for the agy process. */
  cwd: string;
  /** Initial permission mode; updated per turn from message meta. */
  permissionMode: PermissionMode;
  /** Initial model display name or native model ID; updated per turn from message meta. */
  model?: string;
  /** Transport mode (`'acp'` persistent stdio server by default; `'print'` fallback). */
  transport?: AgyTransport;
  /** Value for `--print-timeout`. Defaults to AGY_PRINT_TIMEOUT. */
  printTimeout?: string;
  /** Backoff before a single retry on transient OAuth 401 token refresh race. */
  authRetryDelayMs?: number;
  /** Backoffs before automatic retries on transient upstream stream timeouts/disconnects. */
  transientStreamRetryDelaysMs?: readonly number[];
  /** Max automatic wakeup continuations when a CLI print window closes with active background tasks. */
  maxBackgroundWakeupRetries?: number;
  /** Idle check interval (ms) for flushing mid-turn ACP text once SQLite confirms the planner step reached DONE. Defaults to 300ms. */
  midTurnFlushMs?: number;
  /** Idle poll interval (ms) for streaming Antigravity autonomous reactive wakeups between prompts. Defaults to 1000ms. */
  autonomousPollMs?: number;
  /** Safety grace window (ms) after `session/cancel` before force-recycling a wedged ACP server. */
  acpCancelGraceMs?: number;
  /** Grace window (ms) after SIGTERM before escalating ACP shutdown to SIGKILL. */
  acpCloseSigtermMs?: number;
  /** Grace window (ms) after SIGKILL when awaiting confirmed ACP process exit. */
  acpCloseSigkillMs?: number;
  /** Optional logger. */
  log?: (msg: string) => void;
  /** Injectable spawn (defaults to node's child_process.spawn). */
  spawnFn?: SpawnFn;
  /** Explicit native conversation; a workspace-wide cache is never a resume source. */
  conversationId?: string | null;
  onConversationId?: (id: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Optional isolated `.gemini/antigravity-cli` directory for conversation DB repair and step usage. */
  agyHomeDir?: string;
  /** Optional override for usage handoff sidecar filesystem operations (used by unit tests). */
  usageHandoffFs?: Partial<AgyUsageHandoffFs>;
  /** Optional callback confirming emitted billing records reached durable downstream storage or server ACK. */
  confirmUsageDurable?: () => Promise<void>;
  /** Optional fallback reader for encrypted session-metadata handoff payloads. */
  loadFallbackHandoff?: (conversationId: string) => string | null | undefined;
  /** Optional fallback writer for encrypted session-metadata handoff payloads. */
  persistFallbackHandoff?: (
    conversationId: string,
    serializedHandoff: string | null,
  ) => Promise<void>;
  /** Optional override for corrupted conversation media repair (used by unit tests). */
  repairConversationMedia?: (conversationId: string) => AgyConversationMediaRepairResult;
}

/**
 * Parse an agy Go duration string ("10m", "30s", "168h", "1h30m", "500ms") to milliseconds;
 * 0/0s/0m/0h disables the outer watchdog, and malformed strings default to 10m.
 */
export function parsePrintTimeoutMs(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '0') return null;
  if (!/^(?:\d+(?:\.\d+)?\s*(?:ms|s|m|h)\s*)+$/.test(trimmed)) return 10 * 60_000;
  let totalMs = 0;
  const partRe = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g;
  let match: RegExpExecArray | null;
  while ((match = partRe.exec(trimmed)) !== null) {
    const n = Number(match[1]);
    const unit = match[2];
    const mult = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1;
    totalMs += n * mult;
  }
  const rounded = Math.round(totalMs);
  return rounded <= 0 ? null : rounded;
}

/**
 * Arm a timeout that safely spans durations exceeding Node's 32-bit signed `setTimeout`
 * limit (`2_147_483_647` ms ≈ 24.85 days) without overflowing to 1ms.
 */
function armSafeTimeout(onExpire: () => void, totalMs: number): () => void {
  let cancelled = false;
  let activeTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSlice = (remainingMs: number) => {
    if (cancelled) return;
    if (remainingMs <= MAX_SAFE_NODE_TIMEOUT_MS) {
      activeTimer = setTimeout(() => {
        activeTimer = null;
        if (!cancelled) onExpire();
      }, Math.max(0, remainingMs));
      return;
    }
    activeTimer = setTimeout(() => {
      activeTimer = null;
      scheduleSlice(remainingMs - MAX_SAFE_NODE_TIMEOUT_MS);
    }, MAX_SAFE_NODE_TIMEOUT_MS);
  };
  scheduleSlice(totalMs);
  return () => {
    cancelled = true;
    if (activeTimer !== null) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
  };
}

type AttemptOutcome =
  | {
      ok: true;
      stderrError: string | null;
      terminatedBackgroundTasks: number;
      finishedReason: string | null;
    }
  | {
      ok: false;
      cancelled?: boolean;
      abortedRetryBeforePrompt?: boolean;
      detail: string;
      rawTurnError: string | null;
      stderrError: string | null;
      exitCode: number | null;
      sawInit: boolean;
      retrySafety: AgyRetrySafety;
      acpAttemptRef?: AgyAcpAttemptRef;
      terminatedBackgroundTasks: number;
      finishedReason: string | null;
      unexpectedProcessExit?: boolean;
      unseededBaseline?: boolean;
      unkillableProcess?: boolean;
      fatalSpawnError?: Error;
    };

interface PrintProcessHandle {
  readonly child: ChildProcess;
  readonly exitedPromise: Promise<void>;
  markExited: () => void;
  exited: boolean;
  osExited: boolean;
  stdioClosed: boolean;
  closingIntentionally: boolean;
  hasSpawnedEvent: boolean;
  hasCommunicated: boolean;
  undrainedStdio: boolean;
  postExitDrainTimer: ReturnType<typeof setTimeout> | null;
  retirementPromise: Promise<boolean> | null;
  onUnkillable?: () => void;
}

export class AgyBackend implements AgentBackend {
  private readonly handlers = new Set<AgentMessageHandler>();
  private readonly cwd: string;
  private readonly transport: AgyTransport;
  private readonly printTimeout: string;
  private readonly hasExplicitPrintTimeout: boolean;
  private readonly authRetryDelayMs: number;
  private readonly transientStreamRetryDelaysMs: readonly number[];
  private readonly maxBackgroundWakeupRetries: number;
  private readonly printCloseSigtermMs: number;
  private readonly printCloseSigkillMs: number;
  private readonly log: (msg: string) => void;
  private readonly spawnFn: SpawnFn;
  private readonly onConversationId?: (id: string) => void;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly agyHomeDir?: string;
  private readonly confirmUsageDurable?: () => Promise<void>;
  private readonly repairConversationMedia: (conversationId: string) => AgyConversationMediaRepairResult;
  private readonly acpSession: AgyAcpSession | null;

  private permissionMode: PermissionMode;
  private model?: string;
  private turnStartedAt?: number;
  private conversationId: string | null = null;
  private child: ChildProcess | null = null;
  private activePrintHandle: PrintProcessHandle | null = null;
  private readonly retiringPrintPromises = new Set<Promise<boolean>>();
  private readonly unkillablePrintHandles = new Set<PrintProcessHandle>();
  private lastPrintPersistFailed = false;
  private cancelled = false;
  private disposed = false;
  private activePrompts = 0;
  private cancelRetryWait: (() => void) | null = null;
  private promptChain: Promise<void> = Promise.resolve();

  constructor(opts: AgyBackendOptions) {
    this.cwd = opts.cwd;
    this.permissionMode = opts.permissionMode;
    this.model = opts.model;
    this.transport = resolveAgyTransport(opts.transport);
    this.hasExplicitPrintTimeout =
      opts.printTimeout !== undefined || Boolean(process.env.LMC_AGY_PRINT_TIMEOUT?.trim());
    this.printTimeout = resolveAgyPrintTimeout(opts.printTimeout);
    this.authRetryDelayMs = opts.authRetryDelayMs ?? DEFAULT_AUTH_RETRY_DELAY_MS;
    this.transientStreamRetryDelaysMs =
      opts.transientStreamRetryDelaysMs ?? DEFAULT_TRANSIENT_STREAM_RETRY_DELAYS_MS;
    this.maxBackgroundWakeupRetries =
      opts.maxBackgroundWakeupRetries ?? DEFAULT_MAX_BG_WAKEUP_RETRIES;
    this.printCloseSigtermMs = opts.acpCloseSigtermMs ?? DEFAULT_PRINT_CLOSE_SIGTERM_MS;
    this.printCloseSigkillMs = opts.acpCloseSigkillMs ?? DEFAULT_PRINT_CLOSE_SIGKILL_MS;
    this.log = opts.log ?? (() => {});
    this.spawnFn = opts.spawnFn ?? spawn;
    this.conversationId = opts.conversationId ?? null;
    this.onConversationId = opts.onConversationId;
    this.env = opts.env;
    this.agyHomeDir = opts.agyHomeDir;
    this.confirmUsageDurable = opts.confirmUsageDurable;
    this.repairConversationMedia =
      opts.repairConversationMedia ??
      ((id: string) => repairCorruptedAgyConversationMedia(id, { agyHomeDir: opts.agyHomeDir, log: this.log }));

    this.acpSession =
      this.transport === 'acp'
        ? new AgyAcpSession({
            cwd: this.cwd,
            spawnFn: this.spawnFn,
            env: this.env,
            agyHomeDir: opts.agyHomeDir,
            usageHandoffFs: opts.usageHandoffFs,
            confirmUsageDurable: opts.confirmUsageDurable,
            loadFallbackHandoff: opts.loadFallbackHandoff,
            persistFallbackHandoff: opts.persistFallbackHandoff,
            log: this.log,
            emit: (msg) => this.emit(msg),
            getConversationId: () => this.conversationId,
            setConversationId: (id) => {
              if (this.conversationId !== id) {
                this.conversationId = id;
                this.onConversationId?.(id);
              }
            },
            midTurnFlushMs: opts.midTurnFlushMs,
            autonomousPollMs: opts.autonomousPollMs,
            cancelGraceMs: opts.acpCancelGraceMs,
            closeSigtermMs: opts.acpCloseSigtermMs,
            closeSigkillMs: opts.acpCloseSigkillMs,
          })
        : null;
  }

  /** Update the permission mode applied to subsequent turns. */
  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  /** Update the model applied to subsequent turns. */
  setModel(model: string | undefined): void {
    this.model = model;
  }

  /** Record the caller's turn start timestamp for delayed SQLite step attribution. */
  setTurnStartedAt(startedAt: number | undefined): void {
    this.turnStartedAt = startedAt;
  }

  async startSession(): Promise<StartSessionResult> {
    // agy spawns lazily on the first prompt (`agy acp --stdio` kept warm thereafter).
    // Deliberately do NOT seed from the cwd conversation cache: it holds whatever
    // conversation last ran in this cwd — possibly another live session's — so
    // seeding would cross-resume it. A fresh session starts a fresh conversation;
    // a restored conversation must be supplied explicitly by its caller.
    if (this.acpSession) {
      await this.acpSession.recoverPersistedUsageOnStartup();
    }
    return { sessionId: this.cwd };
  }

  async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    const prev = this.promptChain;
    const mustWaitForPrior = this.activePrompts > 0 || this.retiringPrintPromises.size > 0;
    this.activePrompts += 1;

    let release!: () => void;
    this.promptChain = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      if (mustWaitForPrior) {
        await prev.catch(() => {});
      }
      await this.executeSendPrompt(sessionId, prompt);
    } finally {
      this.activePrompts -= 1;
      release();
    }
  }

  private async executeSendPrompt(_sessionId: SessionId, prompt: string): Promise<void> {
    if (this.disposed) {
      throw new AgyTurnCancelledError();
    }
    if (this.retiringPrintPromises.size > 0) {
      await this.awaitPrintRetirementBarrier(false);
    }
    if (this.unkillablePrintHandles.size > 0) {
      this.emit({ type: 'status', status: 'error', detail: UNSAFE_PRINT_SHUTDOWN_TIMEOUT_MESSAGE });
      throw new Error(UNSAFE_PRINT_SHUTDOWN_TIMEOUT_MESSAGE);
    }

    const turnStartedAt = this.turnStartedAt ?? Date.now();
    this.turnStartedAt = undefined;

    this.cancelled = false;
    this.acpSession?.clearPendingCancel();
    this.emit({ type: 'status', status: 'running' });

    let baseReplayPrompt = prompt;
    let currentPrompt = prompt;
    let authRetried = false;
    let mediaRepairRetried = false;
    let transientStreamRetriesUsed = 0;
    let bgWakeupContinuationsUsed = 0;
    const priorAcpAttempts: AgyAcpAttemptRef[] = [];
    let stickyRetrySafety: AgyRetrySafety = 'replay_original_prompt';
    let pendingRetryGate: AgyAcpRetryGate | undefined;

    while (true) {
      if (this.cancelled) {
        this.emit({ type: 'status', status: 'idle' });
        throw new AgyTurnCancelledError();
      }

      if (this.retiringPrintPromises.size > 0) {
        await this.awaitPrintRetirementBarrier(false);
      }
      if (this.unkillablePrintHandles.size > 0) {
        this.emit({ type: 'status', status: 'error', detail: UNSAFE_PRINT_SHUTDOWN_TIMEOUT_MESSAGE });
        throw new Error(UNSAFE_PRINT_SHUTDOWN_TIMEOUT_MESSAGE);
      }

      const retryGateForAttempt = pendingRetryGate;
      pendingRetryGate = undefined;

      const outcome =
        this.transport === 'acp'
          ? await this.runSingleAcpAttempt(currentPrompt, turnStartedAt, retryGateForAttempt)
          : await this.runSinglePrintAttempt(currentPrompt);

      if (!outcome.ok) {
        if (outcome.acpAttemptRef) {
          priorAcpAttempts.push(outcome.acpAttemptRef);
        }
        if (outcome.retrySafety === 'unsafe_side_effects') {
          stickyRetrySafety = 'unsafe_side_effects';
        } else if (this.transport !== 'acp') {
          stickyRetrySafety = combineRetrySafety(stickyRetrySafety, outcome.retrySafety);
        }
      }

      if (!outcome.ok && outcome.unkillableProcess) {
        this.emit({ type: 'status', status: 'error', detail: outcome.detail });
        throw new Error(outcome.detail);
      }

      if (this.cancelled || (!outcome.ok && outcome.cancelled)) {
        this.emit({ type: 'status', status: 'idle' });
        throw new AgyTurnCancelledError();
      }

      if (!outcome.ok && outcome.abortedRetryBeforePrompt) {
        this.emit({ type: 'status', status: 'error', detail: outcome.detail });
        throw new Error(outcome.detail);
      }

      const hitDefaultPrintWindowLimit =
        this.transport === 'print' &&
        !this.hasExplicitPrintTimeout &&
        (outcome.finishedReason === 'print_timeout' ||
          /^\[agy\]\s*print timeout\b/i.test(outcome.stderrError ?? ''));

      if (outcome.ok) {
        if (
          this.transport === 'print' &&
          !this.cancelled &&
          this.conversationId &&
          outcome.finishedReason !== 'interrupted' &&
          (outcome.terminatedBackgroundTasks > 0 || hitDefaultPrintWindowLimit) &&
          bgWakeupContinuationsUsed < this.maxBackgroundWakeupRetries
        ) {
          bgWakeupContinuationsUsed += 1;
          authRetried = false;
          priorAcpAttempts.length = 0;
          stickyRetrySafety = 'replay_original_prompt';
          this.log(
            `agy print window ended before background completion (terminatedBackgroundTasks=${outcome.terminatedBackgroundTasks}, finishedReason=${outcome.finishedReason ?? 'none'}); auto-waking conversation ${this.conversationId} (${bgWakeupContinuationsUsed}/${this.maxBackgroundWakeupRetries})`,
          );
          baseReplayPrompt = AGY_BG_WAKEUP_RETRY_PROMPT;
          currentPrompt = AGY_BG_WAKEUP_RETRY_PROMPT;
          continue;
        }
        this.emit({ type: 'status', status: 'idle' });
        return;
      }

      if (outcome.fatalSpawnError) {
        this.emit({ type: 'status', status: 'error', detail: outcome.detail });
        throw outcome.fatalSpawnError;
      }

      if (
        this.transport === 'print' &&
        !this.cancelled &&
        this.conversationId &&
        outcome.finishedReason !== 'interrupted' &&
        stickyRetrySafety !== 'unsafe_side_effects' &&
        outcome.retrySafety !== 'unsafe_side_effects' &&
        hitDefaultPrintWindowLimit &&
        bgWakeupContinuationsUsed < this.maxBackgroundWakeupRetries
      ) {
        bgWakeupContinuationsUsed += 1;
        authRetried = false;
        this.log(
          `agy default print window (${this.printTimeout}) rolled over on conversation ${this.conversationId}; continuing automatically (${bgWakeupContinuationsUsed}/${this.maxBackgroundWakeupRetries})`,
        );
        const effectivePrintSafety = combineRetrySafety(stickyRetrySafety, outcome.retrySafety);
        currentPrompt =
          effectivePrintSafety === 'continue_persisted_turn'
            ? AGY_BG_WAKEUP_RETRY_PROMPT
            : baseReplayPrompt;
        continue;
      }

      const attemptFailed =
        this.transport === 'acp' || outcome.exitCode !== 0 || outcome.stderrError !== null;

      if (
        !authRetried &&
        !this.cancelled &&
        attemptFailed &&
        stickyRetrySafety !== 'unsafe_side_effects' &&
        outcome.retrySafety !== 'unsafe_side_effects' &&
        isTransientAgyAuthError(outcome.rawTurnError)
      ) {
        authRetried = true;
        this.log('agy hit transient OAuth 401 during turn; waiting for token refresh and retrying once');
        await this.waitForRetryDelay(this.authRetryDelayMs);
        if (this.cancelled) {
          this.emit({ type: 'status', status: 'idle' });
          throw new AgyTurnCancelledError();
        }
        const effectiveSafety = await this.resolveCurrentRetrySafety(
          outcome,
          priorAcpAttempts,
          stickyRetrySafety,
        );
        if (effectiveSafety === 'unsafe_side_effects') {
          stickyRetrySafety = 'unsafe_side_effects';
          this.log(
            'agy observed late tool activity or unverified conversation state during OAuth 401 backoff; skipping automatic retry to prevent duplicate side effects',
          );
        } else {
          const continuationPrompt = this.conversationId ? AGY_AUTH_RETRY_PROMPT : null;
          currentPrompt =
            effectiveSafety === 'continue_persisted_turn' && continuationPrompt !== null
              ? continuationPrompt
              : baseReplayPrompt;
          pendingRetryGate = {
            priorAttempts: [...priorAcpAttempts],
            baselineSafety: stickyRetrySafety,
            replayPrompt: baseReplayPrompt,
            continuationPrompt,
            abortDetail: outcome.detail,
            abortRawTurnError: outcome.rawTurnError,
          };
          continue;
        }
      }

      if (
        !mediaRepairRetried &&
        !this.cancelled &&
        this.conversationId &&
        attemptFailed &&
        isInvalidArgumentAgyError(outcome.rawTurnError)
      ) {
        mediaRepairRetried = true;
        // Require confirmed child process exit before mutating the local conversation DB
        // on disk so the resumed session reloads the sanitized blob without concurrent writes.
        try {
          await this.awaitPrintRetirementBarrier(true);
          if (this.acpSession) {
            await this.acpSession.closeProcess({ requireExit: true });
          }
        } catch (closeErr) {
          const msg = closeErr instanceof Error ? closeErr.message : String(closeErr);
          this.emit({ type: 'status', status: 'error', detail: msg });
          throw closeErr instanceof Error ? closeErr : new Error(msg);
        }
        if (this.cancelled) {
          this.emit({ type: 'status', status: 'idle' });
          throw new AgyTurnCancelledError();
        }
        const repair = this.repairConversationMedia(this.conversationId);
        if (this.cancelled) {
          this.emit({ type: 'status', status: 'idle' });
          throw new AgyTurnCancelledError();
        }
        if (repair.repairedCount > 0) {
          const effectiveSafety = await this.resolveCurrentRetrySafety(
            outcome,
            priorAcpAttempts,
            stickyRetrySafety,
          );
          if (effectiveSafety === 'unsafe_side_effects') {
            stickyRetrySafety = 'unsafe_side_effects';
            this.log(
              `agy hit INVALID_ARGUMENT 400 from ${repair.repairedCount} corrupted media blob(s) in conversation ${this.conversationId}; repaired in-place for future turns, but skipping automatic retry after tool activity to prevent duplicate side effects`,
            );
          } else {
            this.log(
              `agy hit INVALID_ARGUMENT 400 from ${repair.repairedCount} corrupted media blob(s) in conversation ${this.conversationId} (steps: ${repair.repairedSteps.join(',')}); repaired in-place and retrying once`,
            );
            currentPrompt =
              effectiveSafety === 'continue_persisted_turn'
                ? AGY_MEDIA_REPAIR_RETRY_PROMPT
                : baseReplayPrompt;
            pendingRetryGate = {
              priorAttempts: [...priorAcpAttempts],
              baselineSafety: stickyRetrySafety,
              replayPrompt: baseReplayPrompt,
              continuationPrompt: AGY_MEDIA_REPAIR_RETRY_PROMPT,
              abortDetail: outcome.detail,
              abortRawTurnError: outcome.rawTurnError,
            };
            continue;
          }
        }
      }

      if (
        !this.cancelled &&
        attemptFailed &&
        transientStreamRetriesUsed < this.transientStreamRetryDelaysMs.length &&
        (outcome.unexpectedProcessExit === true ||
          outcome.unseededBaseline === true ||
          isTransientAgyStreamError(outcome.rawTurnError))
      ) {
        if (stickyRetrySafety === 'unsafe_side_effects' || outcome.retrySafety === 'unsafe_side_effects') {
          stickyRetrySafety = 'unsafe_side_effects';
          this.log(
            'agy turn interrupted after tool activity or unverified conversation state; skipping automatic retry to prevent duplicate side effects',
          );
        } else {
          const delayMs = this.transientStreamRetryDelaysMs[transientStreamRetriesUsed++];
          this.log(
            `agy hit transient stream/process interruption (${transientStreamRetriesUsed}/${this.transientStreamRetryDelaysMs.length}); retrying in ${delayMs}ms`,
          );
          await this.waitForRetryDelay(delayMs);
          if (this.cancelled) {
            this.emit({ type: 'status', status: 'idle' });
            throw new AgyTurnCancelledError();
          }
          const effectiveSafety = await this.resolveCurrentRetrySafety(
            outcome,
            priorAcpAttempts,
            stickyRetrySafety,
          );
          if (effectiveSafety === 'unsafe_side_effects') {
            stickyRetrySafety = 'unsafe_side_effects';
            this.log(
              'agy observed late tool activity or unverified conversation state during stream retry backoff; skipping automatic retry to prevent duplicate side effects',
            );
          } else {
            const continuationPrompt = this.conversationId ? AGY_STREAM_RETRY_PROMPT : null;
            currentPrompt =
              effectiveSafety === 'continue_persisted_turn' && continuationPrompt !== null
                ? continuationPrompt
                : baseReplayPrompt;
            pendingRetryGate = {
              priorAttempts: [...priorAcpAttempts],
              baselineSafety: stickyRetrySafety,
              replayPrompt: baseReplayPrompt,
              continuationPrompt,
              abortDetail: outcome.detail,
              abortRawTurnError: outcome.rawTurnError,
            };
            continue;
          }
        }
      }

      this.emit({ type: 'status', status: 'error', detail: outcome.detail });
      throw new Error(outcome.detail);
    }
  }

  private async resolveCurrentRetrySafety(
    outcome: Extract<AttemptOutcome, { ok: false }>,
    priorAcpAttempts: readonly AgyAcpAttemptRef[],
    baselineSafety: AgyRetrySafety,
  ): Promise<AgyRetrySafety> {
    if (baselineSafety === 'unsafe_side_effects' || outcome.retrySafety === 'unsafe_side_effects') {
      return 'unsafe_side_effects';
    }
    if (this.transport === 'acp' && this.acpSession) {
      if (priorAcpAttempts.length > 0) {
        return this.acpSession.revalidatePriorAttemptsRetrySafety(priorAcpAttempts, baselineSafety);
      }
      const latest = await this.acpSession.revalidateLastTurnRetrySafety();
      if (latest !== null) {
        return combineRetrySafety(baselineSafety, latest);
      }
    }
    return combineRetrySafety(baselineSafety, outcome.retrySafety);
  }

  private async runSingleAcpAttempt(
    prompt: string,
    turnStartedAt: number,
    retryGate?: AgyAcpRetryGate,
  ): Promise<AttemptOutcome> {
    const timeoutMs = parsePrintTimeoutMs(this.printTimeout);
    const acpOutcome = await this.acpSession!.runTurn({
      prompt,
      model: this.model,
      permissionMode: this.permissionMode,
      turnTimeoutMs: timeoutMs !== null ? timeoutMs + 30_000 : null,
      turnStartedAt,
      retryGate,
    });

    if (acpOutcome.ok) {
      return {
        ok: true,
        stderrError: null,
        terminatedBackgroundTasks: 0,
        finishedReason: acpOutcome.stopReason,
      };
    }

    return {
      ok: false,
      cancelled: acpOutcome.cancelled,
      abortedRetryBeforePrompt: acpOutcome.abortedRetryBeforePrompt,
      detail: acpOutcome.detail,
      rawTurnError: acpOutcome.rawTurnError,
      stderrError: acpOutcome.stderrError,
      exitCode: acpOutcome.exitCode,
      sawInit: acpOutcome.promptDispatched,
      retrySafety: acpOutcome.retrySafety,
      acpAttemptRef: acpOutcome.attemptRef,
      terminatedBackgroundTasks: 0,
      finishedReason: null,
      unexpectedProcessExit: acpOutcome.unexpectedProcessExit,
      unseededBaseline: acpOutcome.unseededBaseline,
      unkillableProcess: acpOutcome.unkillableProcess,
      fatalSpawnError: acpOutcome.fatalSpawnError,
    };
  }

  private runSinglePrintAttempt(prompt: string): Promise<AttemptOutcome> {
    const preSnap = this.conversationId
      ? readAgyConversationStateSnapshot(this.conversationId, { agyHomeDir: this.agyHomeDir })
      : null;

    const args = buildAgyArgs({
      prompt,
      model: this.model,
      conversationId: this.conversationId,
      permissionMode: this.permissionMode,
      addDirs: [this.cwd],
      printTimeout: this.printTimeout,
    });

    return new Promise<AttemptOutcome>((resolve) => {
      const child = this.spawnFn(resolveAgyBin(), args, {
        cwd: this.cwd,
        env: sanitizeSessionEnvironment({ ...process.env, ...this.env }),
        windowsHide: true,
        // agy --print blocks until stdin reaches EOF. We never write stdin, so
        // give the child an empty stdin (immediate EOF) instead of an open pipe;
        // otherwise it hangs forever and the turn never completes.
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let resolveExited!: () => void;
      const exitedPromise = new Promise<void>((res) => {
        resolveExited = res;
      });

      const printHandle: PrintProcessHandle = {
        child,
        exitedPromise,
        markExited: () => {
          if (printHandle.postExitDrainTimer !== null) {
            clearTimeout(printHandle.postExitDrainTimer);
            printHandle.postExitDrainTimer = null;
          }
          if (!printHandle.exited) {
            printHandle.exited = true;
            this.unkillablePrintHandles.delete(printHandle);
            resolveExited();
          }
        },
        exited: false,
        osExited: false,
        stdioClosed: false,
        closingIntentionally: false,
        hasSpawnedEvent: typeof child.pid === 'number' && child.pid > 0,
        hasCommunicated: false,
        undrainedStdio: false,
        postExitDrainTimer: null,
        retirementPromise: null,
      };

      this.child = child;
      this.activePrintHandle = printHandle;

      // Node can fire both 'error' and 'close' on spawn failure; act on the first only.
      let settled = false;
      let malformedStreamError: Error | null = null;
      let finishError: Error | null = null;
      let stderrBuf = '';
      let exitCodeSeen: number | null = null;
      let loggedDiagnostic = false;
      const stream = new AgyStream(m => this.emit(m), id => {
        if (this.conversationId !== id) {
          this.conversationId = id;
          this.onConversationId?.(id);
        }
      }, this.conversationId);

      const classifyPrintRetrySafety = (): AgyRetrySafety => {
        const postSnap = this.conversationId
          ? readAgyConversationStateSnapshot(this.conversationId, { agyHomeDir: this.agyHomeDir })
          : { dbExists: false, readOk: true, maxStepIdx: -1, maxExecIdx: -1, maxGenIdx: -1 };
        const dbExecAdvanced = Boolean(
          preSnap?.readOk &&
            postSnap.dbExists &&
            postSnap.readOk &&
            postSnap.maxExecIdx > preSnap.maxExecIdx,
        );
        const unknownDbToolState = Boolean(
          postSnap.dbExists && (!preSnap?.readOk || !postSnap.readOk),
        );
        const dbPromptPersisted = Boolean(
          preSnap?.readOk &&
            postSnap.dbExists &&
            postSnap.readOk &&
            postSnap.maxStepIdx > preSnap.maxStepIdx,
        );
        if (
          stream.sawToolActivity ||
          malformedStreamError !== null ||
          printHandle.undrainedStdio ||
          dbExecAdvanced ||
          unknownDbToolState
        ) {
          return 'unsafe_side_effects';
        }
        return stream.didInit || dbPromptPersisted
          ? 'continue_persisted_turn'
          : 'replay_original_prompt';
      };

      const timeoutMs = parsePrintTimeoutMs(this.printTimeout);
      const cleanup = () => {
        if (cancelWatchdog) cancelWatchdog();
        if (this.child === child) {
          this.child = null;
        }
        if (this.activePrintHandle === printHandle) {
          this.activePrintHandle = null;
        }
      };

      printHandle.onUnkillable = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          ok: false,
          detail: UNSAFE_PRINT_SHUTDOWN_TIMEOUT_MESSAGE,
          rawTurnError: UNSAFE_PRINT_SHUTDOWN_TIMEOUT_MESSAGE,
          stderrError: null,
          exitCode: null,
          sawInit: stream.didInit,
          retrySafety: 'unsafe_side_effects',
          terminatedBackgroundTasks: 0,
          finishedReason: stream.getFinishedReason(),
          unkillableProcess: true,
        });
      };

      const cancelWatchdog = timeoutMs !== null ? armSafeTimeout(() => {
        this.log(`agy turn exceeded ${this.printTimeout}; cancelling this CLI turn`);
        void this.retirePrintProcess(printHandle);
      }, timeoutMs + 30_000) : null;

      child.on('spawn', () => {
        printHandle.hasSpawnedEvent = true;
      });
      child.stdout?.on('error', () => {});
      child.stderr?.on('error', () => {});

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (!chunk || printHandle.stdioClosed || malformedStreamError) return;
        printHandle.hasCommunicated = true;
        try { stream.push(chunk); } catch (error) {
          malformedStreamError = error instanceof Error ? error : new Error('Invalid Antigravity stream');
          void this.retirePrintProcess(printHandle);
        }
      });

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        if (!chunk || printHandle.stdioClosed) return;
        printHandle.hasCommunicated = true;
        // Native errors can contain login URLs. Do not persist their raw text in logs.
        if (chunk.trim() && !loggedDiagnostic) {
          loggedDiagnostic = true;
          this.log('Antigravity CLI wrote diagnostic output; inspect it locally if the turn fails');
        }
        stderrBuf = appendBoundedStderr(stderrBuf, chunk);
      });

      child.on('error', (err: Error) => {
        const errno = err as NodeJS.ErrnoException;
        const isSpawnFailure =
          !printHandle.closingIntentionally &&
          !printHandle.hasSpawnedEvent &&
          !printHandle.hasCommunicated &&
          errno.syscall !== 'kill' &&
          typeof child.pid !== 'number';
        if (!isSpawnFailure) {
          // Post-spawn runtime/signal errors (e.g. `kill EPERM`) do NOT mean the child
          // has exited; wait for confirmed OS close or fail-closed shutdown timeout.
          this.log(`agy print child error (code=${errno.code ?? 'unknown'}): ${err.message}`);
          return;
        }
        if (settled) return;
        settled = true;
        printHandle.stdioClosed = true;
        printHandle.osExited = true;
        printHandle.markExited();
        cleanup();
        const detail = errno.code === 'ENOENT'
          ? `agy executable not found. Install the Antigravity CLI, or set HAPPY_AGY_PATH to its absolute path (tried 'agy' on PATH and ~/.local/bin/agy).`
          : err.message;
        resolve({
          ok: false,
          detail,
          rawTurnError: null,
          stderrError: null,
          exitCode: null,
          sawInit: false,
          retrySafety: 'replay_original_prompt',
          terminatedBackgroundTasks: 0,
          finishedReason: stream.getFinishedReason(),
          fatalSpawnError: err,
        });
      });

      const finalizePrintClose = (code: number | null) => {
        printHandle.markExited();
        if (settled) return;
        settled = true;
        cleanup();
        if (!malformedStreamError && !stream.hasEnded) {
          try {
            stream.flushPendingLine();
          } catch (error) {
            malformedStreamError = error instanceof Error ? error : new Error('Invalid Antigravity stream');
          }
        }
        if (this.cancelled) {
          resolve({
            ok: false,
            cancelled: true,
            detail: 'Antigravity turn cancelled',
            rawTurnError: null,
            stderrError: null,
            exitCode: code,
            sawInit: stream.didInit,
            retrySafety: classifyPrintRetrySafety(),
            terminatedBackgroundTasks: 0,
            finishedReason: 'interrupted',
          });
          return;
        }
        const stderrError = extractAgyStderrError(stderrBuf);
        const terminatedBackgroundTasks = extractTerminatedBackgroundTaskCount(stderrBuf);
        if (!malformedStreamError && (code === 0 || stderrError !== null || stream.hasEnded)) {
          try {
            stream.finish({
              exitCode: code,
              stderrError,
              onRecoveredStaleError: () => {
                this.log('Ignored stale historical error in Antigravity result on exit-0 completed turn');
              },
            });
          } catch (error) {
            finishError = error instanceof Error ? error : new Error('Incomplete Antigravity stream');
          }
        }
        const finishedReason = stream.getFinishedReason();
        if (code === 0 && !malformedStreamError && !finishError && !printHandle.undrainedStdio) {
          resolve({
            ok: true,
            stderrError,
            terminatedBackgroundTasks,
            finishedReason,
          });
        } else {
          const detail =
            malformedStreamError?.message ??
            finishError?.message ??
            (printHandle.undrainedStdio
              ? 'Antigravity CLI exited with undrained stdio output'
              : `agy exited with code ${code ?? 'null'}; check Google login and model access in the native CLI`);
          resolve({
            ok: false,
            detail,
            rawTurnError: stderrError ?? stream.getResultError(),
            stderrError,
            exitCode: code,
            sawInit: stream.didInit,
            retrySafety: classifyPrintRetrySafety(),
            terminatedBackgroundTasks,
            finishedReason,
          });
        }
      };

      child.on('exit', (code: number | null) => {
        printHandle.osExited = true;
        exitCodeSeen = code;
        if (printHandle.stdioClosed) {
          finalizePrintClose(code);
          return;
        }
        if (printHandle.postExitDrainTimer === null) {
          const drainMs = Math.min(POST_EXIT_PRINT_DRAIN_MS, Math.max(10, Math.floor(this.printCloseSigtermMs / 2)));
          printHandle.postExitDrainTimer = setTimeout(() => {
            printHandle.postExitDrainTimer = null;
            if (printHandle.exited || printHandle.stdioClosed) return;
            printHandle.stdioClosed = true;
            printHandle.undrainedStdio = true;
            child.stdout?.removeAllListeners('data');
            child.stderr?.removeAllListeners('data');
            finalizePrintClose(exitCodeSeen);
          }, drainMs);
        }
      });

      child.on('close', (code: number | null) => {
        printHandle.osExited = true;
        printHandle.stdioClosed = true;
        finalizePrintClose(code ?? exitCodeSeen);
      });
    });
  }

  private retirePrintProcess(handle: PrintProcessHandle): Promise<boolean> {
    if (handle.retirementPromise) {
      return handle.retirementPromise;
    }
    handle.closingIntentionally = true;
    if (handle.exited) {
      return Promise.resolve(true);
    }

    // Deliver SIGTERM synchronously so callers see immediate termination intent, then
    // enforce bounded SIGTERM -> SIGKILL escalation and confirmed exit tracking.
    if (!handle.osExited) {
      try {
        handle.child.kill('SIGTERM');
      } catch {}
    }

    const retirement = (async (): Promise<boolean> => {
      const exitedOnTerm = await this.waitForPrintExitOrTimeout(handle, this.printCloseSigtermMs);
      if (exitedOnTerm) return true;

      this.log(`agy print process ignored SIGTERM for ${this.printCloseSigtermMs}ms; escalating to SIGKILL`);
      try {
        handle.child.kill('SIGKILL');
      } catch {}

      const exitedOnKill = await this.waitForPrintExitOrTimeout(handle, this.printCloseSigkillMs);
      if (!exitedOnKill && !handle.exited) {
        this.unkillablePrintHandles.add(handle);
        handle.onUnkillable?.();
      }
      return exitedOnKill;
    })();

    handle.retirementPromise = retirement;
    this.retiringPrintPromises.add(retirement);
    void retirement.finally(() => {
      this.retiringPrintPromises.delete(retirement);
    });
    return retirement;
  }

  private waitForPrintExitOrTimeout(handle: PrintProcessHandle, timeoutMs: number): Promise<boolean> {
    if (handle.exited) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(handle.exited);
      }, Math.max(1, timeoutMs));
      void handle.exitedPromise.then(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private async awaitPrintRetirementBarrier(requireExit: boolean): Promise<void> {
    while (this.retiringPrintPromises.size > 0) {
      await Promise.all([...this.retiringPrintPromises]);
    }
    if (requireExit && this.unkillablePrintHandles.size > 0) {
      throw new Error(UNSAFE_PRINT_SHUTDOWN_TIMEOUT_MESSAGE);
    }
  }

  private waitForRetryDelay(delayMs: number): Promise<void> {
    if (delayMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.cancelRetryWait = null;
        resolve();
      }, delayMs);
      this.cancelRetryWait = () => {
        clearTimeout(timer);
        this.cancelRetryWait = null;
        resolve();
      };
    });
  }

  async cancel(_sessionId?: SessionId): Promise<void> {
    this.cancelled = true;
    if (this.cancelRetryWait) {
      this.cancelRetryWait();
    }
    if (this.acpSession) {
      await this.acpSession.cancelTurn();
      return;
    }
    if (this.activePrintHandle) {
      void this.retirePrintProcess(this.activePrintHandle);
      this.child = null;
    } else if (this.child) {
      try {
        this.child.kill('SIGTERM');
      } catch {}
      this.child = null;
    }
  }

  get hasUnconfirmedChildExit(): boolean {
    return (
      this.activePrintHandle !== null ||
      this.retiringPrintPromises.size > 0 ||
      this.unkillablePrintHandles.size > 0 ||
      Boolean(this.acpSession?.hasUnconfirmedChildExit)
    );
  }

  get hasUnpersistedCloseState(): boolean {
    return this.lastPrintPersistFailed || Boolean(this.acpSession?.hasUnpersistedCloseState);
  }

  async transferUnpersistedHandoffs(
    transfer?: (conversationId: string, serializedHandoff: string | null) => Promise<void>,
  ): Promise<boolean> {
    if (this.hasUnconfirmedChildExit) {
      return false;
    }
    if (!this.acpSession) {
      if (this.confirmUsageDurable) {
        try {
          await this.confirmUsageDurable();
          this.lastPrintPersistFailed = false;
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
    return this.acpSession.transferUnpersistedHandoffs(transfer);
  }

  /**
   * Retire any owned Antigravity child process and require confirmed OS exit before
   * daemon session refresh / ownership handoff may proceed.
   */
  async closeForHandoff(): Promise<void> {
    this.cancelled = true;
    if (this.cancelRetryWait) {
      this.cancelRetryWait();
    }
    if (this.activePrintHandle) {
      void this.retirePrintProcess(this.activePrintHandle);
      this.child = null;
    }
    await this.awaitPrintRetirementBarrier(true);
    if (this.acpSession) {
      await this.acpSession.closeProcess({ requireExit: true, handoff: true });
    } else if (this.confirmUsageDurable) {
      await this.confirmUsageDurable();
    }
  }

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.add(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    this.handlers.delete(handler);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelled = true;
    if (this.cancelRetryWait) {
      this.cancelRetryWait();
    }
    if (this.activePrintHandle) {
      void this.retirePrintProcess(this.activePrintHandle);
      this.child = null;
    }
    this.lastPrintPersistFailed = false;
    const results = await Promise.allSettled([
      this.awaitPrintRetirementBarrier(true),
      this.acpSession
        ? this.acpSession.closeProcess({ dispose: true, requireExit: true })
        : this.confirmUsageDurable
          ? this.confirmUsageDurable().catch((err) => {
              this.lastPrintPersistFailed = true;
              throw err;
            })
          : Promise.resolve(),
    ]);
    for (const r of results) {
      if (r.status === 'rejected') {
        throw r.reason;
      }
    }
    this.handlers.clear();
  }

  private emit(msg: AgentMessage): void {
    for (const handler of this.handlers) {
      handler(msg);
    }
  }

  /** Exposed for tests verifying isAgyTurnCancelledError integration. */
  static isCancelledError(err: unknown): boolean {
    return isAgyTurnCancelledError(err);
  }
}
