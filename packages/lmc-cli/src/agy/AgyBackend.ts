import { sanitizeSessionEnvironment } from '@/daemon/sessionEnvironment';
/**
 * Agy AgentBackend Implementation
 *
 * Drives the official structured `agy --print` protocol, one process per turn:
 *
 *   spawn            → { type: 'status', status: 'running' }
 *   NDJSON events    → text, tool steps, token usage and a native conversation ID
 *   successful result + exit 0 → { type: 'status', status: 'idle' }
 *   exit code != 0   → { type: 'status', status: 'error', detail }
 *
 * Antigravity 1.4.x structured print events provide text, tools, usage and the
 * conversation ID. Native flags govern permissions; interactive approval is
 * not emulated by the LMC adapter.
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
import { resolveAgyBin, resolveAgyPrintTimeout } from './constants';
import { buildAgyArgs } from './cliArgs';
import { AgyStream, isInvalidArgumentAgyError, isTransientAgyAuthError } from './stream';
import {
  repairCorruptedAgyConversationMedia,
  type AgyConversationMediaRepairResult,
} from './conversationRepair';

/** Signature of node's `spawn`, injectable so tests can supply a fake process. */
export type SpawnFn = typeof spawn;

const MAX_STDERR_BUFFER = 16 * 1024;
const STDERR_HEAD_BYTES = 4 * 1024;
const DEFAULT_AUTH_RETRY_DELAY_MS = 3_500;
const DEFAULT_MAX_BG_WAKEUP_RETRIES = 3;
/** Max signed 32-bit integer accepted by Node's `setTimeout` without overflowing to 1ms. */
export const MAX_SAFE_NODE_TIMEOUT_MS = 2_147_483_647;
const AGY_AUTH_RETRY_PROMPT = '[System: Previous generation was interrupted by a transient OAuth token refresh (HTTP 401). Continue and complete the response to the latest user request from the current state without repeating already completed work.]';
const AGY_MEDIA_REPAIR_RETRY_PROMPT = '[System: Previous generation failed with HTTP 400 INVALID_ARGUMENT because a corrupted or truncated image file had been read into conversation history. The corrupted media payload has been sanitized in-place. Continue and complete the response to the latest user request without re-reading corrupted image files.]';
const AGY_BG_WAKEUP_RETRY_PROMPT = '[System: The previous Antigravity CLI print window closed while background task(s) or a long-running turn were still active. Check the latest task logs/state in the workspace and continue or wrap up the current user request without repeating already completed work.]';

export function appendBoundedStderr(current: string, chunk: string, maxChars: number = MAX_STDERR_BUFFER): string {
  if (!chunk) return current;
  const combined = current + chunk;
  if (combined.length <= maxChars) return combined;
  const marker = '\n...\n';
  const headLen = Math.min(STDERR_HEAD_BYTES, Math.floor((maxChars - marker.length) / 2));
  const tailLen = Math.max(0, maxChars - headLen - marker.length);
  return combined.slice(0, headLen) + marker + combined.slice(combined.length - tailLen);
}

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

export function extractAgyStderrError(stderrText: string): string | null {
  if (!stderrText.trim()) return null;
  for (const rawLine of stderrText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^AGY_ERROR:\s*/i.test(line)) {
      return line.replace(/^AGY_ERROR:\s*/i, '').trim() || line;
    }
    if (/^\[agy\]\s*print timeout\b/i.test(line)) {
      return line;
    }
    if (/^(?:panic|fatal error):/i.test(line)) {
      return line;
    }
  }
  return null;
}

export interface AgyBackendOptions {
  /** Working directory for the agy process. */
  cwd: string;
  /** Initial permission mode; updated per turn from message meta. */
  permissionMode: PermissionMode;
  /** Initial model display name; updated per turn from message meta. */
  model?: string;
  /** Value for `--print-timeout`. Defaults to AGY_PRINT_TIMEOUT. */
  printTimeout?: string;
  /** Backoff before a single retry on transient OAuth 401 token refresh race. */
  authRetryDelayMs?: number;
  /** Max automatic wakeup continuations when a CLI print window closes with active background tasks. */
  maxBackgroundWakeupRetries?: number;
  /** Optional logger. */
  log?: (msg: string) => void;
  /** Injectable spawn (defaults to node's child_process.spawn). */
  spawnFn?: SpawnFn;
  /** Explicit native conversation; a workspace-wide cache is never a resume source. */
  conversationId?: string | null;
  onConversationId?: (id: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Optional isolated `.gemini/antigravity-cli` directory for conversation DB repair. */
  agyHomeDir?: string;
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
      detail: string;
      rawTurnError: string | null;
      stderrError: string | null;
      exitCode: number | null;
      sawInit: boolean;
      terminatedBackgroundTasks: number;
      finishedReason: string | null;
      fatalSpawnError?: Error;
    };

export class AgyBackend implements AgentBackend {
  private readonly handlers = new Set<AgentMessageHandler>();
  private readonly cwd: string;
  private readonly printTimeout: string;
  private readonly hasExplicitPrintTimeout: boolean;
  private readonly authRetryDelayMs: number;
  private readonly maxBackgroundWakeupRetries: number;
  private readonly log: (msg: string) => void;
  private readonly spawnFn: SpawnFn;
  private readonly onConversationId?: (id: string) => void;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly repairConversationMedia: (conversationId: string) => AgyConversationMediaRepairResult;

  private permissionMode: PermissionMode;
  private model?: string;
  private conversationId: string | null = null;
  private child: ChildProcess | null = null;
  private cancelled = false;
  private cancelRetryWait: (() => void) | null = null;

  constructor(opts: AgyBackendOptions) {
    this.cwd = opts.cwd;
    this.permissionMode = opts.permissionMode;
    this.model = opts.model;
    this.hasExplicitPrintTimeout =
      opts.printTimeout !== undefined || Boolean(process.env.LMC_AGY_PRINT_TIMEOUT?.trim());
    this.printTimeout = resolveAgyPrintTimeout(opts.printTimeout);
    this.authRetryDelayMs = opts.authRetryDelayMs ?? DEFAULT_AUTH_RETRY_DELAY_MS;
    this.maxBackgroundWakeupRetries =
      opts.maxBackgroundWakeupRetries ?? DEFAULT_MAX_BG_WAKEUP_RETRIES;
    this.log = opts.log ?? (() => {});
    this.spawnFn = opts.spawnFn ?? spawn;
    this.conversationId = opts.conversationId ?? null;
    this.onConversationId = opts.onConversationId;
    this.env = opts.env;
    this.repairConversationMedia =
      opts.repairConversationMedia ??
      ((id: string) => repairCorruptedAgyConversationMedia(id, { agyHomeDir: opts.agyHomeDir, log: this.log }));
  }

  /** Update the permission mode applied to subsequent turns. */
  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  /** Update the model applied to subsequent turns. */
  setModel(model: string | undefined): void {
    this.model = model;
  }

  async startSession(): Promise<StartSessionResult> {
    // agy spawns lazily per prompt; there is nothing long-lived to start.
    // Deliberately do NOT seed from the cwd conversation cache: it holds whatever
    // conversation last ran in this cwd — possibly another live session's — so
    // seeding would cross-resume it. A fresh session starts a fresh conversation;
    // A restored conversation must be supplied explicitly by its caller.
    return { sessionId: this.cwd };
  }

  async sendPrompt(_sessionId: SessionId, prompt: string): Promise<void> {
    this.cancelled = false;
    this.emit({ type: 'status', status: 'running' });

    let currentPrompt = prompt;
    let authRetried = false;
    let mediaRepairRetried = false;
    let bgWakeupContinuationsUsed = 0;

    while (true) {
      const outcome = await this.runSingleAttempt(currentPrompt);
      const hitDefaultPrintWindowLimit =
        !this.hasExplicitPrintTimeout &&
        (outcome.finishedReason === 'print_timeout' ||
          /^\[agy\]\s*print timeout\b/i.test(outcome.stderrError ?? ''));

      if (outcome.ok) {
        if (
          !this.cancelled &&
          this.conversationId &&
          outcome.finishedReason !== 'interrupted' &&
          (outcome.terminatedBackgroundTasks > 0 || hitDefaultPrintWindowLimit) &&
          bgWakeupContinuationsUsed < this.maxBackgroundWakeupRetries
        ) {
          bgWakeupContinuationsUsed += 1;
          authRetried = false;
          this.log(
            `agy print window ended before background completion (terminatedBackgroundTasks=${outcome.terminatedBackgroundTasks}, finishedReason=${outcome.finishedReason ?? 'none'}); auto-waking conversation ${this.conversationId} (${bgWakeupContinuationsUsed}/${this.maxBackgroundWakeupRetries})`,
          );
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
        !this.cancelled &&
        this.conversationId &&
        outcome.finishedReason !== 'interrupted' &&
        hitDefaultPrintWindowLimit &&
        bgWakeupContinuationsUsed < this.maxBackgroundWakeupRetries
      ) {
        bgWakeupContinuationsUsed += 1;
        authRetried = false;
        this.log(
          `agy default print window (${this.printTimeout}) rolled over on conversation ${this.conversationId}; continuing automatically (${bgWakeupContinuationsUsed}/${this.maxBackgroundWakeupRetries})`,
        );
        currentPrompt = AGY_BG_WAKEUP_RETRY_PROMPT;
        continue;
      }

      if (
        !authRetried &&
        !this.cancelled &&
        (outcome.exitCode !== 0 || outcome.stderrError !== null) &&
        isTransientAgyAuthError(outcome.rawTurnError)
      ) {
        authRetried = true;
        this.log('agy hit transient OAuth 401 during turn; waiting for token refresh and retrying once');
        await this.waitForAuthRetry();
        if (this.cancelled) {
          const detail = 'Antigravity turn cancelled';
          this.emit({ type: 'status', status: 'error', detail });
          throw new Error(detail);
        }
        currentPrompt = outcome.sawInit && this.conversationId ? AGY_AUTH_RETRY_PROMPT : currentPrompt;
        continue;
      }

      if (
        !mediaRepairRetried &&
        !this.cancelled &&
        this.conversationId &&
        (outcome.exitCode !== 0 || outcome.stderrError !== null) &&
        isInvalidArgumentAgyError(outcome.rawTurnError)
      ) {
        mediaRepairRetried = true;
        const repair = this.repairConversationMedia(this.conversationId);
        if (repair.repairedCount > 0) {
          this.log(
            `agy hit INVALID_ARGUMENT 400 from ${repair.repairedCount} corrupted media blob(s) in conversation ${this.conversationId} (steps: ${repair.repairedSteps.join(',')}); repaired in-place and retrying once`,
          );
          currentPrompt = outcome.sawInit ? AGY_MEDIA_REPAIR_RETRY_PROMPT : currentPrompt;
          continue;
        }
      }

      this.emit({ type: 'status', status: 'error', detail: outcome.detail });
      throw new Error(outcome.detail);
    }
  }

  private runSingleAttempt(prompt: string): Promise<AttemptOutcome> {
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
      this.child = child;

      // Node can fire both 'error' and 'close' on spawn failure; act on the first only.
      let settled = false;
      let protocolError: Error | null = null;
      let stderrBuf = '';
      let loggedDiagnostic = false;
      const stream = new AgyStream(m => this.emit(m), id => {
        if (this.conversationId !== id) {
          this.conversationId = id;
          this.onConversationId?.(id);
        }
      }, this.conversationId);
      const timeoutMs = parsePrintTimeoutMs(this.printTimeout);
      const cancelWatchdog = timeoutMs !== null ? armSafeTimeout(() => {
        this.log(`agy turn exceeded ${this.printTimeout}; cancelling this CLI turn`);
        child.kill('SIGTERM');
      }, timeoutMs + 30_000) : null;
      const cleanup = () => {
        if (cancelWatchdog) cancelWatchdog();
        if (this.child === child) {
          this.child = null;
        }
      };

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (!chunk || protocolError) return;
        try { stream.push(chunk); } catch (error) {
          protocolError = error instanceof Error ? error : new Error('Invalid Antigravity stream');
          child.kill('SIGTERM');
        }
      });

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        // Native errors can contain login URLs. Do not persist their raw text in logs.
        if (chunk.trim() && !loggedDiagnostic) {
          loggedDiagnostic = true;
          this.log('Antigravity CLI wrote diagnostic output; inspect it locally if the turn fails');
        }
        stderrBuf = appendBoundedStderr(stderrBuf, chunk);
      });

      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        const detail = (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? `agy executable not found. Install the Antigravity CLI, or set HAPPY_AGY_PATH to its absolute path (tried 'agy' on PATH and ~/.local/bin/agy).`
          : err.message;
        resolve({
          ok: false,
          detail,
          rawTurnError: null,
          stderrError: null,
          exitCode: null,
          sawInit: stream.didInit,
          terminatedBackgroundTasks: 0,
          finishedReason: stream.getFinishedReason(),
          fatalSpawnError: err,
        });
      });

      child.on('close', (code: number | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        const stderrError = extractAgyStderrError(stderrBuf);
        const terminatedBackgroundTasks = extractTerminatedBackgroundTaskCount(stderrBuf);
        if (!protocolError && (code === 0 || stderrError !== null || stream.hasEnded)) {
          try {
            stream.finish({
              exitCode: code,
              stderrError,
              onRecoveredStaleError: () => {
                this.log('Ignored stale historical error in Antigravity result on exit-0 completed turn');
              },
            });
          } catch (error) {
            protocolError = error instanceof Error ? error : new Error('Incomplete Antigravity stream');
          }
        }
        const finishedReason = stream.getFinishedReason();
        if (code === 0 && !protocolError) {
          resolve({
            ok: true,
            stderrError,
            terminatedBackgroundTasks,
            finishedReason,
          });
        } else {
          const detail = protocolError?.message ?? `agy exited with code ${code ?? 'null'}; check Google login and model access in the native CLI`;
          resolve({
            ok: false,
            detail,
            rawTurnError: stderrError ?? stream.getResultError(),
            stderrError,
            exitCode: code,
            sawInit: stream.didInit,
            terminatedBackgroundTasks,
            finishedReason,
          });
        }
      });
    });
  }

  private waitForAuthRetry(): Promise<void> {
    if (this.authRetryDelayMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.cancelRetryWait = null;
        resolve();
      }, this.authRetryDelayMs);
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
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.add(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    this.handlers.delete(handler);
  }

  async dispose(): Promise<void> {
    await this.cancel();
    this.handlers.clear();
  }

  private emit(msg: AgentMessage): void {
    for (const handler of this.handlers) {
      handler(msg);
    }
  }
}
