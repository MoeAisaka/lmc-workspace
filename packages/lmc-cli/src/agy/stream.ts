import type { spawn } from 'node:child_process';
import type { AgentMessage } from '@/agent/core/AgentBackend';

/** Signature of node's `spawn`, injectable so tests can supply a fake process. */
export type SpawnFn = typeof spawn;

const MAX_STDERR_BUFFER = 16 * 1024;
const STDERR_HEAD_BYTES = 4 * 1024;

export function appendBoundedStderr(current: string, chunk: string, maxChars: number = MAX_STDERR_BUFFER): string {
  if (!chunk) return current;
  const combined = current + chunk;
  if (combined.length <= maxChars) return combined;
  const marker = '\n...\n';
  const headLen = Math.min(STDERR_HEAD_BYTES, Math.floor((maxChars - marker.length) / 2));
  const tailLen = Math.max(0, maxChars - headLen - marker.length);
  return combined.slice(0, headLen) + marker + combined.slice(combined.length - tailLen);
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

const object = (v: unknown): Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const MAX_LINE = 2 * 1024 * 1024;
export const GENERIC_AGY_RESULT_ERROR = 'Antigravity did not complete the turn; check Google login, model access and quota in the native CLI';

export class AgyTurnCancelledError extends Error {
  readonly code = 'AGY_TURN_CANCELLED';

  constructor(message = 'Antigravity turn cancelled') {
    super(message);
    this.name = 'AgyTurnCancelledError';
  }
}

export function isAgyTurnCancelledError(err: unknown): err is AgyTurnCancelledError {
  return (
    err instanceof AgyTurnCancelledError ||
    (err instanceof Error && (err as { code?: unknown }).code === 'AGY_TURN_CANCELLED')
  );
}

export function sanitizeAgyDiagnostic(raw: string): string {
  return raw
    .replace(/^AGY_ERROR:\s*/i, '')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[redacted]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/([?&](?:access_token|refresh_token|id_token|token|code|state|key)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

export function isTransientAgyAuthError(raw: string | null | undefined): boolean {
  if (!raw) return false;
  if (/\bnot logged in\b|\brun\s+agy\s+login\b|\bsign[ -]?in\b|\bregion\b/i.test(raw)) return false;
  return /\bUNAUTHENTICATED\b|\bcode\s*401\b|\binvalid authentication credentials\b/i.test(raw);
}

export function isInvalidArgumentAgyError(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return /\bINVALID_ARGUMENT\b|\bcode\s*400\b|\bRequest contains an invalid argument\b/i.test(raw);
}

/**
 * Identify transient upstream gRPC/HTTP2/SSE drops (e.g. `stream idle timeout (5m0s)`,
 * `The stream was interrupted`, `unexpected EOF`, `UNAVAILABLE (code 503)`, `rst_stream`)
 * that are safe to retry automatically on the existing native conversation.
 */
export function isTransientAgyStreamError(raw: string | null | undefined): boolean {
  if (!raw) return false;
  if (isTransientAgyAuthError(raw) || isInvalidArgumentAgyError(raw)) return false;
  if (/\bRESOURCE_EXHAUSTED\b|\bcode\s*429\b|\bquota\b|\brate[ -]?limit/i.test(raw)) return false;
  return /\bstream idle timeout\b|\bThe stream was interrupted\b|\bunexpected EOF\b|\bECONNRESET\b|\bETIMEDOUT\b|\bUNAVAILABLE\b[\s\S]*\bcode\s*503\b|\bINTERNAL\b[\s\S]*\brst_stream\b|\bACP server exited unexpectedly\b/i.test(
    raw,
  );
}

export function formatAgyTurnError(rawError: string | null | undefined, fallback: string = GENERIC_AGY_RESULT_ERROR): string {
  const clean = typeof rawError === 'string' ? sanitizeAgyDiagnostic(rawError) : '';
  if (!clean) return fallback;
  if (isTransientAgyAuthError(rawError)) {
    return 'Antigravity OAuth token expired mid-turn (UNAUTHENTICATED 401) and automatic refresh retry did not recover; check Google login in the native CLI or send "继续"';
  }
  if (/\bRESOURCE_EXHAUSTED\b|\bcode\s*429\b|\bquota\b|\brate[ -]?limit/i.test(clean)) {
    return `Antigravity quota or rate limit reached: ${clean}`;
  }
  if (/print timeout after/i.test(clean)) {
    return `Antigravity turn timed out: ${clean}`;
  }
  return `Antigravity did not complete the turn: ${clean}`;
}

export interface AgyFinishOptions {
  exitCode?: number | null;
  stderrError?: string | null;
  onRecoveredStaleError?: (staleError: string | null) => void;
}

/** Antigravity 1.4.x headless NDJSON. IDs come from this stream, never a cwd cache. */
export class AgyStream {
  private buffer = '';
  private output = false;
  private ended = false;
  private initSeen = false;
  private toolSeen = false;
  private resultStatus: string | null = null;
  private resultError: string | null = null;
  private resultFinishedReason: string | null = null;
  private resultResponse = '';
  private readonly usageSteps = new Set<number>();
  private readonly tools = new Map<string, boolean>();
  private conversation: string | null;

  constructor(private emit: (message: AgentMessage) => void, private onConversation: (id: string) => void, expected: string | null = null) {
    this.conversation = expected;
  }

  get hasEnded(): boolean {
    return this.ended;
  }

  get didInit(): boolean {
    return this.initSeen;
  }

  get sawToolActivity(): boolean {
    return this.toolSeen;
  }

  getResultError(): string | null {
    return this.resultError;
  }

  getFinishedReason(): string | null {
    return this.resultFinishedReason;
  }

  push(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > MAX_LINE) throw new Error('Antigravity stream record exceeds the supported limit');
      if (line) this.line(line);
    }
    if (this.buffer.length > MAX_LINE) throw new Error('Antigravity stream record exceeds the supported limit');
  }

  flushPendingLine(): void {
    const pending = this.buffer.trim();
    this.buffer = '';
    if (pending) {
      this.line(pending);
    }
  }

  finish(opts: AgyFinishOptions = {}): void {
    this.flushPendingLine();
    if (!this.ended) {
      if (opts.stderrError) throw new Error(formatAgyTurnError(opts.stderrError));
      throw new Error('Antigravity ended without a successful result; retry after checking its login and CLI version');
    }
    const exitCode = opts.exitCode ?? 0;
    const stderrError = opts.stderrError ?? null;
    const hasResponse = this.output || Boolean(this.resultResponse.trim());
    if (this.resultStatus !== 'SUCCESS') {
      // agy 1.4.x steps.BuildJSONOutput scans the entire resumed conversation history and leaves
      // result.status="ERROR" on subsequent turns if any earlier step in the conversation failed,
      // even when the current turn completed cleanly (exit 0, no AGY_ERROR marker, response present).
      if (exitCode === 0 && !stderrError && hasResponse) {
        opts.onRecoveredStaleError?.(this.resultError);
      } else {
        throw new Error(formatAgyTurnError(stderrError ?? this.resultError, GENERIC_AGY_RESULT_ERROR));
      }
    }
    if (!this.output && this.resultResponse) {
      this.emit({ type: 'model-output', textDelta: this.resultResponse });
    }
  }

  private identify(value: unknown): void {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(value)) throw new Error('Antigravity returned an invalid conversation ID');
    if (this.conversation && value !== this.conversation) throw new Error('Antigravity returned a different conversation; refusing to mix sessions');
    this.conversation = value;
    this.onConversation(value);
  }

  private line(line: string): void {
    let e: Record<string, any>;
    try { e = object(JSON.parse(line)); } catch { throw new Error('Invalid Antigravity structured output; upgrade the CLI and retry'); }
    if (this.ended) return;
    if (e.event === 'init') {
      this.identify(e.conversation_id);
      this.initSeen = true;
      return;
    }
    if (e.event === 'step_update') {
      const step = object(e.step_update);
      this.identify(step.conversation_id);
      if (step.state === 'DONE' && step.usage && Number.isSafeInteger(step.step_index) && step.step_index >= 0 && !this.usageSteps.has(step.step_index)) {
        this.usageSteps.add(step.step_index);
        this.emit({
          type: 'token-count',
          engine: 'agy',
          usage: step.usage,
          usageKey: `${this.conversation}:${step.step_index}`,
          stepIndex: step.step_index,
          scope: 'step',
        });
      }
      if (step.step_type === 'agent_response') {
        if (typeof step.text_delta === 'string' && step.text_delta) {
          this.output = true;
          this.emit({ type: 'model-output', textDelta: step.text_delta });
        }
        if (step.state === 'DONE' && this.output) {
          this.emit({ type: 'event', name: 'output-complete', payload: null });
        }
      }
      if (step.step_type === 'tool' || step.tool_info !== undefined || step.tool_name !== undefined) {
        this.toolSeen = true;
      }
      if (step.step_type === 'tool' && Number.isSafeInteger(step.step_index) && step.step_index >= 0) {
        const info = object(step.tool_info);
        const toolName = typeof step.tool_name === 'string' ? step.tool_name : typeof info.name === 'string' ? info.name : 'Antigravity tool';
        const callId = `${this.conversation}:${step.step_index}`;
        if (!this.tools.has(callId)) {
          this.tools.set(callId, false);
          this.emit({ type: 'tool-call', toolName, callId, args: object(info.parameters) });
        }
        if (step.state === 'DONE' && !this.tools.get(callId)) {
          this.tools.set(callId, true);
          this.emit({ type: 'tool-result', toolName, callId, result: info.error ? { error: info.error } : info.output ?? '' });
        }
      }
      return;
    }
    if (e.event === 'result') {
      const result = object(e.result);
      this.identify(result.conversation_id);
      if (result.usage && typeof result.usage === 'object') this.emit({ type: 'token-count', engine: 'agy', usage: result.usage });
      this.resultStatus = typeof result.status === 'string' ? result.status : null;
      this.resultError = typeof result.error === 'string' && result.error.trim() ? result.error.trim() : null;
      this.resultFinishedReason =
        typeof result.finished_reason === 'string' && result.finished_reason.trim()
          ? result.finished_reason.trim()
          : null;
      this.resultResponse = typeof result.response === 'string' ? result.response : '';
      this.ended = true;
    }
  }
}
