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
import { resolveAgyBin, AGY_PRINT_TIMEOUT } from './constants';
import { buildAgyArgs } from './cliArgs';
import { AgyStream, isInvalidArgumentAgyError, isTransientAgyAuthError } from './stream';
import {
  repairCorruptedAgyConversationMedia,
  type AgyConversationMediaRepairResult,
} from './conversationRepair';

/** Signature of node's `spawn`, injectable so tests can supply a fake process. */
export type SpawnFn = typeof spawn;

const MAX_STDERR_BUFFER = 16 * 1024;
const DEFAULT_AUTH_RETRY_DELAY_MS = 3_500;
const AGY_AUTH_RETRY_PROMPT = '[System: Previous generation was interrupted by a transient OAuth token refresh (HTTP 401). Continue and complete the response to the latest user request from the current state without repeating already completed work.]';
const AGY_MEDIA_REPAIR_RETRY_PROMPT = '[System: Previous generation failed with HTTP 400 INVALID_ARGUMENT because a corrupted or truncated image file had been read into conversation history. The corrupted media payload has been sanitized in-place. Continue and complete the response to the latest user request without re-reading corrupted image files.]';

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
  /** Optional logger. */
  log?: (msg: string) => void;
  /** Injectable spawn (defaults to node's child_process.spawn). */
  spawnFn?: SpawnFn;
  /** Explicit native conversation; a workspace-wide cache is never a resume source. */
  conversationId?: string | null;
  onConversationId?: (id: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Optional override for corrupted conversation media repair (used by unit tests). */
  repairConversationMedia?: (conversationId: string) => AgyConversationMediaRepairResult;
}

/** Parse an agy duration string ("10m", "30s", "1h") to milliseconds; 0/0s disables the watchdog, other invalid strings default to 10m. */
export function parsePrintTimeoutMs(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '0') return null;
  const m = /^(\d+)\s*(s|m|h)$/.exec(trimmed);
  if (!m) return 10 * 60_000;
  const n = Number(m[1]);
  if (n === 0) return null;
  return m[2] === 'h' ? n * 3_600_000 : m[2] === 'm' ? n * 60_000 : n * 1_000;
}

type AttemptOutcome =
  | { ok: true }
  | {
      ok: false;
      detail: string;
      rawTurnError: string | null;
      stderrError: string | null;
      exitCode: number | null;
      sawInit: boolean;
      fatalSpawnError?: Error;
    };

export class AgyBackend implements AgentBackend {
  private readonly handlers = new Set<AgentMessageHandler>();
  private readonly cwd: string;
  private readonly printTimeout: string;
  private readonly authRetryDelayMs: number;
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
    this.printTimeout = opts.printTimeout ?? AGY_PRINT_TIMEOUT;
    this.authRetryDelayMs = opts.authRetryDelayMs ?? DEFAULT_AUTH_RETRY_DELAY_MS;
    this.log = opts.log ?? (() => {});
    this.spawnFn = opts.spawnFn ?? spawn;
    this.conversationId = opts.conversationId ?? null;
    this.onConversationId = opts.onConversationId;
    this.env = opts.env;
    this.repairConversationMedia =
      opts.repairConversationMedia ??
      ((id: string) => repairCorruptedAgyConversationMedia(id, { log: this.log }));
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
    for (let attempt = 0; attempt < 2; attempt++) {
      const outcome = await this.runSingleAttempt(currentPrompt);
      if (outcome.ok) {
        this.emit({ type: 'status', status: 'idle' });
        return;
      }
      if (outcome.fatalSpawnError) {
        this.emit({ type: 'status', status: 'error', detail: outcome.detail });
        throw outcome.fatalSpawnError;
      }
      if (
        attempt === 0 &&
        !this.cancelled &&
        (outcome.exitCode !== 0 || outcome.stderrError !== null) &&
        isTransientAgyAuthError(outcome.rawTurnError)
      ) {
        this.log('agy hit transient OAuth 401 during turn; waiting for token refresh and retrying once');
        await this.waitForAuthRetry();
        if (this.cancelled) {
          const detail = 'Antigravity turn cancelled';
          this.emit({ type: 'status', status: 'error', detail });
          throw new Error(detail);
        }
        currentPrompt = outcome.sawInit && this.conversationId ? AGY_AUTH_RETRY_PROMPT : prompt;
        continue;
      }
      if (
        attempt === 0 &&
        !this.cancelled &&
        this.conversationId &&
        (outcome.exitCode !== 0 || outcome.stderrError !== null) &&
        isInvalidArgumentAgyError(outcome.rawTurnError)
      ) {
        const repair = this.repairConversationMedia(this.conversationId);
        if (repair.repairedCount > 0) {
          this.log(
            `agy hit INVALID_ARGUMENT 400 from ${repair.repairedCount} corrupted media blob(s) in conversation ${this.conversationId} (steps: ${repair.repairedSteps.join(',')}); repaired in-place and retrying once`,
          );
          currentPrompt = outcome.sawInit ? AGY_MEDIA_REPAIR_RETRY_PROMPT : prompt;
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
      const watchdog = timeoutMs !== null ? setTimeout(() => {
        this.log(`agy turn exceeded ${this.printTimeout}; cancelling this CLI turn`);
        child.kill('SIGTERM');
      }, timeoutMs + 30_000) : null;
      const cleanup = () => {
        if (watchdog) clearTimeout(watchdog);
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
        if (stderrBuf.length < MAX_STDERR_BUFFER) {
          stderrBuf += chunk.slice(0, MAX_STDERR_BUFFER - stderrBuf.length);
        }
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
          fatalSpawnError: err,
        });
      });

      child.on('close', (code: number | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        const stderrError = extractAgyStderrError(stderrBuf);
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
        if (code === 0 && !protocolError) {
          resolve({ ok: true });
        } else {
          const detail = protocolError?.message ?? `agy exited with code ${code ?? 'null'}; check Google login and model access in the native CLI`;
          resolve({
            ok: false,
            detail,
            rawTurnError: stderrError ?? stream.getResultError(),
            stderrError,
            exitCode: code,
            sawInit: stream.didInit,
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
