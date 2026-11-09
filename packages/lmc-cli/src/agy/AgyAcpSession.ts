import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { PermissionMode } from '@/api/types';
import type { AgentMessage } from '@/agent/core/AgentBackend';
import { sanitizeSessionEnvironment } from '@/daemon/sessionEnvironment';
import { resolveAgyBin } from './constants';
import { resolveDefaultAgyHomeDir } from './conversationRepair';
import {
  buildAgyAcpArgs,
  isSkipPermissionsMode,
  mapPermissionModeToAgyAcpMode,
} from './cliArgs';
import {
  checkAgyIdlePlannerStepFinalized,
  probeAgyAutonomousWakeupState,
  readAgyCompletedOutputBaseline,
  readAgyConversationGenMetadataSince,
  readAgyConversationStateSnapshot,
  type AgyConversationStateSnapshot,
} from './contextUsage';
import packageJson from '../../package.json';
import {
  AgyTurnCancelledError,
  appendBoundedStderr,
  extractAgyStderrError,
  formatAgyTurnError,
  GENERIC_AGY_RESULT_ERROR,
  isAgyTurnCancelledError,
  type SpawnFn,
} from './stream';

const VALID_CONVERSATION_ID = /^[a-zA-Z0-9_-]{1,200}$/;
const MAX_ACP_LINE_BYTES = 4 * 1024 * 1024;
const CONTROL_RPC_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_SIGTERM_MS = 1_000;
const DEFAULT_CLOSE_SIGKILL_MS = 2_000;
const POST_EXIT_STDIO_DRAIN_MS = 200;
const UNSAFE_SHUTDOWN_TIMEOUT_MESSAGE =
  'Antigravity ACP server did not exit within shutdown timeout; refusing unsafe state transition';
export const DEFAULT_MID_TURN_FLUSH_MS = 300;
const MAX_FAST_MID_TURN_FLUSH_POLLS = 10;
const SLOW_MID_TURN_FLUSH_MS = 1_000;
export const DEFAULT_AUTONOMOUS_POLL_MS = 1_000;
const AUTONOMOUS_TRANSCRIPT_TAIL_WINDOW_BYTES = 65_536;
const AUTONOMOUS_TRANSCRIPT_READ_CHUNK_BYTES = 65_536;
const AUTONOMOUS_ERROR_IDLE_TIMEOUT_MS = 45_000;
const AUTONOMOUS_GEN_METADATA_FALLBACK_MS = 5_000;
export const DEFAULT_ACP_CANCEL_GRACE_MS = 5_000;

export type AgyRetrySafety =
  | 'replay_original_prompt'
  | 'continue_persisted_turn'
  | 'unsafe_side_effects';

const RETRY_SAFETY_RANK: Record<AgyRetrySafety, number> = {
  replay_original_prompt: 0,
  continue_persisted_turn: 1,
  unsafe_side_effects: 2,
};

export function combineRetrySafety(a: AgyRetrySafety, b: AgyRetrySafety): AgyRetrySafety {
  return RETRY_SAFETY_RANK[a] >= RETRY_SAFETY_RANK[b] ? a : b;
}

export interface AgyAcpAttemptRef {
  readonly __brand: 'AgyAcpAttemptRef';
}

export interface AgyAcpRetryGate {
  readonly priorAttempts: readonly AgyAcpAttemptRef[];
  readonly baselineSafety: AgyRetrySafety;
  readonly replayPrompt: string;
  readonly continuationPrompt: string | null;
  readonly abortDetail: string;
  readonly abortRawTurnError: string | null;
}

interface AcpJsonRpcErrorPayload {
  code?: number;
  message?: string;
  data?: unknown;
}

class AcpRpcError extends Error {
  readonly rpcCode?: number;
  readonly rpcData?: unknown;

  constructor(method: string, err: AcpJsonRpcErrorPayload) {
    const rawMsg =
      typeof err?.message === 'string' && err.message.trim()
        ? err.message.trim()
        : `ACP ${method} failed`;
    const dataText =
      typeof err?.data === 'string' && err.data.trim()
        ? `${rawMsg}: ${err.data.trim()}`
        : err?.data && typeof err.data === 'object'
          ? `${rawMsg}: ${JSON.stringify(err.data)}`
          : rawMsg;
    super(dataText);
    this.name = 'AcpRpcError';
    this.rpcCode = typeof err?.code === 'number' ? err.code : undefined;
    this.rpcData = err?.data;
  }
}

class AcpProcessClosedError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrError: string | null;
  readonly intentional: boolean;

  constructor(
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    stderrError: string | null,
    intentional: boolean,
  ) {
    super(
      stderrError
        ? `ACP server exited unexpectedly (code ${exitCode ?? 'null'}): ${stderrError}`
        : `ACP server exited unexpectedly (code ${exitCode ?? 'null'}${signal ? `, signal ${signal}` : ''})`,
    );
    this.name = 'AcpProcessClosedError';
    this.exitCode = exitCode;
    this.signal = signal;
    this.stderrError = stderrError;
    this.intentional = intentional;
  }
}

interface PendingRpc {
  method: string;
  expectObjectResult: boolean;
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface AcpProcessHandle {
  gen: number;
  readonly child: ChildProcess;
  readonly bypassPermissions: boolean;
  readonly pendingRpcs: Map<number, PendingRpc>;
  readonly exitedPromise: Promise<void>;
  markExited: () => void;
  exited: boolean;
  osExited: boolean;
  stdioClosed: boolean;
  dead: boolean;
  hasSpawnedEvent: boolean;
  hasCommunicated: boolean;
  closingIntentionally: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  fatalSpawnError: Error | null;
  postExitDrainTimer: ReturnType<typeof setTimeout> | null;
  lastPromptTurn: ActiveTurnState | null;
  stdoutBuf: string;
  startupStderrBuf: string;
  loggedStderrDiagnostic: boolean;
}

type TokenDim = 'input' | 'output' | 'cacheRead';
const TOKEN_DIMS: readonly TokenDim[] = ['input', 'output', 'cacheRead'];

interface TokenCounterTriple {
  input: number;
  output: number;
  cacheRead: number;
}

type RowUsageOwner =
  | { kind: 'known'; model: string | null; startedAt: number; turnSeq: number }
  | { kind: 'unknown'; candidateTurnSeqs: number[] };

interface FinalizedUsageRow {
  readonly rowIdx: number;
  readonly owner: RowUsageOwner;
  readonly raw: TokenCounterTriple;
  readonly matchedByTurn: Map<number, TokenCounterTriple>;
  readonly emittedNet: TokenCounterTriple;
  readonly usageModel: string | null;
  readonly usageStartedAt: number | undefined;
  reconcileEmitSeq: number;
}

interface TurnUsageRecord {
  readonly turnSeq: number;
  procGen: number;
  readonly turnInstanceId: string;
  readonly model: string | null;
  readonly startedAt: number;
  preMaxStepIdx: number | null;
  closedMaxStepIdx: number | null;
  expectedPromptUsage: TokenCounterTriple | null;
  reconciledKnownSqlTokens: TokenCounterTriple;
  fallbackCredit: TokenCounterTriple;
  unfinishedKnownRows: Set<number>;
  procExitedAfterScan: boolean;
  hadGenerationOpportunity: boolean;
}

interface PersistedPendingBillingEmission {
  usageKey: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    total_tokens: number;
  };
  usageModel: string | null;
  usageStartedAt?: number;
}

export class AgyUnseededBaselineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgyUnseededBaselineError';
  }
}

export interface AgyUsageHandoffFs {
  statSync: (path: string) => unknown;
  mkdirSync: (path: string, options?: { recursive?: boolean; mode?: number }) => void;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  openSync: (path: string, flags: string | number, mode?: number) => number;
  writeFileSync: (file: number, data: string, options?: { encoding?: BufferEncoding }) => void;
  fsyncSync: (fd: number) => void;
  closeSync: (fd: number) => void;
  chmodSync: (path: string, mode: number) => void;
  renameSync: (oldPath: string, newPath: string) => void;
  unlinkSync: (path: string) => void;
}

const DEFAULT_USAGE_HANDOFF_FS: AgyUsageHandoffFs = {
  statSync: (p) => statSync(p),
  mkdirSync: (p, o) => {
    mkdirSync(p, o);
  },
  readFileSync: (p, enc) => readFileSync(p, enc),
  openSync: (p, flags, mode) => openSync(p, flags, mode),
  writeFileSync: (fd, data, o) => writeFileSync(fd, data, o),
  fsyncSync: (fd) => fsyncSync(fd),
  closeSync: (fd) => closeSync(fd),
  chmodSync: (p, mode) => chmodSync(p, mode),
  renameSync: (oldP, newP) => renameSync(oldP, newP),
  unlinkSync: (p) => unlinkSync(p),
};

interface ConversationUsageLedger {
  seeded: boolean;
  baselineMaxGenIdx: number;
  emittedRowIndices: Set<number>;
  rowOwners: Map<number, RowUsageOwner>;
  finalizedRows: FinalizedUsageRow[];
  turns: Map<number, TurnUsageRecord>;
  pendingDurableEmissions: Map<string, PersistedPendingBillingEmission>;
  hadUncertainTurnBoundary: boolean;
  loadedFromHandoff?: boolean;
  loadedFromFallback?: boolean;
  corruptHandoffError: Error | null;
}

interface PersistedConversationUsageHandoffV1 {
  version: 1;
  conversationId: string;
  persistedAt?: number;
  nextProcessGen: number;
  nextTurnSeq: number;
  seeded: boolean;
  baselineMaxGenIdx: number;
  emittedRowIndices: number[];
  rowOwners: Array<[number, RowUsageOwner]>;
  finalizedRows: Array<{
    rowIdx: number;
    owner: RowUsageOwner;
    raw: TokenCounterTriple;
    matchedByTurn: Array<[number, TokenCounterTriple]>;
    emittedNet: TokenCounterTriple;
    usageModel: string | null;
    usageStartedAt?: number;
    reconcileEmitSeq: number;
  }>;
  turns: Array<{
    turnSeq: number;
    procGen: number;
    turnInstanceId?: string;
    model: string | null;
    startedAt: number;
    preMaxStepIdx: number | null;
    closedMaxStepIdx: number | null;
    expectedPromptUsage: TokenCounterTriple | null;
    reconciledKnownSqlTokens: TokenCounterTriple;
    fallbackCredit: TokenCounterTriple;
    unfinishedKnownRows: number[];
    procExitedAfterScan: boolean;
    hadGenerationOpportunity: boolean;
  }>;
  pendingDurableEmissions?: PersistedPendingBillingEmission[];
  hadUncertainTurnBoundary: boolean;
}

interface ActiveTurnState {
  turnSeq: number;
  readonly requestedModel: string | null;
  effectiveModel: string | null;
  readonly turnStartedAt: number;
  attemptProc: AcpProcessHandle | null;
  prePromptScanReadOk: boolean;
  hadAmbiguousPriorDelayedTurnsAtStart: boolean;
  observedNewGenRowIndices: Set<number>;
  sessionId: string | null;
  cancelled: boolean;
  inSetupPhase: boolean;
  inPromptPhase: boolean;
  enteredPromptPhase: boolean;
  promptWriteCompleted: boolean;
  sawAnyTurnStreamEvent: boolean;
  sawOutput: boolean;
  sawToolActivity: boolean;
  undrainedStdio: boolean;
  pendingUnflushedOutput: boolean;
  midTurnFlushTimer: ReturnType<typeof setTimeout> | null;
  midTurnFlushPolls: number;
  outputStepBaselineIdx: number;
  outputGenBaselineIdx: number;
  cancelGraceTimer: ReturnType<typeof setTimeout> | null;
  emittedToolCalls: Set<string>;
  completedToolCalls: Set<string>;
  toolNames: Map<string, string>;
  sqlTokens: TokenCounterTriple;
  emittedStepCount: number;
  prePromptSnap: AgyConversationStateSnapshot | null;
  abortReason: Error | null;
  forceSettlePrompt: ((err: Error) => void) | null;
}

export type AgyAcpTurnOutcome =
  | {
      ok: true;
      stopReason: string;
    }
  | {
      ok: false;
      cancelled?: boolean;
      abortedRetryBeforePrompt?: boolean;
      detail: string;
      rawTurnError: string | null;
      stderrError: string | null;
      exitCode: number | null;
      promptDispatched: boolean;
      retrySafety: AgyRetrySafety;
      attemptRef?: AgyAcpAttemptRef;
      unexpectedProcessExit?: boolean;
      unseededBaseline?: boolean;
      unkillableProcess?: boolean;
      fatalSpawnError?: Error;
    };

export interface AgyAcpSessionOptions {
  cwd: string;
  spawnFn: SpawnFn;
  env?: NodeJS.ProcessEnv;
  agyHomeDir?: string;
  usageHandoffFs?: Partial<AgyUsageHandoffFs>;
  confirmUsageDurable?: () => Promise<void>;
  loadFallbackHandoff?: (conversationId: string) => string | null | undefined;
  persistFallbackHandoff?: (
    conversationId: string,
    serializedHandoff: string | null,
  ) => Promise<void>;
  log: (msg: string) => void;
  emit: (msg: AgentMessage) => void;
  getConversationId: () => string | null;
  setConversationId: (id: string) => void;
  midTurnFlushMs?: number;
  autonomousPollMs?: number;
  cancelGraceMs?: number;
  closeSigtermMs?: number;
  closeSigkillMs?: number;
}

export interface CloseProcessOptions {
  requireExit?: boolean;
  dispose?: boolean;
  handoff?: boolean;
}

const VALID_ACP_STOP_REASONS = new Set([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
]);

function validateAcpMethodResult(method: string, result: unknown): string | null {
  if (!isPlainObject(result)) {
    return `Invalid Antigravity ACP ${method} result: expected object`;
  }
  switch (method) {
    case 'initialize': {
      if (
        typeof result.protocolVersion !== 'number' ||
        !Number.isSafeInteger(result.protocolVersion) ||
        result.protocolVersion < 1
      ) {
        return 'Invalid Antigravity ACP initialize result: missing or invalid protocolVersion';
      }
      if (result.agentCapabilities !== undefined && !isPlainObject(result.agentCapabilities)) {
        return 'Invalid Antigravity ACP initialize result: invalid agentCapabilities';
      }
      if (result.agentInfo !== undefined && !isPlainObject(result.agentInfo)) {
        return 'Invalid Antigravity ACP initialize result: invalid agentInfo';
      }
      return null;
    }
    case 'session/new': {
      if (typeof result.sessionId !== 'string' || !VALID_CONVERSATION_ID.test(result.sessionId)) {
        return 'Invalid Antigravity ACP session/new result: missing or invalid sessionId';
      }
      if (result.models !== undefined && !isPlainObject(result.models)) {
        return 'Invalid Antigravity ACP session/new result: invalid models catalog';
      }
      if (result.modes !== undefined && !isPlainObject(result.modes)) {
        return 'Invalid Antigravity ACP session/new result: invalid modes catalog';
      }
      return null;
    }
    case 'session/resume': {
      if (
        result.sessionId !== undefined &&
        (typeof result.sessionId !== 'string' || !VALID_CONVERSATION_ID.test(result.sessionId))
      ) {
        return 'Invalid Antigravity ACP session/resume result: invalid sessionId';
      }
      if (result.models !== undefined && !isPlainObject(result.models)) {
        return 'Invalid Antigravity ACP session/resume result: invalid models catalog';
      }
      if (result.modes !== undefined && !isPlainObject(result.modes)) {
        return 'Invalid Antigravity ACP session/resume result: invalid modes catalog';
      }
      return null;
    }
    case 'session/set_mode':
    case 'session/set_model':
      return null;
    case 'session/prompt': {
      if (typeof result.stopReason !== 'string' || !VALID_ACP_STOP_REASONS.has(result.stopReason)) {
        return 'Invalid Antigravity ACP session/prompt result: missing or unsupported stopReason';
      }
      if (result.usage !== undefined && result.usage !== null && !isPlainObject(result.usage)) {
        return 'Invalid Antigravity ACP session/prompt result: invalid usage payload';
      }
      return null;
    }
    default:
      return null;
  }
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function asPlainObject(v: unknown): Record<string, any> {
  return isPlainObject(v) ? v : {};
}

function toSafeNonNegInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function safeAddNonNegInt(a: number, b: number): number | null {
  if (!Number.isSafeInteger(a) || a < 0 || !Number.isSafeInteger(b) || b < 0) {
    return null;
  }
  const sum = a + b;
  return Number.isSafeInteger(sum) ? sum : null;
}

function saturatingSafeAdd(a: number, b: number): number {
  const sum = safeAddNonNegInt(a, b);
  return sum !== null ? sum : Number.MAX_SAFE_INTEGER;
}

function parseAcpPromptTurnUsage(raw: unknown): TokenCounterTriple | null {
  if (!isPlainObject(raw)) return null;
  const rawIn = raw.inputTokens ?? raw.input_tokens;
  const rawOut = raw.outputTokens ?? raw.output_tokens;
  const rawThought = raw.thoughtTokens ?? raw.thinking_tokens ?? 0;
  const rawCache = raw.cachedReadTokens ?? raw.cacheReadTokens ?? raw.cache_read_tokens ?? 0;
  const rawTotal = raw.totalTokens ?? raw.total_tokens;

  const input = rawIn === undefined ? 0 : toSafeNonNegInt(rawIn);
  const output = rawOut === undefined ? 0 : toSafeNonNegInt(rawOut);
  const thought = toSafeNonNegInt(rawThought);
  const cacheRead = toSafeNonNegInt(rawCache);
  if (input === null || output === null || thought === null || cacheRead === null) {
    return null;
  }

  // In native `agy acp`, `outputTokens` already includes `thoughtTokens`
  // (`totalTokens === inputTokens + outputTokens`, matching SQLite `ModelUsageStats`).
  // Only add `thought` when an explicit `totalTokens` proves `output` excluded `thought`,
  // or when `output === 0 && thought > 0 && rawTotal === undefined`.
  let resolvedOutput = output;
  const explicitTotal = rawTotal !== undefined ? toSafeNonNegInt(rawTotal) : null;
  if (rawTotal !== undefined && explicitTotal === null) {
    return null;
  }
  if (thought > 0) {
    const outPlusThought = safeAddNonNegInt(output, thought);
    if (outPlusThought === null) return null;
    const directSum = safeAddNonNegInt(input, output);
    const combinedSum = safeAddNonNegInt(input, outPlusThought);
    if (explicitTotal !== null) {
      if (directSum === explicitTotal) {
        resolvedOutput = output;
      } else if (combinedSum === explicitTotal) {
        resolvedOutput = outPlusThought;
      }
    } else if (output === 0) {
      resolvedOutput = outPlusThought;
    }
  }

  const nativeTotal = safeAddNonNegInt(input, resolvedOutput);
  if (nativeTotal === null) return null;
  const allWork = safeAddNonNegInt(nativeTotal, cacheRead);
  if (allWork === null || allWork <= 0) return null;

  return { input, output: resolvedOutput, cacheRead };
}

function extractTextFromContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      const obj = asPlainObject(item);
      if (typeof obj.text === 'string') {
        parts.push(obj.text);
      } else if (obj.content && typeof obj.content === 'object') {
        const inner = asPlainObject(obj.content);
        if (typeof inner.text === 'string') parts.push(inner.text);
      }
    }
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  if (content && typeof content === 'object') {
    const obj = asPlainObject(content);
    if (typeof obj.text === 'string') return obj.text;
    if (obj.content && typeof obj.content === 'object') {
      const inner = asPlainObject(obj.content);
      if (typeof inner.text === 'string') return inner.text;
    }
  }
  return undefined;
}

function extractToolName(update: Record<string, any>, remembered?: string): string {
  for (const candidate of [update.name, remembered, update.kind, update.title]) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return 'Antigravity tool';
}

function extractToolArgs(update: Record<string, any>): Record<string, unknown> {
  if (isPlainObject(update.args)) {
    return update.args as Record<string, unknown>;
  }
  if (isPlainObject(update.rawInput)) {
    return update.rawInput as Record<string, unknown>;
  }
  return {};
}

function extractToolResultValue(update: Record<string, any>): unknown {
  if (update.rawOutput !== undefined) {
    if (
      isPlainObject(update.rawOutput) &&
      typeof (update.rawOutput as { output?: unknown }).output === 'string'
    ) {
      return (update.rawOutput as { output: string }).output;
    }
    return update.rawOutput;
  }
  const text = extractTextFromContent(update.content);
  if (text !== undefined) return text;
  return '';
}

function extractToolErrorMessage(update: Record<string, any>, status: string): string {
  if (isPlainObject(update.rawOutput)) {
    const ro = update.rawOutput;
    if (typeof ro.error === 'string' && ro.error.trim()) return ro.error.trim();
    if (typeof ro.output === 'string' && ro.output.trim()) return ro.output.trim();
  }
  const text = extractTextFromContent(update.content);
  if (text && text.trim()) return text.trim();
  return `Tool call ${status}`;
}

const ALLOW_KINDS = new Set(['allow_once', 'allow_always']);
const REJECT_KINDS = new Set(['reject_once', 'reject_always']);

function selectAuthorizedPermissionOption(
  rawOptions: unknown,
  allow: boolean,
): { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } {
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
    return { outcome: 'cancelled' };
  }

  const options: Array<{ optionId: string; kind: string }> = [];
  const kindsById = new Map<string, Set<string>>();

  for (const raw of rawOptions) {
    if (!isPlainObject(raw)) continue;
    const optionId = typeof raw.optionId === 'string' ? raw.optionId.trim() : '';
    const kind = typeof raw.kind === 'string' ? raw.kind.trim() : '';
    if (!optionId || !kind) continue;
    options.push({ optionId, kind });
    let seen = kindsById.get(optionId);
    if (!seen) {
      seen = new Set<string>();
      kindsById.set(optionId, seen);
    }
    seen.add(kind);
  }

  const preferredKinds = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  const allowedKindSet = allow ? ALLOW_KINDS : REJECT_KINDS;

  for (const preferredKind of preferredKinds) {
    for (const candidate of options) {
      if (candidate.kind !== preferredKind) continue;
      const allKindsForId = kindsById.get(candidate.optionId);
      // Reject ambiguous/contradictory optionIds that map to conflicting kinds.
      if (!allKindsForId || [...allKindsForId].some((k) => !allowedKindSet.has(k))) {
        return { outcome: 'cancelled' };
      }
      return { outcome: 'selected', optionId: candidate.optionId };
    }
  }

  return { outcome: 'cancelled' };
}

export class AgyAcpSession {
  private readonly cwd: string;
  private readonly spawnFn: SpawnFn;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly agyHomeDir?: string;
  private readonly handoffFs: AgyUsageHandoffFs;
  private readonly confirmUsageDurable?: () => Promise<void>;
  private readonly loadFallbackHandoff?: (conversationId: string) => string | null | undefined;
  private readonly persistFallbackHandoff?: (
    conversationId: string,
    serializedHandoff: string | null,
  ) => Promise<void>;
  private readonly log: (msg: string) => void;
  private readonly emit: (msg: AgentMessage) => void;
  private readonly getConversationId: () => string | null;
  private readonly setConversationId: (id: string) => void;
  private readonly midTurnFlushMs: number;
  private readonly autonomousPollMs: number;
  private readonly cancelGraceMs: number;
  private readonly closeSigtermMs: number;
  private readonly closeSigkillMs: number;

  private readonly sessionInstanceId = randomUUID();
  private proc: AcpProcessHandle | null = null;
  private nextProcessGen = 0;
  private nextRpcId = 1;
  private nextTurnSeq = 0;
  private disposed = false;
  private readonly unkillableHandles = new Set<AcpProcessHandle>();
  private readonly retiringProcesses = new Set<Promise<boolean>>();
  private turnChain: Promise<void> = Promise.resolve();

  private lastExitCode: number | null = null;
  private turnStderrBuf = '';

  private initialized = false;
  private activeSessionId: string | null = null;
  private availableModels: Array<{ modelId?: string; name?: string }> = [];
  private availableModeIds: string[] = [];
  private initialDefaultModelId: string | null = null;
  private appliedModelId: string | null = null;
  private appliedModeId: string | null = null;

  private currentPermissionMode: PermissionMode = 'default';
  private pendingTurnCancel = false;
  private activeTurn: ActiveTurnState | null = null;
  private lastSettledAttemptTurn: ActiveTurnState | null = null;

  private autonomousPollTimer: ReturnType<typeof setTimeout> | null = null;
  private autonomousSessionId: string | null = null;
  private autonomousBaselineStepIdx = -1;
  private autonomousEmittedStepIdx = -1;
  private autonomousTurnActive = false;
  private autonomousTurnSeq: number | null = null;
  private autonomousTranscriptPath: string | null = null;
  private autonomousTranscriptOffset = 0;
  private autonomousSkipPartialFirstLine = false;
  private autonomousPendingToolCalls: Array<{ callId: string; toolName: string }> = [];
  private autonomousLastPlannerHadToolCalls = false;
  private autonomousLastObservedMaxStepIdx = -1;
  private autonomousLastObservedStepStatus = -1;
  private autonomousLastStepChangeAt = 0;
  private autonomousIdleSettlePolls = 0;
  private needsHistorySkipBeforeNextPrompt = false;

  private readonly usageLedgers = new Map<string, ConversationUsageLedger>();
  private readonly emittedInCurrentProcess = new Set<string>();
  private lastClosePersistFailed = false;

  constructor(opts: AgyAcpSessionOptions) {
    this.cwd = opts.cwd;
    this.spawnFn = opts.spawnFn;
    this.env = opts.env;
    this.agyHomeDir = opts.agyHomeDir;
    this.handoffFs = opts.usageHandoffFs
      ? { ...DEFAULT_USAGE_HANDOFF_FS, ...opts.usageHandoffFs }
      : DEFAULT_USAGE_HANDOFF_FS;
    this.confirmUsageDurable = opts.confirmUsageDurable;
    this.loadFallbackHandoff = opts.loadFallbackHandoff;
    this.persistFallbackHandoff = opts.persistFallbackHandoff;
    this.log = opts.log;
    this.emit = opts.emit;
    this.getConversationId = opts.getConversationId;
    this.setConversationId = opts.setConversationId;
    this.midTurnFlushMs = opts.midTurnFlushMs ?? DEFAULT_MID_TURN_FLUSH_MS;
    this.autonomousPollMs = opts.autonomousPollMs ?? DEFAULT_AUTONOMOUS_POLL_MS;
    this.cancelGraceMs = opts.cancelGraceMs ?? DEFAULT_ACP_CANCEL_GRACE_MS;
    this.closeSigtermMs = opts.closeSigtermMs ?? DEFAULT_CLOSE_SIGTERM_MS;
    this.closeSigkillMs = opts.closeSigkillMs ?? DEFAULT_CLOSE_SIGKILL_MS;
    const initialConvId = this.getConversationId();
    if (initialConvId) {
      this.getOrCreateLedger(initialConvId);
    }
  }

  get isAlive(): boolean {
    return this.proc !== null && !this.proc.dead && !this.proc.exited && !this.proc.osExited;
  }

  get hasUnconfirmedChildExit(): boolean {
    return (
      this.proc !== null ||
      this.retiringProcesses.size > 0 ||
      this.unkillableHandles.size > 0
    );
  }

  get hasUnpersistedCloseState(): boolean {
    return this.lastClosePersistFailed;
  }

  async recoverPersistedUsageOnStartup(): Promise<void> {
    const initialConvId = this.getConversationId();
    if (!initialConvId) return;
    const ledger = this.getOrCreateLedger(initialConvId);
    if (ledger.corruptHandoffError !== null) {
      return;
    }
    const hasFallback =
      Boolean(ledger.loadedFromFallback) ||
      Boolean(this.loadFallbackHandoff?.(initialConvId));
    if (!ledger.loadedFromHandoff && !hasFallback && ledger.pendingDurableEmissions.size === 0) {
      return;
    }

    this.replayUnemittedPendingEmissions(ledger);
    const readOk = this.syncSqlStepUsage(initialConvId, null, {
      deferCurrentTurnUnknownRows: false,
    });
    if (readOk) {
      for (const rec of ledger.turns.values()) {
        if (rec.turnInstanceId !== this.sessionInstanceId) {
          rec.procExitedAfterScan = true;
        }
      }
      if (this.openInsertCapableTurns(ledger).length === 0) {
        ledger.hadUncertainTurnBoundary = false;
      }
    }

    if (!(await this.confirmPendingDurableEmissions(ledger))) {
      return;
    }

    const unresolved =
      !ledger.seeded ||
      !readOk ||
      ledger.rowOwners.size > 0 ||
      ledger.pendingDurableEmissions.size > 0 ||
      ledger.hadUncertainTurnBoundary ||
      Array.from(ledger.turns.values()).some(
        (t) =>
          t.unfinishedKnownRows.size > 0 ||
          (t.hadGenerationOpportunity && !t.procExitedAfterScan),
      );

    if (!unresolved) {
      try {
        this.removePersistedUsageHandoff(initialConvId);
        if (hasFallback && this.persistFallbackHandoff) {
          await this.persistFallbackHandoff(initialConvId, null);
        }
        ledger.loadedFromHandoff = false;
        ledger.loadedFromFallback = false;
      } catch {
        // Keep loadedFromHandoff/loadedFromFallback true so terminal close retries cleanup.
      }
    }
  }

  clearPendingCancel(): void {
    if (!this.disposed) {
      this.pendingTurnCancel = false;
    }
  }

  async runTurn(opts: {
    prompt: string;
    model?: string;
    permissionMode: PermissionMode;
    turnTimeoutMs?: number | null;
    turnStartedAt?: number;
    retryGate?: AgyAcpRetryGate;
  }): Promise<AgyAcpTurnOutcome> {
    let releaseTurnSlot!: () => void;
    const prevTurn = this.turnChain;
    this.turnChain = new Promise<void>((resolve) => {
      releaseTurnSlot = resolve;
    });

    await prevTurn;
    try {
      return await this.executeSerializedTurn(opts);
    } finally {
      releaseTurnSlot();
    }
  }

  private async executeSerializedTurn(opts: {
    prompt: string;
    model?: string;
    permissionMode: PermissionMode;
    turnTimeoutMs?: number | null;
    turnStartedAt?: number;
    retryGate?: AgyAcpRetryGate;
  }): Promise<AgyAcpTurnOutcome> {
    await this.awaitRetirementBarrier(false);
    this.suspendAutonomousMonitorForPrompt();

    if (this.unkillableHandles.size > 0) {
      return {
        ok: false,
        detail: UNSAFE_SHUTDOWN_TIMEOUT_MESSAGE,
        rawTurnError: UNSAFE_SHUTDOWN_TIMEOUT_MESSAGE,
        stderrError: null,
        exitCode: null,
        promptDispatched: false,
        retrySafety: 'unsafe_side_effects',
        unkillableProcess: true,
      };
    }

    if (this.disposed || this.pendingTurnCancel) {
      if (!this.disposed) {
        this.pendingTurnCancel = false;
      }
      return {
        ok: false,
        cancelled: true,
        detail: 'Antigravity turn cancelled',
        rawTurnError: null,
        stderrError: null,
        exitCode: this.lastExitCode,
        promptDispatched: false,
        retrySafety: 'replay_original_prompt',
      };
    }

    this.currentPermissionMode = opts.permissionMode;
    this.turnStderrBuf = '';

    const normalizedReqModel =
      typeof opts.model === 'string' && opts.model.trim() && opts.model.trim() !== 'default'
        ? opts.model.trim()
        : null;
    const resolvedStartedAt =
      typeof opts.turnStartedAt === 'number' && Number.isFinite(opts.turnStartedAt) && opts.turnStartedAt > 0
        ? opts.turnStartedAt
        : Date.now();

    const preAllocConvId = this.activeSessionId ?? this.getConversationId();
    if (preAllocConvId) {
      this.getOrCreateLedger(preAllocConvId);
    }

    const turn: ActiveTurnState = {
      turnSeq: ++this.nextTurnSeq,
      requestedModel: normalizedReqModel,
      effectiveModel: normalizedReqModel,
      turnStartedAt: resolvedStartedAt,
      attemptProc: null,
      prePromptScanReadOk: false,
      hadAmbiguousPriorDelayedTurnsAtStart: false,
      observedNewGenRowIndices: new Set<number>(),
      sessionId: null,
      cancelled: false,
      inSetupPhase: true,
      inPromptPhase: false,
      enteredPromptPhase: false,
      promptWriteCompleted: false,
      sawAnyTurnStreamEvent: false,
      sawOutput: false,
      sawToolActivity: false,
      undrainedStdio: false,
      pendingUnflushedOutput: false,
      midTurnFlushTimer: null,
      midTurnFlushPolls: 0,
      outputStepBaselineIdx: -1,
      outputGenBaselineIdx: -1,
      cancelGraceTimer: null,
      emittedToolCalls: new Set<string>(),
      completedToolCalls: new Set<string>(),
      toolNames: new Map<string, string>(),
      sqlTokens: { input: 0, output: 0, cacheRead: 0 },
      emittedStepCount: 0,
      prePromptSnap: null,
      abortReason: null,
      forceSettlePrompt: null,
    };
    this.activeTurn = turn;
    const attemptRef = turn as unknown as AgyAcpAttemptRef;

    let setupProc: AcpProcessHandle | null = null;
    let postPromptSnap: AgyConversationStateSnapshot | null = null;

    try {
      const wantBypass = isSkipPermissionsMode(opts.permissionMode);
      if (this.proc && !this.proc.dead && this.proc.bypassPermissions !== wantBypass) {
        this.log(
          `agy ACP permission boundary changed (bypass=${this.proc.bypassPermissions} -> ${wantBypass}); cycling ACP server and resuming session`,
        );
        await this.closeProcess({ requireExit: true });
      }
      this.assertTurnNotCancelled(turn);

      setupProc = await this.ensureSessionReady(turn, opts.permissionMode, opts.model);
      turn.attemptProc = setupProc;
      await this.awaitProcessPostExitDrain(setupProc);
      await this.awaitRetirementBarrier(false);
      this.assertTurnNotCancelled(turn);

      if (this.unkillableHandles.size > 0) {
        return {
          ok: false,
          detail: UNSAFE_SHUTDOWN_TIMEOUT_MESSAGE,
          rawTurnError: UNSAFE_SHUTDOWN_TIMEOUT_MESSAGE,
          stderrError: null,
          exitCode: null,
          promptDispatched: false,
          retrySafety: 'unsafe_side_effects',
          attemptRef,
          unkillableProcess: true,
        };
      }

      if (
        this.proc !== setupProc ||
        setupProc.dead ||
        setupProc.exited ||
        setupProc.osExited ||
        !setupProc.child.stdin?.writable
      ) {
        throw new AcpProcessClosedError(
          setupProc.exitCode,
          setupProc.exitSignal,
          extractAgyStderrError(this.turnStderrBuf || setupProc.startupStderrBuf),
          setupProc.closingIntentionally,
        );
      }

      const sessionId = this.activeSessionId!;
      turn.sessionId = sessionId;
      turn.inSetupPhase = false;

      // Flush any delayed SQLite rows from earlier turns BEFORE starting this prompt so
      // prior-turn rows preserve their original turn ownership or explicit unknown state.
      turn.prePromptScanReadOk = this.reconcilePrePromptUsage(sessionId, setupProc.gen);
      const ledger = this.getOrCreateLedger(sessionId);
      if (ledger.corruptHandoffError !== null) {
        throw ledger.corruptHandoffError;
      }
      if (!ledger.seeded) {
        throw new AgyUnseededBaselineError(
          'Failed to read Antigravity conversation database before prompt; refusing to dispatch with unseeded usage baseline',
        );
      }
      turn.effectiveModel = this.appliedModelId ?? turn.requestedModel;
      turn.prePromptSnap = readAgyConversationStateSnapshot(sessionId, {
        agyHomeDir: this.agyHomeDir,
      });
      if (turn.prePromptSnap.dbExists && turn.prePromptSnap.readOk) {
        turn.outputStepBaselineIdx = turn.prePromptSnap.maxStepIdx;
        turn.outputGenBaselineIdx = turn.prePromptSnap.maxGenIdx;
      }

      // Synchronous pre-write retry gate: re-verify ALL prior attempts of the outer
      // `sendPrompt` call AFTER every async setup RPC (`set_mode`/`set_model`/`resume`)
      // and with ZERO `await` before writing `session/prompt` to stdin.
      let effectivePrompt = opts.prompt;
      if (opts.retryGate) {
        const gateSafety = this.evaluatePriorAttemptsRetrySafetySync(
          opts.retryGate.priorAttempts,
          opts.retryGate.baselineSafety,
        );
        if (gateSafety === 'unsafe_side_effects') {
          this.log(
            'agy observed late tool activity or unverified conversation state during retry setup; aborting retry before session/prompt write',
          );
          return {
            ok: false,
            abortedRetryBeforePrompt: true,
            detail: opts.retryGate.abortDetail,
            rawTurnError: opts.retryGate.abortRawTurnError,
            stderrError: null,
            exitCode: this.lastExitCode,
            promptDispatched: true,
            retrySafety: 'unsafe_side_effects',
            attemptRef,
          };
        }
        effectivePrompt =
          gateSafety === 'continue_persisted_turn' && opts.retryGate.continuationPrompt !== null
            ? opts.retryGate.continuationPrompt
            : opts.retryGate.replayPrompt;
      }

      turn.hadAmbiguousPriorDelayedTurnsAtStart =
        ledger.hadUncertainTurnBoundary || this.openInsertCapableTurns(ledger).length > 0;
      this.registerTurnUsageRecord(ledger, turn, setupProc.gen);

      setupProc.lastPromptTurn = turn;
      turn.inPromptPhase = true;
      turn.enteredPromptPhase = true;
      const forcePromptSettlePromise = new Promise<never>((_, reject) => {
        turn.forceSettlePrompt = (err: Error) => reject(err);
      });

      let clearTurnWatchdog: (() => void) | null = null;
      if (typeof opts.turnTimeoutMs === 'number' && opts.turnTimeoutMs > 0) {
        clearTurnWatchdog = this.armLongTimeout(() => {
          this.log(`agy ACP turn exceeded timeout (${opts.turnTimeoutMs}ms); cancelling prompt`);
          this.initiatePromptSettlement(
            turn,
            new Error('Antigravity turn timed out: print timeout after configured limit'),
          );
        }, opts.turnTimeoutMs);
      }

      let promptResult: Record<string, any>;
      try {
        const rawResult = await Promise.race([
          this.sendRpc(
            setupProc,
            'session/prompt',
            {
              sessionId,
              prompt: [{ type: 'text', text: effectivePrompt }],
            },
            undefined,
            true,
            () => {
              turn.promptWriteCompleted = true;
            },
          ),
          forcePromptSettlePromise,
        ]);
        promptResult = asPlainObject(rawResult);
      } finally {
        clearTurnWatchdog?.();
        this.clearTurnTimers(turn);
      }

      await this.awaitProcessPostExitDrain(setupProc);
      const stopReason = promptResult.stopReason as string;
      postPromptSnap = readAgyConversationStateSnapshot(sessionId, {
        agyHomeDir: this.agyHomeDir,
      });
      this.flushMidTurnOutputNow(turn, { turnEnding: true });
      const endSyncKnownOk = this.syncSqlStepUsage(sessionId, turn, {
        deferCurrentTurnUnknownRows: true,
      });
      this.reconcileTurnEndUsage(sessionId, turn, promptResult.usage);
      const endSyncFinalOk = this.syncSqlStepUsage(sessionId, turn, {
        deferCurrentTurnUnknownRows: false,
      });
      const endSyncOk = endSyncKnownOk && endSyncFinalOk;
      await this.confirmPendingDurableEmissions(ledger);

      this.emit({
        type: 'token-count',
        engine: 'agy',
        usage: isPlainObject(promptResult.usage) ? promptResult.usage : {},
      });

      if (turn.cancelled || this.disposed || stopReason === 'cancelled') {
        throw new AgyTurnCancelledError();
      }
      if (turn.abortReason) {
        throw turn.abortReason;
      }

      this.finalizeCompletedTurnUsageOwnership(sessionId, turn, endSyncOk, promptResult.usage);

      return { ok: true, stopReason };
    } catch (error) {
      this.clearTurnTimers(turn);
      this.flushMidTurnOutputNow(turn, { turnEnding: true });
      // Never release turn ownership or classify retry safety while a retiring child OR
      // an exited child's post-exit stdout drain window is still in flight.
      await this.awaitProcessPostExitDrain(setupProc);
      await this.awaitProcessPostExitDrain(this.proc);
      await this.awaitRetirementBarrier(false);

      const sessionId = turn.sessionId ?? this.activeSessionId ?? this.getConversationId();
      if (sessionId && turn.enteredPromptPhase) {
        const errSyncOk = this.syncSqlStepUsage(sessionId, turn, {
          deferCurrentTurnUnknownRows: false,
        });
        this.finalizeFailedTurnUsageOwnership(sessionId, turn, setupProc, errSyncOk);
      }

      const retrySafety = this.classifyRetrySafety(turn, sessionId);
      const promptDispatched = retrySafety !== 'replay_original_prompt';

      if (this.unkillableHandles.size > 0) {
        return {
          ok: false,
          detail: UNSAFE_SHUTDOWN_TIMEOUT_MESSAGE,
          rawTurnError: UNSAFE_SHUTDOWN_TIMEOUT_MESSAGE,
          stderrError: null,
          exitCode: null,
          promptDispatched,
          retrySafety: 'unsafe_side_effects',
          attemptRef,
          unkillableProcess: true,
        };
      }

      if (turn.cancelled || isAgyTurnCancelledError(error)) {
        return {
          ok: false,
          cancelled: true,
          detail: 'Antigravity turn cancelled',
          rawTurnError: null,
          stderrError: null,
          exitCode: this.lastExitCode,
          promptDispatched,
          retrySafety,
          attemptRef,
        };
      }

      const fatalSpawnError = setupProc?.fatalSpawnError ?? this.proc?.fatalSpawnError ?? null;
      if (fatalSpawnError) {
        const detail =
          (fatalSpawnError as NodeJS.ErrnoException).code === 'ENOENT'
            ? `agy executable not found. Install the Antigravity CLI, or set HAPPY_AGY_PATH to its absolute path (tried 'agy' on PATH and ~/.local/bin/agy).`
            : fatalSpawnError.message;
        return {
          ok: false,
          detail,
          rawTurnError: null,
          stderrError: null,
          exitCode: null,
          promptDispatched: false,
          retrySafety: 'replay_original_prompt',
          attemptRef,
          fatalSpawnError,
        };
      }

      const startupStderr = setupProc?.startupStderrBuf ?? this.proc?.startupStderrBuf ?? '';
      const stderrError = extractAgyStderrError(this.turnStderrBuf || startupStderr);
      if (error instanceof AcpProcessClosedError) {
        const rawErr = stderrError ?? error.message;
        return {
          ok: false,
          detail: formatAgyTurnError(rawErr, GENERIC_AGY_RESULT_ERROR),
          rawTurnError: rawErr,
          stderrError,
          exitCode: error.exitCode,
          promptDispatched,
          retrySafety,
          attemptRef,
          unexpectedProcessExit: !error.intentional,
        };
      }

      const errMsg = error instanceof Error ? error.message : String(error);
      const rawTurnError = stderrError ?? errMsg;
      return {
        ok: false,
        detail: formatAgyTurnError(rawTurnError, GENERIC_AGY_RESULT_ERROR),
        rawTurnError,
        stderrError,
        exitCode: this.lastExitCode,
        promptDispatched,
        retrySafety,
        attemptRef,
        unseededBaseline: error instanceof AgyUnseededBaselineError,
      };
    } finally {
      this.clearTurnTimers(turn);
      turn.inSetupPhase = false;
      turn.inPromptPhase = false;
      if (this.activeTurn === turn) {
        this.activeTurn = null;
      }
      this.lastSettledAttemptTurn = turn;
      await this.awaitProcessPostExitDrain(setupProc);
      await this.awaitProcessPostExitDrain(this.proc);
      await this.awaitRetirementBarrier(false);
      if (!this.disposed && this.isAlive && this.activeSessionId) {
        this.armAutonomousMonitorAfterTurn(this.activeSessionId, postPromptSnap);
      }
    }
  }

  private async awaitProcessPostExitDrain(proc: AcpProcessHandle | null): Promise<void> {
    if (!proc || proc.exited || this.unkillableHandles.has(proc)) return;
    if (proc.osExited) {
      await proc.exitedPromise;
    }
  }

  private syncExitedAttemptUsageSync(turn: ActiveTurnState): void {
    const sessionId = turn.sessionId ?? this.activeSessionId ?? this.getConversationId();
    if (sessionId && turn.enteredPromptPhase && turn.attemptProc?.exited) {
      const syncOk = this.syncSqlStepUsage(sessionId, null);
      if (syncOk) {
        const ledger = this.getOrCreateLedger(sessionId);
        for (const rec of ledger.turns.values()) {
          if (rec.procGen === turn.attemptProc.gen) {
            rec.procExitedAfterScan = true;
          }
        }
      }
    }
  }

  private evaluatePriorAttemptsRetrySafetySync(
    priorAttempts: readonly AgyAcpAttemptRef[],
    baselineSafety: AgyRetrySafety,
  ): AgyRetrySafety {
    if (this.unkillableHandles.size > 0 || baselineSafety === 'unsafe_side_effects') {
      return 'unsafe_side_effects';
    }
    if (priorAttempts.length === 0) {
      return baselineSafety;
    }
    let aggregated: AgyRetrySafety = 'replay_original_prompt';
    for (const ref of priorAttempts) {
      const priorTurn = ref as unknown as ActiveTurnState;
      this.syncExitedAttemptUsageSync(priorTurn);
      const sessionId = priorTurn.sessionId ?? this.activeSessionId ?? this.getConversationId();
      aggregated = combineRetrySafety(aggregated, this.classifyRetrySafety(priorTurn, sessionId));
      if (aggregated === 'unsafe_side_effects') {
        return 'unsafe_side_effects';
      }
    }
    return aggregated;
  }

  async revalidatePriorAttemptsRetrySafety(
    priorAttempts: readonly AgyAcpAttemptRef[],
    baselineSafety: AgyRetrySafety,
  ): Promise<AgyRetrySafety> {
    for (const ref of priorAttempts) {
      const priorTurn = ref as unknown as ActiveTurnState;
      await this.awaitProcessPostExitDrain(priorTurn.attemptProc);
    }
    await this.awaitProcessPostExitDrain(this.proc);
    await this.awaitRetirementBarrier(false);
    return this.evaluatePriorAttemptsRetrySafetySync(priorAttempts, baselineSafety);
  }

  async revalidateLastTurnRetrySafety(): Promise<AgyRetrySafety | null> {
    const turn = this.lastSettledAttemptTurn;
    if (!turn) return null;
    return this.revalidatePriorAttemptsRetrySafety(
      [turn as unknown as AgyAcpAttemptRef],
      'replay_original_prompt',
    );
  }

  private classifyRetrySafety(turn: ActiveTurnState, sessionId: string | null): AgyRetrySafety {
    if (!turn.enteredPromptPhase && !turn.promptWriteCompleted && !turn.sawAnyTurnStreamEvent) {
      return 'replay_original_prompt';
    }

    const postSnap = sessionId
      ? readAgyConversationStateSnapshot(sessionId, { agyHomeDir: this.agyHomeDir })
      : { dbExists: false, readOk: true, maxStepIdx: -1, maxExecIdx: -1, maxGenIdx: -1 };
    const preSnap = turn.prePromptSnap;

    const dbExecAdvanced = Boolean(
      preSnap?.readOk &&
        postSnap.dbExists &&
        postSnap.readOk &&
        postSnap.maxExecIdx > preSnap.maxExecIdx,
    );
    const unknownDbToolState = Boolean(
      postSnap.dbExists &&
        (!preSnap?.readOk || !postSnap.readOk) &&
        turn.promptWriteCompleted,
    );
    const unverifiedStdio = Boolean(turn.undrainedStdio && turn.promptWriteCompleted);

    if (turn.sawToolActivity || unverifiedStdio || dbExecAdvanced || unknownDbToolState) {
      return 'unsafe_side_effects';
    }

    const dbPromptPersisted = Boolean(
      preSnap?.readOk &&
        postSnap.dbExists &&
        postSnap.readOk &&
        postSnap.maxStepIdx > preSnap.maxStepIdx,
    );

    const sameLiveServer = Boolean(
      turn.attemptProc &&
        this.proc === turn.attemptProc &&
        !turn.attemptProc.dead &&
        !turn.attemptProc.exited &&
        !turn.attemptProc.osExited,
    );

    if (sameLiveServer) {
      return dbPromptPersisted || turn.sawAnyTurnStreamEvent || turn.emittedStepCount > 0
        ? 'continue_persisted_turn'
        : 'replay_original_prompt';
    }

    // When `turn.attemptProc` has exited, the next attempt runs `session/resume` from SQLite.
    // Only treat the prompt as persisted if SQLite actually committed the new step (or in unit
    // tests where no `.db` exists on disk and the mock server streamed turn events).
    if (postSnap.dbExists) {
      return dbPromptPersisted ? 'continue_persisted_turn' : 'replay_original_prompt';
    }
    return turn.sawAnyTurnStreamEvent || turn.emittedStepCount > 0
      ? 'continue_persisted_turn'
      : 'replay_original_prompt';
  }

  async cancelTurn(): Promise<void> {
    const turn = this.activeTurn;
    if (!turn) {
      if (this.autonomousTurnActive) {
        this.cancelAutonomousTurn();
        return;
      }
      this.pendingTurnCancel = true;
      return;
    }

    turn.cancelled = true;
    const cancelErr = new AgyTurnCancelledError();
    if (!turn.abortReason) {
      turn.abortReason = cancelErr;
    }

    if (turn.inSetupPhase && !turn.inPromptPhase) {
      if (!this.activeSessionId) {
        await this.closeProcess({ requireExit: true }).catch(() => {});
      } else if (turn.cancelGraceTimer === null && this.cancelGraceMs > 0) {
        // An established session is mid `set_mode`/`set_model`. Allow it up to
        // `cancelGraceMs` to finish cleanly so session state stays consistent; if hung,
        // recycle the ACP server so `ensureSessionReady` unblocks deterministically.
        turn.cancelGraceTimer = setTimeout(() => {
          turn.cancelGraceTimer = null;
          if (this.activeTurn === turn && turn.inSetupPhase) {
            this.log(
              `agy ACP control setup did not settle within ${this.cancelGraceMs}ms of cancel; recycling ACP server`,
            );
            void this.closeProcess({ requireExit: true }).catch(() => {});
          }
        }, this.cancelGraceMs);
      }
      return;
    }

    if (turn.inPromptPhase) {
      this.initiatePromptSettlement(turn, cancelErr);
    }
  }

  private initiatePromptSettlement(turn: ActiveTurnState, reason: Error): void {
    if (!turn.abortReason) {
      turn.abortReason = reason;
    }
    const proc = this.proc;
    const sessionId = turn.sessionId ?? this.activeSessionId;

    if (proc && !proc.dead && !proc.exited && sessionId) {
      this.writeJsonRpc(proc, {
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId },
      });
      if (turn.cancelGraceTimer === null) {
        const graceMs = Math.max(1, this.cancelGraceMs);
        turn.cancelGraceTimer = setTimeout(() => {
          turn.cancelGraceTimer = null;
          if (this.activeTurn !== turn) return;
          this.log(
            `agy ACP did not settle within ${graceMs}ms of session/cancel; terminating hung ACP server`,
          );
          void this.closeProcess({ requireExit: true })
            .then(() => {
              turn.forceSettlePrompt?.(turn.abortReason ?? reason);
            })
            .catch((killErr) => {
              const err =
                killErr instanceof Error
                  ? killErr
                  : new Error(UNSAFE_SHUTDOWN_TIMEOUT_MESSAGE);
              turn.forceSettlePrompt?.(err);
            });
        }, graceMs);
      }
    } else {
      turn.forceSettlePrompt?.(turn.abortReason ?? reason);
    }
  }

  private async awaitRetirementBarrier(requireExit: boolean): Promise<void> {
    while (this.retiringProcesses.size > 0) {
      await Promise.all([...this.retiringProcesses]);
    }
    if (requireExit && this.unkillableHandles.size > 0) {
      throw new Error(UNSAFE_SHUTDOWN_TIMEOUT_MESSAGE);
    }
  }

  async closeProcess(opts: CloseProcessOptions = {}): Promise<void> {
    const isTerminalOwnershipRelease = Boolean(opts.dispose || opts.handoff);
    if (opts.dispose) {
      this.disposed = true;
    }
    if (isTerminalOwnershipRelease) {
      this.pendingTurnCancel = true;
      if (this.activeTurn) {
        this.activeTurn.cancelled = true;
      }
    }

    const proc = this.proc;
    const sessionId = this.activeSessionId;
    this.resetSessionState();

    if (proc) {
      this.proc = null;
      this.retireProcessHandle(proc, sessionId);
    }

    if (isTerminalOwnershipRelease && this.activeTurn?.forceSettlePrompt) {
      this.activeTurn.forceSettlePrompt(new AgyTurnCancelledError());
    }

    let barrierErr: unknown = null;
    try {
      await this.awaitRetirementBarrier(Boolean(opts.requireExit));
    } catch (err) {
      barrierErr = err;
    }

    if (isTerminalOwnershipRelease) {
      await this.turnChain.catch(() => {});
      if (!barrierErr) {
        try {
          await this.awaitRetirementBarrier(Boolean(opts.requireExit));
        } catch (err) {
          barrierErr = err;
        }
      }
    }

    let reconcileErr: unknown = null;
    if (this.activeTurn === null || isTerminalOwnershipRelease) {
      try {
        await this.reconcileOwnedLedgersOnClose(isTerminalOwnershipRelease);
      } catch (err) {
        reconcileErr = err;
      }
    }

    if (barrierErr) {
      throw barrierErr;
    }
    if (reconcileErr) {
      throw reconcileErr;
    }
  }

  private retireProcessHandle(proc: AcpProcessHandle, sessionId: string | null): Promise<boolean> {
    proc.closingIntentionally = true;
    proc.dead = true;

    if (!proc.exited && !proc.osExited && sessionId && proc.child.stdin?.writable && !proc.child.killed) {
      try {
        const closeReqId = this.nextRpcId++;
        proc.child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', id: closeReqId, method: 'session/close', params: { sessionId } }) + '\n',
        );
      } catch {}
    }

    if (proc.exited) {
      this.rejectProcPendingRpcs(proc, new AcpProcessClosedError(proc.exitCode, 'SIGTERM', null, true));
      return Promise.resolve(true);
    }

    if (proc.osExited || proc.child.exitCode !== null || proc.child.signalCode !== null) {
      proc.osExited = true;
      this.armPostExitDrainTimer(proc);
      const drainBudgetMs = Math.min(POST_EXIT_STDIO_DRAIN_MS, Math.max(10, Math.floor(this.closeSigtermMs / 2))) + 25;
      const drainRetirement = this.waitForExitOrTimeout(proc, drainBudgetMs);
      this.retiringProcesses.add(drainRetirement);
      void drainRetirement.finally(() => {
        this.retiringProcesses.delete(drainRetirement);
      });
      this.rejectProcPendingRpcs(proc, new AcpProcessClosedError(proc.exitCode, 'SIGTERM', null, true));
      return drainRetirement;
    }

    const retirement = (async (): Promise<boolean> => {
      try {
        proc.child.stdin?.end();
      } catch {}
      try {
        proc.child.kill('SIGTERM');
      } catch {}

      const exitedOnTerm = await this.waitForExitOrTimeout(proc, this.closeSigtermMs);
      if (exitedOnTerm) return true;

      this.log(`agy ACP server (gen=${proc.gen}) ignored SIGTERM for ${this.closeSigtermMs}ms; escalating to SIGKILL`);
      try {
        proc.child.kill('SIGKILL');
      } catch {}

      const exitedOnKill = await this.waitForExitOrTimeout(proc, this.closeSigkillMs);
      if (!exitedOnKill && !proc.exited) {
        this.unkillableHandles.add(proc);
      }
      return exitedOnKill;
    })();

    // Track `retirement` in `retiringProcesses` BEFORE rejecting pending RPCs so any
    // caller woken by RPC rejection immediately sees and awaits the active retirement!
    this.retiringProcesses.add(retirement);
    void retirement.finally(() => {
      this.retiringProcesses.delete(retirement);
    });
    this.rejectProcPendingRpcs(proc, new AcpProcessClosedError(proc.exitCode, 'SIGTERM', null, true));
    return retirement;
  }

  private waitForExitOrTimeout(proc: AcpProcessHandle, timeoutMs: number): Promise<boolean> {
    if (proc.exited) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(proc.exited);
      }, Math.max(1, timeoutMs));
      void proc.exitedPromise.then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private assertTurnNotCancelled(turn: ActiveTurnState): void {
    if (this.disposed || turn.cancelled) {
      throw new AgyTurnCancelledError();
    }
  }

  private resetSessionState(): void {
    const wasAutonomousActive = this.autonomousTurnActive;
    const prevAutonomousSession = this.autonomousSessionId ?? this.activeSessionId;
    this.clearAutonomousPollTimer();
    if (wasAutonomousActive && prevAutonomousSession) {
      this.readNewAutonomousTranscriptSteps(prevAutonomousSession);
      this.sealAutonomousTurnLedger(prevAutonomousSession, this.autonomousEmittedStepIdx);
    }
    this.autonomousTurnActive = false;
    this.autonomousTurnSeq = null;
    this.autonomousSessionId = null;
    this.autonomousBaselineStepIdx = -1;
    this.autonomousEmittedStepIdx = -1;
    this.autonomousTranscriptPath = null;
    this.autonomousTranscriptOffset = 0;
    this.autonomousSkipPartialFirstLine = false;
    this.autonomousPendingToolCalls = [];
    this.autonomousLastPlannerHadToolCalls = false;
    this.autonomousLastObservedMaxStepIdx = -1;
    this.autonomousLastObservedStepStatus = -1;
    this.autonomousLastStepChangeAt = 0;
    this.autonomousIdleSettlePolls = 0;
    this.needsHistorySkipBeforeNextPrompt = false;

    this.initialized = false;
    this.activeSessionId = null;
    this.availableModels = [];
    this.availableModeIds = [];
    this.initialDefaultModelId = null;
    this.appliedModelId = null;
    this.appliedModeId = null;

    if (wasAutonomousActive && this.activeTurn === null) {
      this.emit({ type: 'status', status: 'idle' });
    }
  }

  private async ensureSessionReady(
    turn: ActiveTurnState,
    permissionMode: PermissionMode,
    model?: string,
  ): Promise<AcpProcessHandle> {
    this.assertTurnNotCancelled(turn);
    let proc = this.proc;
    if (!proc || proc.dead || proc.exited) {
      await this.awaitRetirementBarrier(true);
      this.assertTurnNotCancelled(turn);
      proc = this.spawnProcess(permissionMode);
    }

    if (!this.initialized) {
      await this.sendRpc(
        proc,
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'lmc-cli', version: packageJson.version },
        },
        CONTROL_RPC_TIMEOUT_MS,
        true,
      );
      if (this.proc === proc) {
        this.initialized = true;
      }
      this.assertTurnNotCancelled(turn);
    }

    const expectedConversationId = this.getConversationId();
    if (!this.activeSessionId || (expectedConversationId && this.activeSessionId !== expectedConversationId)) {
      if (expectedConversationId) {
        this.trySeedExistingConversation(expectedConversationId);
        const resumed = asPlainObject(
          await this.sendRpc(
            proc,
            'session/resume',
            {
              sessionId: expectedConversationId,
              cwd: this.cwd,
              mcpServers: [],
            },
            CONTROL_RPC_TIMEOUT_MS,
            true,
          ),
        );
        const returnedId =
          typeof resumed.sessionId === 'string' && resumed.sessionId
            ? resumed.sessionId
            : expectedConversationId;
        if (!VALID_CONVERSATION_ID.test(returnedId)) {
          throw new Error('Antigravity returned an invalid conversation ID');
        }
        if (returnedId !== expectedConversationId) {
          throw new Error('Antigravity returned a different conversation; refusing to mix sessions');
        }
        if (this.proc === proc) {
          this.activeSessionId = returnedId;
          this.captureSessionCatalog(resumed);
        }
        this.assertTurnNotCancelled(turn);
      } else {
        const created = asPlainObject(
          await this.sendRpc(
            proc,
            'session/new',
            {
              cwd: this.cwd,
              mcpServers: [],
            },
            CONTROL_RPC_TIMEOUT_MS,
            true,
          ),
        );
        const sessionId = created.sessionId;
        if (typeof sessionId !== 'string' || !VALID_CONVERSATION_ID.test(sessionId)) {
          throw new Error('Antigravity returned an invalid conversation ID');
        }
        if (this.proc === proc) {
          this.activeSessionId = sessionId;
          this.ensureNewConversationLedger(sessionId);
          this.setConversationId(sessionId);
          this.captureSessionCatalog(created);
        }
        this.assertTurnNotCancelled(turn);
      }
    } else if (this.needsHistorySkipBeforeNextPrompt && this.activeSessionId) {
      // Advance native `ACPServer`'s `SkipHistory` cursor past steps already streamed by
      // our autonomous reactive-wakeup monitor so the next `session/prompt` never replays them.
      const skipSessionId = this.activeSessionId;
      this.readNewAutonomousTranscriptSteps(skipSessionId);
      this.syncSqlStepUsage(skipSessionId, null, { deferCurrentTurnUnknownRows: false });
      const snap = readAgyConversationStateSnapshot(skipSessionId, {
        agyHomeDir: this.agyHomeDir,
      });
      this.sealAutonomousTurnLedger(
        skipSessionId,
        snap.readOk ? Math.max(this.autonomousEmittedStepIdx, snap.maxStepIdx) : this.autonomousEmittedStepIdx,
      );
      const resumed = asPlainObject(
        await this.sendRpc(
          proc,
          'session/resume',
          {
            sessionId: skipSessionId,
            cwd: this.cwd,
            mcpServers: [],
          },
          CONTROL_RPC_TIMEOUT_MS,
          true,
        ),
      );
      const returnedId =
        typeof resumed.sessionId === 'string' && resumed.sessionId
          ? resumed.sessionId
          : skipSessionId;
      if (returnedId !== skipSessionId) {
        throw new Error('Antigravity returned a different conversation; refusing to mix sessions');
      }
      if (this.proc === proc) {
        this.needsHistorySkipBeforeNextPrompt = false;
        this.captureSessionCatalog(resumed);
      }
      this.assertTurnNotCancelled(turn);
    }

    const sessionId = this.activeSessionId!;
    const targetModeId = mapPermissionModeToAgyAcpMode(permissionMode, this.availableModeIds);
    if (this.appliedModeId !== targetModeId) {
      await this.sendRpc(
        proc,
        'session/set_mode',
        { sessionId, modeId: targetModeId },
        CONTROL_RPC_TIMEOUT_MS,
        true,
      );
      if (this.proc === proc) {
        this.appliedModeId = targetModeId;
      }
      this.assertTurnNotCancelled(turn);
    }

    const targetModelId = this.resolveTargetModelId(model);
    if (targetModelId && this.appliedModelId !== targetModelId) {
      await this.sendRpc(
        proc,
        'session/set_model',
        { sessionId, modelId: targetModelId },
        CONTROL_RPC_TIMEOUT_MS,
        true,
      );
      if (this.proc === proc) {
        this.appliedModelId = targetModelId;
      }
      this.assertTurnNotCancelled(turn);
    }

    return proc;
  }

  private captureSessionCatalog(sessionResp: Record<string, any>): void {
    const modelsObj = asPlainObject(sessionResp.models);
    if (Array.isArray(modelsObj.availableModels)) {
      this.availableModels = modelsObj.availableModels
        .filter((m): m is Record<string, any> => isPlainObject(m))
        .map((m) => ({
          modelId: typeof m.modelId === 'string' ? m.modelId : undefined,
          name: typeof m.name === 'string' ? m.name : undefined,
        }));
    }
    if (typeof modelsObj.currentModelId === 'string' && modelsObj.currentModelId) {
      if (!this.initialDefaultModelId) {
        this.initialDefaultModelId = modelsObj.currentModelId;
      }
      this.appliedModelId = modelsObj.currentModelId;
    }

    const modesObj = asPlainObject(sessionResp.modes);
    if (Array.isArray(modesObj.availableModes)) {
      this.availableModeIds = modesObj.availableModes
        .map((m) => (isPlainObject(m) && typeof m.id === 'string' ? m.id : ''))
        .filter(Boolean);
    }
    if (typeof modesObj.currentModeId === 'string' && modesObj.currentModeId) {
      this.appliedModeId = modesObj.currentModeId;
    }
  }

  private resolveTargetModelId(requested?: string): string | null {
    if (!requested || requested === 'default') {
      return this.initialDefaultModelId && this.appliedModelId !== this.initialDefaultModelId
        ? this.initialDefaultModelId
        : null;
    }
    const lower = requested.trim().toLowerCase();
    const matched = this.availableModels.find(
      (m) =>
        m.modelId === requested ||
        (typeof m.modelId === 'string' && m.modelId.toLowerCase() === lower) ||
        (typeof m.name === 'string' && m.name.toLowerCase() === lower),
    );
    return matched?.modelId ?? requested;
  }

  private spawnProcess(permissionMode: PermissionMode): AcpProcessHandle {
    const preSpawnConvId = this.activeSessionId ?? this.getConversationId();
    if (preSpawnConvId) {
      this.getOrCreateLedger(preSpawnConvId);
    }
    this.resetSessionState();
    this.lastExitCode = null;

    const args = buildAgyAcpArgs({
      permissionMode,
      addDirs: [this.cwd],
    });
    const wantBypass = isSkipPermissionsMode(permissionMode);
    const child = this.spawnFn(resolveAgyBin(), args, {
      cwd: this.cwd,
      env: sanitizeSessionEnvironment({ ...process.env, ...this.env }),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let resolveExited!: () => void;
    const exitedPromise = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });

    const proc: AcpProcessHandle = {
      gen: ++this.nextProcessGen,
      child,
      bypassPermissions: wantBypass,
      pendingRpcs: new Map<number, PendingRpc>(),
      exitedPromise,
      markExited: () => {
        if (proc.postExitDrainTimer !== null) {
          clearTimeout(proc.postExitDrainTimer);
          proc.postExitDrainTimer = null;
        }
        if (!proc.exited) {
          proc.exited = true;
          proc.dead = true;
          this.unkillableHandles.delete(proc);
          resolveExited();
        }
      },
      exited: false,
      osExited: false,
      stdioClosed: false,
      dead: false,
      hasSpawnedEvent: typeof child.pid === 'number' && child.pid > 0,
      hasCommunicated: false,
      closingIntentionally: false,
      exitCode: null,
      exitSignal: null,
      fatalSpawnError: null,
      postExitDrainTimer: null,
      lastPromptTurn: null,
      stdoutBuf: '',
      startupStderrBuf: '',
      loggedStderrDiagnostic: false,
    };

    this.proc = proc;

    child.on('spawn', () => {
      proc.hasSpawnedEvent = true;
    });

    // Install stdio error handlers before any writes so asynchronous EPIPE/EOF
    // stream errors settle only this generation's RPCs and never crash Node.
    child.stdin?.on('error', (err: Error) => {
      this.handleBrokenStdin(proc, err);
    });

    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (!chunk || proc.stdioClosed) return;
      proc.hasCommunicated = true;
      if (this.proc === proc && !proc.dead) {
        this.handleStdoutChunk(proc, chunk);
      } else {
        this.inspectRetiringStdoutChunk(proc, chunk);
      }
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (!chunk || proc.stdioClosed) return;
      proc.hasCommunicated = true;
      if (chunk.trim() && !proc.loggedStderrDiagnostic) {
        proc.loggedStderrDiagnostic = true;
        this.log('Antigravity ACP server wrote diagnostic output; inspect locally if a turn fails');
      }
      proc.startupStderrBuf = appendBoundedStderr(proc.startupStderrBuf, chunk);
      if ((this.proc === proc || proc.lastPromptTurn === this.activeTurn) && this.activeTurn) {
        this.turnStderrBuf = appendBoundedStderr(this.turnStderrBuf, chunk);
      }
    });

    child.on('error', (err: Error) => {
      const errno = err as NodeJS.ErrnoException;
      const isSpawnFailure =
        !proc.closingIntentionally &&
        !proc.hasSpawnedEvent &&
        !proc.hasCommunicated &&
        errno.syscall !== 'kill' &&
        typeof child.pid !== 'number';
      if (isSpawnFailure) {
        proc.fatalSpawnError = err;
        proc.stdioClosed = true;
        proc.osExited = true;
        proc.markExited();
        if (this.proc === proc) {
          this.proc = null;
          this.resetSessionState();
        }
        this.rejectProcPendingRpcs(proc, err);
        return;
      }
      // Post-spawn runtime/signal errors (e.g. kill EPERM) do NOT prove termination;
      // only OS 'exit'/'close' confirms that the child process has exited.
      this.log(`agy ACP child error (gen=${proc.gen}, code=${errno.code ?? 'unknown'}): ${err.message}`);
    });

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      proc.osExited = true;
      proc.exitCode = code;
      proc.exitSignal = signal;
      if (proc.stdioClosed) {
        this.finalizeChildTermination(proc, code, signal);
        return;
      }
      // Wait for `'close'` so buffered stdout/stderr frames (especially `tool_call`
      // notifications emitted right before non-zero exit) drain in order before we
      // classify retry safety, while bounding leaked grandchild pipe FDs via timer.
      this.armPostExitDrainTimer(proc);
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      proc.osExited = true;
      proc.stdioClosed = true;
      const resolvedCode = code ?? proc.exitCode;
      const resolvedSignal = signal ?? proc.exitSignal;
      proc.exitCode = resolvedCode;
      proc.exitSignal = resolvedSignal;
      this.flushTrailingStdoutOnClose(proc);
      this.finalizeChildTermination(proc, resolvedCode, resolvedSignal);
    });

    return proc;
  }

  private armPostExitDrainTimer(proc: AcpProcessHandle): void {
    if (proc.exited || proc.stdioClosed || proc.postExitDrainTimer !== null) return;
    const drainMs = Math.min(POST_EXIT_STDIO_DRAIN_MS, Math.max(10, Math.floor(this.closeSigtermMs / 2)));
    proc.postExitDrainTimer = setTimeout(() => {
      proc.postExitDrainTimer = null;
      if (proc.exited || proc.stdioClosed) return;
      // Stdio pipes remained open after OS process exit (e.g. inherited FD in grandchild).
      // Drain any complete buffered lines, mark turn stdio unverified if prompt was written,
      // detach pipe listeners, and finalize process exit.
      proc.stdioClosed = true;
      this.flushTrailingStdoutOnClose(proc);
      if (proc.lastPromptTurn?.promptWriteCompleted) {
        proc.lastPromptTurn.undrainedStdio = true;
      }
      proc.child.stdout?.removeAllListeners('data');
      proc.child.stderr?.removeAllListeners('data');
      this.finalizeChildTermination(proc, proc.exitCode, proc.exitSignal);
    }, drainMs);
  }

  private flushTrailingStdoutOnClose(proc: AcpProcessHandle): void {
    const trailing = proc.stdoutBuf.trim();
    proc.stdoutBuf = '';
    if (!trailing) return;
    if (trailing.length > MAX_ACP_LINE_BYTES) {
      if (proc.lastPromptTurn?.promptWriteCompleted) {
        proc.lastPromptTurn.undrainedStdio = true;
      }
      return;
    }
    if (this.proc === proc && !proc.dead) {
      this.handleJsonRpcLine(proc, trailing);
    } else {
      this.inspectRetiringStdoutLine(proc, trailing);
    }
  }

  private inspectRetiringStdoutChunk(proc: AcpProcessHandle, chunk: string): void {
    proc.stdoutBuf += chunk;
    let nl: number;
    while ((nl = proc.stdoutBuf.indexOf('\n')) >= 0) {
      const rawLine = proc.stdoutBuf.slice(0, nl);
      proc.stdoutBuf = proc.stdoutBuf.slice(nl + 1);
      if (rawLine.length > MAX_ACP_LINE_BYTES) {
        proc.stdoutBuf = '';
        if (proc.lastPromptTurn?.promptWriteCompleted) {
          proc.lastPromptTurn.undrainedStdio = true;
        }
        return;
      }
      const line = rawLine.trim();
      if (!line) continue;
      this.inspectRetiringStdoutLine(proc, line);
    }
    if (proc.stdoutBuf.length > MAX_ACP_LINE_BYTES) {
      proc.stdoutBuf = '';
      if (proc.lastPromptTurn?.promptWriteCompleted) {
        proc.lastPromptTurn.undrainedStdio = true;
      }
    }
  }

  private inspectRetiringStdoutLine(proc: AcpProcessHandle, line: string): void {
    const turn = proc.lastPromptTurn;
    if (!turn || !line.startsWith('{')) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (turn.promptWriteCompleted) {
        turn.undrainedStdio = true;
      }
      return;
    }
    if (!isPlainObject(parsed) || parsed.jsonrpc !== '2.0') {
      if (turn.promptWriteCompleted) {
        turn.undrainedStdio = true;
      }
      return;
    }
    const method = typeof parsed.method === 'string' ? parsed.method : '';
    const params = asPlainObject(parsed.params);
    if (!turn.sessionId || params.sessionId !== turn.sessionId) return;
    if (method === 'session/request_permission') {
      turn.sawAnyTurnStreamEvent = true;
      turn.sawToolActivity = true;
      return;
    }
    if (method === 'session/update') {
      const update = asPlainObject(params.update);
      const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';
      if (kind === 'current_mode_update') return;
      turn.sawAnyTurnStreamEvent = true;
      if (kind === 'tool_call' || kind === 'tool_call_update') {
        turn.sawToolActivity = true;
      }
    }
  }

  private finalizeChildTermination(
    proc: AcpProcessHandle,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    proc.exitCode = code;
    proc.exitSignal = signal;
    const wasCurrentProc = this.proc === proc;
    proc.markExited();
    if (wasCurrentProc) {
      this.lastExitCode = code;
      this.proc = null;
      this.resetSessionState();
    }
    if (proc.pendingRpcs.size > 0) {
      const stderrError = extractAgyStderrError(
        (wasCurrentProc ? this.turnStderrBuf : '') || proc.startupStderrBuf,
      );
      this.rejectProcPendingRpcs(
        proc,
        new AcpProcessClosedError(code, signal, stderrError, proc.closingIntentionally),
      );
    }
  }

  private handleStdoutChunk(proc: AcpProcessHandle, chunk: string): void {
    proc.stdoutBuf += chunk;
    let nl: number;
    while ((nl = proc.stdoutBuf.indexOf('\n')) >= 0) {
      const rawLine = proc.stdoutBuf.slice(0, nl);
      proc.stdoutBuf = proc.stdoutBuf.slice(nl + 1);
      if (rawLine.length > MAX_ACP_LINE_BYTES) {
        this.abortProtocolOnProcess(
          proc,
          new Error('Antigravity ACP stream record exceeds the supported limit'),
        );
        return;
      }
      const line = rawLine.trim();
      if (!line) continue;
      this.handleJsonRpcLine(proc, line);
      if (proc.dead) return;
    }
    if (proc.stdoutBuf.length > MAX_ACP_LINE_BYTES) {
      this.abortProtocolOnProcess(
        proc,
        new Error('Antigravity ACP stream record exceeds the supported limit'),
      );
    }
  }

  private abortProtocolOnProcess(proc: AcpProcessHandle, err: Error): void {
    if (proc.lastPromptTurn?.promptWriteCompleted) {
      proc.lastPromptTurn.undrainedStdio = true;
    }
    const sessionId = this.proc === proc ? this.activeSessionId : null;
    if (this.proc === proc) {
      this.proc = null;
      this.resetSessionState();
    }
    this.rejectProcPendingRpcs(proc, err);
    void this.retireProcessHandle(proc, sessionId);
  }

  private handleJsonRpcLine(proc: AcpProcessHandle, line: string): void {
    if (!line.startsWith('{')) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.abortProtocolOnProcess(
        proc,
        new Error('Invalid Antigravity structured output; upgrade the CLI and retry'),
      );
      return;
    }

    if (!isPlainObject(parsed) || parsed.jsonrpc !== '2.0') {
      this.abortProtocolOnProcess(
        proc,
        new Error('Invalid Antigravity JSON-RPC envelope; upgrade the CLI and retry'),
      );
      return;
    }

    const msg = parsed;
    const hasMethod = typeof msg.method === 'string' && msg.method.length > 0;
    const hasIdProp = hasOwn(msg, 'id');

    if (hasMethod && hasIdProp) {
      const validServerReqId =
        (typeof msg.id === 'number' && Number.isSafeInteger(msg.id)) ||
        (typeof msg.id === 'string' && msg.id.length > 0);
      if (!validServerReqId) {
        this.abortProtocolOnProcess(
          proc,
          new Error('Invalid Antigravity JSON-RPC server request ID'),
        );
        return;
      }
      this.handleServerRequest(
        proc,
        msg.id as string | number,
        msg.method as string,
        asPlainObject(msg.params),
      );
      return;
    }

    if (hasMethod) {
      if (msg.method === 'session/update') {
        const updateParams = asPlainObject(msg.params);
        if (this.proc === proc) {
          this.handleSessionUpdate(proc, updateParams);
        } else {
          this.recordTurnSafetyFromUpdate(proc, updateParams);
        }
      }
      return;
    }

    // Response frame: must carry an exact safe-integer ID (never coerce strings)
    // and exclusively `result` XOR a structured `error` object.
    if (!hasIdProp || typeof msg.id !== 'number' || !Number.isSafeInteger(msg.id)) {
      this.abortProtocolOnProcess(
        proc,
        new Error('Invalid Antigravity JSON-RPC response ID'),
      );
      return;
    }

    const hasResult = hasOwn(msg, 'result');
    const hasError = hasOwn(msg, 'error');
    if (hasResult === hasError || (hasError && !isPlainObject(msg.error))) {
      this.abortProtocolOnProcess(
        proc,
        new Error('Invalid Antigravity JSON-RPC response payload'),
      );
      return;
    }

    const pending = proc.pendingRpcs.get(msg.id);
    if (!pending) return;
    proc.pendingRpcs.delete(msg.id);
    if (pending.timer !== null) clearTimeout(pending.timer);

    if (hasError) {
      pending.reject(new AcpRpcError(pending.method, msg.error as AcpJsonRpcErrorPayload));
      return;
    }

    const schemaErr = pending.expectObjectResult
      ? validateAcpMethodResult(pending.method, msg.result)
      : null;
    if (schemaErr !== null) {
      const protocolErr = new Error(schemaErr);
      pending.reject(protocolErr);
      this.abortProtocolOnProcess(proc, protocolErr);
      return;
    }

    pending.resolve(msg.result);
  }

  private handleServerRequest(
    proc: AcpProcessHandle,
    requestId: string | number,
    method: string,
    params: Record<string, any>,
  ): void {
    if (method === 'session/request_permission') {
      if (
        proc.lastPromptTurn &&
        typeof params.sessionId === 'string' &&
        proc.lastPromptTurn.sessionId === params.sessionId
      ) {
        proc.lastPromptTurn.sawAnyTurnStreamEvent = true;
        proc.lastPromptTurn.sawToolActivity = true;
      }

      const turn = this.activeTurn;
      const validContext =
        this.proc === proc &&
        !this.disposed &&
        Boolean(turn && !turn.cancelled && !turn.abortReason && turn.inPromptPhase) &&
        Boolean(this.activeSessionId) &&
        typeof params.sessionId === 'string' &&
        params.sessionId === this.activeSessionId;

      if (!validContext || !turn) {
        this.writeJsonRpc(proc, {
          jsonrpc: '2.0',
          id: requestId,
          result: { outcome: { outcome: 'cancelled' } },
        });
        return;
      }

      turn.sawAnyTurnStreamEvent = true;
      turn.sawToolActivity = true;

      const allow =
        isSkipPermissionsMode(this.currentPermissionMode) ||
        this.currentPermissionMode === 'safe-yolo';
      const outcome = selectAuthorizedPermissionOption(params.options, allow);

      this.writeJsonRpc(proc, {
        jsonrpc: '2.0',
        id: requestId,
        result: { outcome },
      });
      return;
    }

    this.writeJsonRpc(proc, {
      jsonrpc: '2.0',
      id: requestId,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }

  private recordTurnSafetyFromUpdate(proc: AcpProcessHandle, params: Record<string, any>): void {
    const ownerTurn = proc.lastPromptTurn;
    if (
      !ownerTurn ||
      typeof params.sessionId !== 'string' ||
      ownerTurn.sessionId !== params.sessionId
    ) {
      return;
    }
    const update = asPlainObject(params.update);
    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';
    if (kind === 'current_mode_update') return;
    ownerTurn.sawAnyTurnStreamEvent = true;
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      ownerTurn.sawToolActivity = true;
    }
  }

  private handleSessionUpdate(proc: AcpProcessHandle, params: Record<string, any>): void {
    this.recordTurnSafetyFromUpdate(proc, params);

    if (
      typeof params.sessionId !== 'string' ||
      !this.activeSessionId ||
      params.sessionId !== this.activeSessionId
    ) {
      return;
    }

    const update = asPlainObject(params.update);
    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';

    if (kind === 'current_mode_update') {
      if (typeof update.currentModeId === 'string' && update.currentModeId) {
        this.appliedModeId = update.currentModeId;
      }
      return;
    }

    const turn = this.activeTurn;
    if (!turn || !turn.inPromptPhase || turn.sessionId !== params.sessionId) return;

    turn.sawAnyTurnStreamEvent = true;

    if (kind === 'agent_thought_chunk') {
      const text = extractTextFromContent(update.content);
      if (typeof text === 'string' && text.length > 0) {
        this.flushMidTurnOutputNow(turn);
        this.emit({
          type: 'event',
          name: 'thinking',
          payload: { text, streaming: true },
        });
      }
      return;
    }

    if (kind === 'agent_message_chunk') {
      const text = extractTextFromContent(update.content);
      if (typeof text === 'string' && text.length > 0) {
        turn.sawOutput = true;
        turn.pendingUnflushedOutput = true;
        turn.midTurnFlushPolls = 0;
        this.emit({
          type: 'model-output',
          textDelta: text,
        });
        this.scheduleMidTurnOutputFlush(turn);
      }
      return;
    }

    if (kind === 'tool_call') {
      turn.sawToolActivity = true;
      this.flushMidTurnOutputNow(turn);
      this.syncSqlStepUsage(params.sessionId, turn, { deferCurrentTurnUnknownRows: true });
      const callId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
      if (!callId) return;
      const toolName = extractToolName(update, turn.toolNames.get(callId));
      turn.toolNames.set(callId, toolName);
      if (!turn.emittedToolCalls.has(callId)) {
        turn.emittedToolCalls.add(callId);
        this.emit({
          type: 'tool-call',
          toolName,
          callId,
          args: extractToolArgs(update),
        });
      }
      const status = typeof update.status === 'string' ? update.status : '';
      if (
        (status === 'completed' || status === 'failed' || status === 'cancelled') &&
        !turn.completedToolCalls.has(callId)
      ) {
        turn.completedToolCalls.add(callId);
        this.emit({
          type: 'tool-result',
          toolName,
          callId,
          result:
            status === 'completed'
              ? extractToolResultValue(update)
              : { error: extractToolErrorMessage(update, status), status },
        });
      }
      return;
    }

    if (kind === 'tool_call_update') {
      turn.sawToolActivity = true;
      const callId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
      if (!callId) return;
      const toolName = extractToolName(update, turn.toolNames.get(callId));
      turn.toolNames.set(callId, toolName);
      if (!turn.emittedToolCalls.has(callId)) {
        this.flushMidTurnOutputNow(turn);
        this.syncSqlStepUsage(params.sessionId, turn, { deferCurrentTurnUnknownRows: true });
        turn.emittedToolCalls.add(callId);
        this.emit({
          type: 'tool-call',
          toolName,
          callId,
          args: extractToolArgs(update),
        });
      }
      const status = typeof update.status === 'string' ? update.status : '';
      if (
        (status === 'completed' || status === 'failed' || status === 'cancelled') &&
        !turn.completedToolCalls.has(callId)
      ) {
        turn.completedToolCalls.add(callId);
        this.emit({
          type: 'tool-result',
          toolName,
          callId,
          result:
            status === 'completed'
              ? extractToolResultValue(update)
              : { error: extractToolErrorMessage(update, status), status },
        });
      }
    }
  }

  private scheduleMidTurnOutputFlush(turn: ActiveTurnState): void {
    if (turn.midTurnFlushTimer !== null) {
      clearTimeout(turn.midTurnFlushTimer);
      turn.midTurnFlushTimer = null;
    }
    if (!turn.pendingUnflushedOutput || !turn.inPromptPhase) {
      return;
    }
    const delayMs =
      turn.midTurnFlushPolls < MAX_FAST_MID_TURN_FLUSH_POLLS
        ? Math.max(1, this.midTurnFlushMs)
        : Math.max(SLOW_MID_TURN_FLUSH_MS, this.midTurnFlushMs);
    turn.midTurnFlushTimer = setTimeout(() => {
      turn.midTurnFlushTimer = null;
      if (this.activeTurn !== turn || !turn.inPromptPhase || !turn.pendingUnflushedOutput) {
        return;
      }
      const sessionId = turn.sessionId ?? this.activeSessionId;
      const completion = checkAgyIdlePlannerStepFinalized(
        sessionId,
        turn.outputStepBaselineIdx,
        turn.outputGenBaselineIdx,
        { agyHomeDir: this.agyHomeDir },
      );
      if (completion.finalized) {
        this.flushMidTurnOutputNow(turn, {
          completedBaseline: {
            stepIdx: completion.stepIdx,
            genIdx: completion.genIdx,
          },
        });
        if (sessionId) {
          this.syncSqlStepUsage(sessionId, turn, { deferCurrentTurnUnknownRows: true });
        }
        return;
      }
      turn.midTurnFlushPolls += 1;
      this.scheduleMidTurnOutputFlush(turn);
    }, delayMs);
  }

  private clearAutonomousPollTimer(): void {
    if (this.autonomousPollTimer !== null) {
      clearTimeout(this.autonomousPollTimer);
      this.autonomousPollTimer = null;
    }
  }

  private suspendAutonomousMonitorForPrompt(): void {
    this.clearAutonomousPollTimer();
    const sessionId = this.autonomousSessionId ?? this.activeSessionId;
    if (this.autonomousTurnActive && sessionId) {
      this.readNewAutonomousTranscriptSteps(sessionId);
      this.syncSqlStepUsage(sessionId, null, { deferCurrentTurnUnknownRows: false });
      const snap = readAgyConversationStateSnapshot(sessionId, {
        agyHomeDir: this.agyHomeDir,
      });
      this.sealAutonomousTurnLedger(
        sessionId,
        snap.readOk ? Math.max(this.autonomousEmittedStepIdx, snap.maxStepIdx) : this.autonomousEmittedStepIdx,
      );
    }
    this.autonomousTurnActive = false;
    this.autonomousPendingToolCalls = [];
    this.autonomousLastPlannerHadToolCalls = false;
    this.autonomousIdleSettlePolls = 0;
  }

  private cancelAutonomousTurn(): void {
    this.clearAutonomousPollTimer();
    const proc = this.proc;
    const sessionId = this.autonomousSessionId ?? this.activeSessionId;
    if (proc && !proc.dead && !proc.exited && sessionId) {
      this.writeJsonRpc(proc, {
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId },
      });
    }
    if (sessionId) {
      this.readNewAutonomousTranscriptSteps(sessionId);
      this.syncSqlStepUsage(sessionId, null, { deferCurrentTurnUnknownRows: false });
      const snap = readAgyConversationStateSnapshot(sessionId, {
        agyHomeDir: this.agyHomeDir,
      });
      const finalStepIdx = snap.readOk
        ? Math.max(this.autonomousBaselineStepIdx, this.autonomousEmittedStepIdx, snap.maxStepIdx)
        : Math.max(this.autonomousBaselineStepIdx, this.autonomousEmittedStepIdx);
      this.sealAutonomousTurnLedger(sessionId, finalStepIdx);
      this.autonomousBaselineStepIdx = finalStepIdx;
      this.autonomousEmittedStepIdx = Math.max(this.autonomousEmittedStepIdx, finalStepIdx);
      this.needsHistorySkipBeforeNextPrompt = true;
    }
    this.autonomousTurnActive = false;
    this.autonomousPendingToolCalls = [];
    this.autonomousLastPlannerHadToolCalls = false;
    this.autonomousIdleSettlePolls = 0;
    this.emit({ type: 'status', status: 'idle' });
    if (!this.disposed && this.isAlive && sessionId && this.autonomousBaselineStepIdx >= 0) {
      this.scheduleNextAutonomousPoll();
    }
  }

  private resolveAutonomousTranscriptCandidate(
    sessionId: string,
  ): { path: string; size: number; isFull: boolean } | null {
    if (!VALID_CONVERSATION_ID.test(sessionId)) return null;
    const homeDir = this.agyHomeDir ?? resolveDefaultAgyHomeDir();
    const logsDir = join(homeDir, 'brain', sessionId, '.system_generated', 'logs');
    const fullPath = join(logsDir, 'transcript_full.jsonl');
    try {
      const st = statSync(fullPath);
      if (st.isFile()) {
        return { path: fullPath, size: st.size, isFull: true };
      }
    } catch {}
    const compactPath = join(logsDir, 'transcript.jsonl');
    try {
      const st = statSync(compactPath);
      if (st.isFile()) {
        return { path: compactPath, size: st.size, isFull: false };
      }
    } catch {}
    return null;
  }

  private armAutonomousMonitorAfterTurn(
    sessionId: string,
    turnEndSnap: AgyConversationStateSnapshot | null,
  ): void {
    this.clearAutonomousPollTimer();
    if (this.autonomousPollMs <= 0 || this.disposed || !this.isAlive) {
      return;
    }
    const snap =
      turnEndSnap && turnEndSnap.dbExists && turnEndSnap.readOk
        ? turnEndSnap
        : readAgyConversationStateSnapshot(sessionId, { agyHomeDir: this.agyHomeDir });
    if (!snap.dbExists || !snap.readOk || snap.maxStepIdx < 0) {
      return;
    }

    this.autonomousSessionId = sessionId;
    this.autonomousBaselineStepIdx = snap.maxStepIdx;
    this.autonomousEmittedStepIdx = snap.maxStepIdx;
    this.autonomousTurnActive = false;
    this.autonomousTurnSeq = null;
    this.autonomousPendingToolCalls = [];
    this.autonomousLastPlannerHadToolCalls = false;
    this.autonomousLastObservedMaxStepIdx = snap.maxStepIdx;
    this.autonomousLastObservedStepStatus = -1;
    this.autonomousLastStepChangeAt = Date.now();
    this.autonomousIdleSettlePolls = 0;

    const candidate = this.resolveAutonomousTranscriptCandidate(sessionId);
    if (candidate) {
      this.autonomousTranscriptPath = candidate.path;
      if (candidate.size > AUTONOMOUS_TRANSCRIPT_TAIL_WINDOW_BYTES) {
        this.autonomousTranscriptOffset = candidate.size - AUTONOMOUS_TRANSCRIPT_TAIL_WINDOW_BYTES;
        this.autonomousSkipPartialFirstLine = true;
      } else {
        this.autonomousTranscriptOffset = 0;
        this.autonomousSkipPartialFirstLine = false;
      }
    } else {
      this.autonomousTranscriptPath = null;
      this.autonomousTranscriptOffset = 0;
      this.autonomousSkipPartialFirstLine = false;
    }

    this.scheduleNextAutonomousPoll();
  }

  private scheduleNextAutonomousPoll(): void {
    this.clearAutonomousPollTimer();
    if (
      this.autonomousPollMs <= 0 ||
      this.disposed ||
      this.activeTurn !== null ||
      !this.isAlive ||
      !this.autonomousSessionId
    ) {
      return;
    }
    const timer = setTimeout(() => {
      this.autonomousPollTimer = null;
      this.pollAutonomousWakeupOnce();
    }, Math.max(20, this.autonomousPollMs));
    timer.unref?.();
    this.autonomousPollTimer = timer;
  }

  private registerAutonomousTurnLedger(sessionId: string): void {
    const ledger = this.getOrCreateLedger(sessionId);
    if (!ledger.seeded) {
      this.trySeedExistingConversation(sessionId);
    }
    let turnSeq = ++this.nextTurnSeq;
    while (ledger.turns.has(turnSeq)) {
      turnSeq = ++this.nextTurnSeq;
    }
    this.autonomousTurnSeq = turnSeq;
    ledger.turns.set(turnSeq, {
      turnSeq,
      procGen: this.proc?.gen ?? 0,
      turnInstanceId: this.sessionInstanceId,
      model: this.appliedModelId ?? this.initialDefaultModelId ?? null,
      startedAt: Date.now(),
      preMaxStepIdx: this.autonomousBaselineStepIdx >= 0 ? this.autonomousBaselineStepIdx : null,
      closedMaxStepIdx: null,
      expectedPromptUsage: null,
      reconciledKnownSqlTokens: { input: 0, output: 0, cacheRead: 0 },
      fallbackCredit: { input: 0, output: 0, cacheRead: 0 },
      unfinishedKnownRows: new Set<number>(),
      procExitedAfterScan: false,
      hadGenerationOpportunity: true,
    });
  }

  private sealAutonomousTurnLedger(sessionId: string, maxStepIdx: number): void {
    if (this.autonomousTurnSeq === null) return;
    const ledger = this.usageLedgers.get(sessionId);
    const rec = ledger?.turns.get(this.autonomousTurnSeq);
    if (rec && rec.preMaxStepIdx !== null && maxStepIdx >= rec.preMaxStepIdx) {
      rec.closedMaxStepIdx = maxStepIdx;
    }
    this.autonomousTurnSeq = null;
  }

  private pollAutonomousWakeupOnce(): void {
    if (
      this.disposed ||
      this.activeTurn !== null ||
      !this.isAlive ||
      !this.autonomousSessionId ||
      this.activeSessionId !== this.autonomousSessionId
    ) {
      return;
    }

    const sessionId = this.autonomousSessionId;
    const probe = probeAgyAutonomousWakeupState(sessionId, this.autonomousBaselineStepIdx, {
      agyHomeDir: this.agyHomeDir,
    });
    if (!probe.dbExists || !probe.readOk) {
      this.scheduleNextAutonomousPoll();
      return;
    }

    if (!this.autonomousTurnActive) {
      if (!probe.hasSystemWakeup) {
        this.scheduleNextAutonomousPoll();
        return;
      }
      this.autonomousTurnActive = true;
      this.needsHistorySkipBeforeNextPrompt = true;
      this.autonomousPendingToolCalls = [];
      this.autonomousLastPlannerHadToolCalls = false;
      this.autonomousLastObservedMaxStepIdx = probe.maxStepIdx;
      this.autonomousLastObservedStepStatus = probe.latestStep?.status ?? -1;
      this.autonomousLastStepChangeAt = Date.now();
      this.autonomousIdleSettlePolls = 0;
      this.registerAutonomousTurnLedger(sessionId);
      this.log(
        `agy autonomous reactive wakeup detected on conversation ${sessionId} (afterStep=${this.autonomousBaselineStepIdx}, maxStep=${probe.maxStepIdx})`,
      );
      this.emit({ type: 'status', status: 'running' });
    }

    this.readNewAutonomousTranscriptSteps(sessionId);
    this.syncSqlStepUsage(sessionId, null, { deferCurrentTurnUnknownRows: false });

    const curStatus = probe.latestStep?.status ?? -1;
    if (
      probe.maxStepIdx !== this.autonomousLastObservedMaxStepIdx ||
      curStatus !== this.autonomousLastObservedStepStatus
    ) {
      this.autonomousLastObservedMaxStepIdx = probe.maxStepIdx;
      this.autonomousLastObservedStepStatus = curStatus;
      this.autonomousLastStepChangeAt = Date.now();
      this.autonomousIdleSettlePolls = 0;
    } else {
      this.autonomousIdleSettlePolls += 1;
    }

    if (this.isAutonomousTurnComplete(sessionId, probe.latestStep)) {
      this.readNewAutonomousTranscriptSteps(sessionId);
      this.syncSqlStepUsage(sessionId, null, { deferCurrentTurnUnknownRows: false });
      this.sealAutonomousTurnLedger(sessionId, probe.maxStepIdx);
      this.autonomousBaselineStepIdx = probe.maxStepIdx;
      this.autonomousEmittedStepIdx = Math.max(this.autonomousEmittedStepIdx, probe.maxStepIdx);
      this.autonomousTurnActive = false;
      this.autonomousPendingToolCalls = [];
      this.autonomousLastPlannerHadToolCalls = false;
      this.autonomousIdleSettlePolls = 0;
      const ledger = this.usageLedgers.get(sessionId);
      if (ledger) {
        void this.confirmPendingDurableEmissions(ledger);
      }
      this.emit({ type: 'token-count', engine: 'agy', usage: {} });
      this.emit({ type: 'status', status: 'idle' });
    }

    this.scheduleNextAutonomousPoll();
  }

  private isAutonomousTurnComplete(
    sessionId: string,
    latestStep: { idx: number; stepType: number; status: number } | null,
  ): boolean {
    if (!latestStep || this.autonomousPendingToolCalls.length > 0) {
      return false;
    }

    const now = Date.now();

    // Case 1: Normal terminal `PLANNER_RESPONSE` (`stepType === 15`, `status === 3` `DONE`)
    // with no tool calls, transcript caught up, at least one quiet poll, and `gen_metadata`
    // finalized (or fallback timeout elapsed).
    if (
      latestStep.stepType === 15 &&
      latestStep.status === 3 &&
      !this.autonomousLastPlannerHadToolCalls &&
      this.autonomousEmittedStepIdx >= latestStep.idx &&
      this.autonomousIdleSettlePolls >= 1
    ) {
      const finalized = checkAgyIdlePlannerStepFinalized(
        sessionId,
        latestStep.idx - 1,
        -1,
        { agyHomeDir: this.agyHomeDir },
      );
      if (
        finalized.finalized ||
        now - this.autonomousLastStepChangeAt >= AUTONOMOUS_GEN_METADATA_FALLBACK_MS
      ) {
        return true;
      }
    }

    // Case 2: Cancelled or failed `PLANNER_RESPONSE` (`status === 6` or `7`, NOT tool result `132`).
    if (
      latestStep.stepType === 15 &&
      (latestStep.status === 6 || latestStep.status === 7) &&
      this.autonomousIdleSettlePolls >= 1
    ) {
      return true;
    }

    // Case 3: `ERROR_MESSAGE` (`stepType === 17`, `status === 3`) where native retry backoff
    // (`~22s`) has expired without inserting a new retry `PLANNER_RESPONSE`.
    if (
      latestStep.stepType === 17 &&
      latestStep.status === 3 &&
      this.autonomousEmittedStepIdx >= latestStep.idx &&
      now - this.autonomousLastStepChangeAt >= AUTONOMOUS_ERROR_IDLE_TIMEOUT_MS
    ) {
      return true;
    }

    return false;
  }

  private readNewAutonomousTranscriptSteps(sessionId: string): void {
    const candidate = this.resolveAutonomousTranscriptCandidate(sessionId);
    if (!candidate) return;

    if (
      this.autonomousTranscriptPath === null ||
      (candidate.isFull && this.autonomousTranscriptPath !== candidate.path)
    ) {
      this.autonomousTranscriptPath = candidate.path;
      const windowBytes = AUTONOMOUS_TRANSCRIPT_TAIL_WINDOW_BYTES * 4;
      if (candidate.size > windowBytes) {
        this.autonomousTranscriptOffset = candidate.size - windowBytes;
        this.autonomousSkipPartialFirstLine = true;
      } else {
        this.autonomousTranscriptOffset = 0;
        this.autonomousSkipPartialFirstLine = false;
      }
    }

    const filePath = this.autonomousTranscriptPath;
    if (!filePath) return;

    let fd: number | null = null;
    try {
      fd = openSync(filePath, 'r');
      const totalSize = fstatSync(fd).size;
      if (totalSize < this.autonomousTranscriptOffset) {
        // File was truncated or recreated.
        this.autonomousTranscriptOffset = 0;
        this.autonomousSkipPartialFirstLine = false;
      }
      while (this.autonomousTranscriptOffset < totalSize) {
        const toRead = Math.min(
          totalSize - this.autonomousTranscriptOffset,
          Math.max(AUTONOMOUS_TRANSCRIPT_READ_CHUNK_BYTES, 512 * 1024),
        );
        const buf = Buffer.allocUnsafe(toRead);
        const bytesRead = readSync(fd, buf, 0, toRead, this.autonomousTranscriptOffset);
        if (bytesRead <= 0) break;
        const slice = buf.subarray(0, bytesRead);
        const lastNl = slice.lastIndexOf(0x0a);
        if (lastNl < 0) {
          if (bytesRead >= MAX_ACP_LINE_BYTES) {
            this.autonomousTranscriptOffset += bytesRead;
            this.autonomousSkipPartialFirstLine = true;
          }
          break;
        }
        const completeBytes = slice.subarray(0, lastNl + 1);
        this.autonomousTranscriptOffset += lastNl + 1;
        const decoded = completeBytes.toString('utf8');
        const rawLines = decoded.split('\n');
        // Trailing element after final '\n' is always ''.
        rawLines.pop();
        let startIdx = 0;
        if (this.autonomousSkipPartialFirstLine && rawLines.length > 0) {
          this.autonomousSkipPartialFirstLine = false;
          startIdx = 1;
        }
        for (let i = startIdx; i < rawLines.length; i++) {
          const line = rawLines[i].trim();
          if (!line || !line.startsWith('{')) continue;
          this.processAutonomousTranscriptLine(line);
        }
        if (lastNl + 1 < bytesRead) {
          // Remaining bytes after `lastNl` belong to an incomplete trailing line at EOF.
          break;
        }
      }
    } catch {
      // Transient filesystem errors are retried on the next poll.
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {}
      }
    }
  }

  private processAutonomousTranscriptLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isPlainObject(parsed)) return;
    const stepIndex = parsed.step_index;
    if (
      typeof stepIndex !== 'number' ||
      !Number.isSafeInteger(stepIndex) ||
      stepIndex <= this.autonomousEmittedStepIdx
    ) {
      return;
    }

    this.autonomousEmittedStepIdx = stepIndex;
    const source = typeof parsed.source === 'string' ? parsed.source : '';
    const type = typeof parsed.type === 'string' ? parsed.type : '';

    if (source === 'MODEL' && type === 'PLANNER_RESPONSE') {
      if (typeof parsed.thinking === 'string' && parsed.thinking.trim().length > 0) {
        this.emit({
          type: 'event',
          name: 'thinking',
          payload: { text: parsed.thinking, streaming: false },
        });
      }
      if (typeof parsed.content === 'string' && parsed.content.trim().length > 0) {
        this.emit({
          type: 'model-output',
          textDelta: parsed.content,
        });
        this.emit({ type: 'event', name: 'output-complete', payload: null });
      }
      const toolCalls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [];
      if (toolCalls.length > 0) {
        this.autonomousLastPlannerHadToolCalls = true;
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = asPlainObject(toolCalls[i]);
          const toolName =
            typeof tc.name === 'string' && tc.name.trim().length > 0 ? tc.name.trim() : 'tool';
          const args = isPlainObject(tc.args) ? tc.args : {};
          const callId = `auto-${stepIndex}-${i}`;
          this.autonomousPendingToolCalls.push({ callId, toolName });
          this.emit({
            type: 'tool-call',
            toolName,
            callId,
            args,
          });
        }
      } else {
        this.autonomousLastPlannerHadToolCalls = false;
      }
      return;
    }

    if (source === 'MODEL' && type === 'GENERIC') {
      const pendingCall = this.autonomousPendingToolCalls.shift();
      if (!pendingCall) return;
      const status = typeof parsed.status === 'string' ? parsed.status : '';
      if (status === 'ERROR') {
        const errMsg =
          (typeof parsed.error === 'string' && parsed.error.trim()) ||
          (typeof parsed.content === 'string' && parsed.content.trim()) ||
          'Tool call failed';
        this.emit({
          type: 'tool-result',
          toolName: pendingCall.toolName,
          callId: pendingCall.callId,
          result: { error: errMsg, status: 'failed' },
        });
      } else {
        this.emit({
          type: 'tool-result',
          toolName: pendingCall.toolName,
          callId: pendingCall.callId,
          result: typeof parsed.content === 'string' ? parsed.content : '',
        });
      }
      return;
    }

    if (source === 'SYSTEM' && type === 'ERROR_MESSAGE') {
      const errBanner =
        (typeof parsed.content === 'string' && parsed.content.trim()) ||
        (typeof parsed.error === 'string' && parsed.error.trim()) ||
        '';
      if (errBanner) {
        const formatted = errBanner.startsWith('⚠️') ? errBanner : `⚠️ ${errBanner}`;
        this.emit({
          type: 'model-output',
          textDelta: `\n${formatted}\n`,
        });
        this.emit({ type: 'event', name: 'output-complete', payload: null });
      }
    }
  }

  private flushMidTurnOutputNow(
    turn: ActiveTurnState,
    opts?: {
      completedBaseline?: { stepIdx: number; genIdx: number };
      turnEnding?: boolean;
    },
  ): void {
    if (turn.midTurnFlushTimer !== null) {
      clearTimeout(turn.midTurnFlushTimer);
      turn.midTurnFlushTimer = null;
    }
    turn.midTurnFlushPolls = 0;
    if (turn.pendingUnflushedOutput) {
      turn.pendingUnflushedOutput = false;
      if (opts?.completedBaseline) {
        turn.outputStepBaselineIdx = Math.max(
          turn.outputStepBaselineIdx,
          opts.completedBaseline.stepIdx,
        );
        turn.outputGenBaselineIdx = Math.max(
          turn.outputGenBaselineIdx,
          opts.completedBaseline.genIdx,
        );
      } else if (!opts?.turnEnding && turn.inPromptPhase) {
        const sessionId = turn.sessionId ?? this.activeSessionId;
        const nextBaseline = readAgyCompletedOutputBaseline(
          sessionId,
          turn.outputStepBaselineIdx,
          turn.outputGenBaselineIdx,
          { agyHomeDir: this.agyHomeDir },
        );
        turn.outputStepBaselineIdx = nextBaseline.stepBaselineIdx;
        turn.outputGenBaselineIdx = nextBaseline.genBaselineIdx;
      }
      this.emit({ type: 'event', name: 'output-complete', payload: null });
    }
  }

  private clearTurnTimers(turn: ActiveTurnState): void {
    if (turn.midTurnFlushTimer !== null) {
      clearTimeout(turn.midTurnFlushTimer);
      turn.midTurnFlushTimer = null;
    }
    if (turn.cancelGraceTimer !== null) {
      clearTimeout(turn.cancelGraceTimer);
      turn.cancelGraceTimer = null;
    }
  }

  private probeHandoffTargetPresence(filePath: string): 'exists' | 'absent' | 'error' {
    try {
      this.handoffFs.statSync(filePath);
      return 'exists';
    } catch (err) {
      return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'absent' : 'error';
    }
  }

  private resolveUsageHandoffPath(conversationId: string, forWrite = false): string | null {
    if (!VALID_CONVERSATION_ID.test(conversationId)) return null;
    const homeDir = this.agyHomeDir ?? resolveDefaultAgyHomeDir();
    const convDir = join(homeDir, 'conversations');
    const dbPath = join(convDir, `${conversationId}.db`);
    const handoffPath = join(convDir, `${conversationId}.lmc-usage-handoff.json`);
    if (!forWrite) {
      return handoffPath;
    }
    if (
      this.agyHomeDir === undefined &&
      this.probeHandoffTargetPresence(dbPath) === 'absent' &&
      this.probeHandoffTargetPresence(handoffPath) === 'absent'
    ) {
      // Pure in-memory mock tests without `agyHomeDir` or a conversation DB on disk
      // do not write sidecar files into the host user's default `~/.gemini/antigravity-cli`.
      return null;
    }
    this.handoffFs.mkdirSync(convDir, { recursive: true, mode: 0o700 });
    return handoffPath;
  }

  private sanitizePersistedTriple(raw: unknown): TokenCounterTriple | null {
    if (!isPlainObject(raw)) return null;
    const input = toSafeNonNegInt(raw.input);
    const output = toSafeNonNegInt(raw.output);
    const cacheRead = toSafeNonNegInt(raw.cacheRead);
    if (input === null || output === null || cacheRead === null) return null;
    return { input, output, cacheRead };
  }

  private sanitizePersistedRowOwner(raw: unknown): RowUsageOwner | null {
    if (!isPlainObject(raw)) return null;
    if (raw.kind === 'known') {
      const turnSeq = toSafeNonNegInt(raw.turnSeq);
      if (turnSeq === null || turnSeq < 1) return null;
      if (typeof raw.startedAt !== 'number' || !Number.isFinite(raw.startedAt) || raw.startedAt < 0) {
        return null;
      }
      if (raw.model !== null && typeof raw.model !== 'string') return null;
      return { kind: 'known', model: raw.model, startedAt: raw.startedAt, turnSeq };
    }
    if (raw.kind === 'unknown' && Array.isArray(raw.candidateTurnSeqs)) {
      const seqs: number[] = [];
      for (const s of raw.candidateTurnSeqs) {
        const parsed = toSafeNonNegInt(s);
        if (parsed === null || parsed < 1) return null;
        seqs.push(parsed);
      }
      return { kind: 'unknown', candidateTurnSeqs: seqs };
    }
    return null;
  }

  private parsePersistedUsageHandoffJson(
    conversationId: string,
    rawJson: string,
    loadedFromFallback: boolean,
  ):
    | {
        status: 'loaded';
        ledger: ConversationUsageLedger;
        nextProcessGen: number;
        nextTurnSeq: number;
        persistedAt: number;
      }
    | { status: 'corrupt'; error: Error } {
    const corrupt = (reason: string): { status: 'corrupt'; error: Error } => ({
      status: 'corrupt',
      error: new Error(
        `Refusing to seed or release Antigravity usage ledger: invalid handoff sidecar (${reason})`,
      ),
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch (err) {
      return corrupt(err instanceof Error ? err.message : 'malformed JSON');
    }

    if (!isPlainObject(parsed) || parsed.version !== 1 || parsed.conversationId !== conversationId) {
      return corrupt('header mismatch');
    }
    const nextProcessGen = toSafeNonNegInt(parsed.nextProcessGen);
    const nextTurnSeq = toSafeNonNegInt(parsed.nextTurnSeq);
    const persistedAt =
      parsed.persistedAt === undefined ? 0 : toSafeNonNegInt(parsed.persistedAt);
    if (
      nextProcessGen === null ||
      nextTurnSeq === null ||
      persistedAt === null ||
      typeof parsed.seeded !== 'boolean' ||
      typeof parsed.hadUncertainTurnBoundary !== 'boolean' ||
      typeof parsed.baselineMaxGenIdx !== 'number' ||
      !Number.isSafeInteger(parsed.baselineMaxGenIdx) ||
      parsed.baselineMaxGenIdx < -1 ||
      !Array.isArray(parsed.emittedRowIndices) ||
      !Array.isArray(parsed.rowOwners) ||
      !Array.isArray(parsed.finalizedRows) ||
      !Array.isArray(parsed.turns) ||
      (parsed.pendingDurableEmissions !== undefined &&
        !Array.isArray(parsed.pendingDurableEmissions))
    ) {
      return corrupt('missing or invalid top-level fields');
    }

    const emittedRowIndices = new Set<number>();
    for (const idx of parsed.emittedRowIndices) {
      const n = toSafeNonNegInt(idx);
      if (n === null) return corrupt('invalid emittedRowIndices entry');
      emittedRowIndices.add(n);
    }

    const rowOwners = new Map<number, RowUsageOwner>();
    let maxSeenTurnSeq = nextTurnSeq;
    let maxSeenProcGen = nextProcessGen;
    for (const pair of parsed.rowOwners) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        return corrupt('invalid rowOwners tuple');
      }
      const idx = toSafeNonNegInt(pair[0]);
      const owner = this.sanitizePersistedRowOwner(pair[1]);
      if (idx === null || !owner) {
        return corrupt('invalid rowOwners entry');
      }
      if (owner.kind === 'known') {
        maxSeenTurnSeq = Math.max(maxSeenTurnSeq, owner.turnSeq);
      } else {
        for (const cSeq of owner.candidateTurnSeqs) {
          maxSeenTurnSeq = Math.max(maxSeenTurnSeq, cSeq);
        }
      }
      rowOwners.set(idx, owner);
    }

    const finalizedRows: FinalizedUsageRow[] = [];
    for (const item of parsed.finalizedRows) {
      if (!isPlainObject(item) || !Array.isArray(item.matchedByTurn)) {
        return corrupt('invalid finalizedRows object');
      }
      const rowIdx = toSafeNonNegInt(item.rowIdx);
      const owner = this.sanitizePersistedRowOwner(item.owner);
      const raw = this.sanitizePersistedTriple(item.raw);
      const emittedNet = this.sanitizePersistedTriple(item.emittedNet);
      const reconcileEmitSeq = toSafeNonNegInt(item.reconcileEmitSeq);
      if (
        rowIdx === null ||
        !owner ||
        !raw ||
        !emittedNet ||
        reconcileEmitSeq === null ||
        (item.usageModel !== null && typeof item.usageModel !== 'string') ||
        (item.usageStartedAt !== undefined &&
          (typeof item.usageStartedAt !== 'number' ||
            !Number.isFinite(item.usageStartedAt) ||
            item.usageStartedAt < 0))
      ) {
        return corrupt('invalid finalizedRows fields');
      }
      if (owner.kind === 'known') {
        maxSeenTurnSeq = Math.max(maxSeenTurnSeq, owner.turnSeq);
      } else {
        for (const cSeq of owner.candidateTurnSeqs) {
          maxSeenTurnSeq = Math.max(maxSeenTurnSeq, cSeq);
        }
      }
      const matchedByTurn = new Map<number, TokenCounterTriple>();
      for (const mp of item.matchedByTurn) {
        if (!Array.isArray(mp) || mp.length !== 2) {
          return corrupt('invalid matchedByTurn tuple');
        }
        const tSeq = toSafeNonNegInt(mp[0]);
        const triple = this.sanitizePersistedTriple(mp[1]);
        if (tSeq === null || tSeq < 1 || !triple) {
          return corrupt('invalid matchedByTurn entry');
        }
        maxSeenTurnSeq = Math.max(maxSeenTurnSeq, tSeq);
        matchedByTurn.set(tSeq, triple);
      }
      finalizedRows.push({
        rowIdx,
        owner,
        raw,
        matchedByTurn,
        emittedNet,
        usageModel: item.usageModel,
        usageStartedAt: item.usageStartedAt,
        reconcileEmitSeq,
      });
    }

    const turns = new Map<number, TurnUsageRecord>();
    for (const t of parsed.turns) {
      if (!isPlainObject(t) || !Array.isArray(t.unfinishedKnownRows)) {
        return corrupt('invalid turns object');
      }
      const turnSeq = toSafeNonNegInt(t.turnSeq);
      const procGen = toSafeNonNegInt(t.procGen);
      const reconciledKnownSqlTokens = this.sanitizePersistedTriple(t.reconciledKnownSqlTokens);
      const fallbackCredit = this.sanitizePersistedTriple(t.fallbackCredit);
      if (
        turnSeq === null ||
        turnSeq < 1 ||
        procGen === null ||
        !reconciledKnownSqlTokens ||
        !fallbackCredit ||
        (t.turnInstanceId !== undefined &&
          (typeof t.turnInstanceId !== 'string' || !t.turnInstanceId)) ||
        (t.model !== null && typeof t.model !== 'string') ||
        typeof t.startedAt !== 'number' ||
        !Number.isFinite(t.startedAt) ||
        t.startedAt < 0 ||
        typeof t.procExitedAfterScan !== 'boolean' ||
        typeof t.hadGenerationOpportunity !== 'boolean'
      ) {
        return corrupt('invalid turns fields');
      }
      if (
        t.preMaxStepIdx !== null &&
        (typeof t.preMaxStepIdx !== 'number' ||
          !Number.isSafeInteger(t.preMaxStepIdx) ||
          t.preMaxStepIdx < -1)
      ) {
        return corrupt('invalid preMaxStepIdx');
      }
      if (
        t.closedMaxStepIdx !== null &&
        (typeof t.closedMaxStepIdx !== 'number' ||
          !Number.isSafeInteger(t.closedMaxStepIdx) ||
          t.closedMaxStepIdx < -1)
      ) {
        return corrupt('invalid closedMaxStepIdx');
      }
      let expectedPromptUsage: TokenCounterTriple | null = null;
      if (t.expectedPromptUsage !== null && t.expectedPromptUsage !== undefined) {
        expectedPromptUsage = this.sanitizePersistedTriple(t.expectedPromptUsage);
        if (!expectedPromptUsage) {
          return corrupt('invalid expectedPromptUsage');
        }
      }
      const unfinishedKnownRows = new Set<number>();
      for (const rIdx of t.unfinishedKnownRows) {
        const n = toSafeNonNegInt(rIdx);
        if (n === null) return corrupt('invalid unfinishedKnownRows entry');
        unfinishedKnownRows.add(n);
      }
      maxSeenTurnSeq = Math.max(maxSeenTurnSeq, turnSeq);
      maxSeenProcGen = Math.max(maxSeenProcGen, procGen);
      turns.set(turnSeq, {
        turnSeq,
        procGen,
        turnInstanceId:
          typeof t.turnInstanceId === 'string' && t.turnInstanceId
            ? t.turnInstanceId
            : 'hydrated-handoff',
        model: t.model,
        startedAt: t.startedAt,
        preMaxStepIdx: t.preMaxStepIdx,
        closedMaxStepIdx: t.closedMaxStepIdx,
        expectedPromptUsage,
        reconciledKnownSqlTokens,
        fallbackCredit,
        unfinishedKnownRows,
        procExitedAfterScan: t.procExitedAfterScan,
        hadGenerationOpportunity: t.hadGenerationOpportunity,
      });
    }

    const pendingDurableEmissions = new Map<string, PersistedPendingBillingEmission>();
    if (Array.isArray(parsed.pendingDurableEmissions)) {
      for (const p of parsed.pendingDurableEmissions) {
        if (
          !isPlainObject(p) ||
          typeof p.usageKey !== 'string' ||
          !p.usageKey ||
          !isPlainObject(p.usage) ||
          (p.usageModel !== null && typeof p.usageModel !== 'string') ||
          (p.usageStartedAt !== undefined &&
            (typeof p.usageStartedAt !== 'number' ||
              !Number.isFinite(p.usageStartedAt) ||
              p.usageStartedAt < 0))
        ) {
          return corrupt('invalid pendingDurableEmissions entry');
        }
        const inTok = toSafeNonNegInt(p.usage.input_tokens);
        const outTok = toSafeNonNegInt(p.usage.output_tokens);
        const cacheTok = toSafeNonNegInt(p.usage.cache_read_tokens);
        const totTok = toSafeNonNegInt(p.usage.total_tokens);
        if (inTok === null || outTok === null || cacheTok === null || totTok === null) {
          return corrupt('invalid pendingDurableEmissions usage tokens');
        }
        pendingDurableEmissions.set(p.usageKey, {
          usageKey: p.usageKey,
          usage: {
            input_tokens: inTok,
            output_tokens: outTok,
            cache_read_tokens: cacheTok,
            total_tokens: totTok,
          },
          usageModel: p.usageModel,
          usageStartedAt: p.usageStartedAt,
        });
      }
    }

    for (const [rIdx, owner] of rowOwners.entries()) {
      if (owner.kind === 'known') {
        turns.get(owner.turnSeq)?.unfinishedKnownRows.add(rIdx);
      }
    }

    return {
      status: 'loaded',
      ledger: {
        seeded: parsed.seeded,
        baselineMaxGenIdx: parsed.baselineMaxGenIdx,
        emittedRowIndices,
        rowOwners,
        finalizedRows,
        turns,
        pendingDurableEmissions,
        hadUncertainTurnBoundary: parsed.hadUncertainTurnBoundary,
        loadedFromHandoff: true,
        loadedFromFallback,
        corruptHandoffError: null,
      },
      nextProcessGen: maxSeenProcGen,
      nextTurnSeq: maxSeenTurnSeq,
      persistedAt,
    };
  }

  private loadPersistedUsageHandoff(
    conversationId: string,
  ):
    | { status: 'absent' }
    | {
        status: 'loaded';
        ledger: ConversationUsageLedger;
        nextProcessGen: number;
        nextTurnSeq: number;
      }
    | { status: 'corrupt'; error: Error } {
    let localResult:
      | { status: 'absent' }
      | {
          status: 'loaded';
          ledger: ConversationUsageLedger;
          nextProcessGen: number;
          nextTurnSeq: number;
          persistedAt: number;
        }
      | { status: 'corrupt'; error: Error } = { status: 'absent' };

    const handoffPath = this.resolveUsageHandoffPath(conversationId, false);
    if (handoffPath) {
      try {
        const rawJson = this.handoffFs.readFileSync(handoffPath, 'utf8');
        localResult = this.parsePersistedUsageHandoffJson(conversationId, rawJson, false);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          const msg = err instanceof Error ? err.message : String(err);
          localResult = {
            status: 'corrupt',
            error: new Error(
              `Refusing to seed or release Antigravity usage ledger: unreadable handoff sidecar (${msg})`,
            ),
          };
        }
      }
    }

    let fallbackRaw: string | null | undefined = null;
    if (this.loadFallbackHandoff) {
      try {
        fallbackRaw = this.loadFallbackHandoff(conversationId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (localResult.status === 'absent') {
          return {
            status: 'corrupt',
            error: new Error(
              `Refusing to seed or release Antigravity usage ledger: unreadable fallback handoff (${msg})`,
            ),
          };
        }
      }
    }

    if (typeof fallbackRaw === 'string' && fallbackRaw.trim().length > 0) {
      const fbResult = this.parsePersistedUsageHandoffJson(conversationId, fallbackRaw, true);
      if (fbResult.status === 'corrupt') {
        return localResult.status === 'loaded' ? localResult : fbResult;
      }
      if (localResult.status !== 'loaded') {
        return fbResult;
      }
      const fbNewer =
        fbResult.nextTurnSeq !== localResult.nextTurnSeq
          ? fbResult.nextTurnSeq > localResult.nextTurnSeq
          : fbResult.ledger.emittedRowIndices.size !== localResult.ledger.emittedRowIndices.size
            ? fbResult.ledger.emittedRowIndices.size > localResult.ledger.emittedRowIndices.size
            : fbResult.ledger.finalizedRows.length !== localResult.ledger.finalizedRows.length
              ? fbResult.ledger.finalizedRows.length > localResult.ledger.finalizedRows.length
              : fbResult.persistedAt >= localResult.persistedAt;
      const chosen = fbNewer ? fbResult : localResult;
      chosen.ledger.loadedFromFallback = true;
      chosen.ledger.loadedFromHandoff = true;
      return chosen;
    }

    return localResult;
  }

  private advanceAndRebindActiveIdentitiesOnHydration(
    ledger: ConversationUsageLedger,
    minNextProcGen: number,
    minNextTurnSeq: number,
  ): void {
    let maxTurnSeq = minNextTurnSeq;
    let maxProcGen = minNextProcGen;
    for (const [tSeq, rec] of ledger.turns.entries()) {
      maxTurnSeq = Math.max(maxTurnSeq, tSeq, rec.turnSeq);
      maxProcGen = Math.max(maxProcGen, rec.procGen);
    }
    for (const owner of ledger.rowOwners.values()) {
      if (owner.kind === 'known') {
        maxTurnSeq = Math.max(maxTurnSeq, owner.turnSeq);
      } else {
        for (const cSeq of owner.candidateTurnSeqs) {
          maxTurnSeq = Math.max(maxTurnSeq, cSeq);
        }
      }
    }
    for (const fin of ledger.finalizedRows) {
      if (fin.owner.kind === 'known') {
        maxTurnSeq = Math.max(maxTurnSeq, fin.owner.turnSeq);
      } else {
        for (const cSeq of fin.owner.candidateTurnSeqs) {
          maxTurnSeq = Math.max(maxTurnSeq, cSeq);
        }
      }
      for (const mSeq of fin.matchedByTurn.keys()) {
        maxTurnSeq = Math.max(maxTurnSeq, mSeq);
      }
    }

    this.nextProcessGen = Math.max(this.nextProcessGen, maxProcGen);
    this.nextTurnSeq = Math.max(this.nextTurnSeq, maxTurnSeq);

    if (this.proc && this.proc.gen <= maxProcGen) {
      const oldGen = this.proc.gen;
      const newGen = ++this.nextProcessGen;
      this.proc.gen = newGen;
      for (const l of this.usageLedgers.values()) {
        for (const rec of l.turns.values()) {
          if (rec.turnInstanceId === this.sessionInstanceId && rec.procGen === oldGen) {
            rec.procGen = newGen;
          }
        }
      }
      for (const rec of ledger.turns.values()) {
        if (rec.turnInstanceId === this.sessionInstanceId && rec.procGen === oldGen) {
          rec.procGen = newGen;
        }
      }
    }

    if (
      this.activeTurn &&
      (this.activeTurn.turnSeq <= maxTurnSeq || ledger.turns.has(this.activeTurn.turnSeq))
    ) {
      this.activeTurn.turnSeq = ++this.nextTurnSeq;
    }
  }

  private refreshCorruptLedgerIfPossible(
    conversationId: string,
    ledger: ConversationUsageLedger,
  ): void {
    if (ledger.corruptHandoffError === null) return;
    const restored = this.loadPersistedUsageHandoff(conversationId);
    if (restored.status === 'loaded') {
      ledger.seeded = restored.ledger.seeded;
      ledger.baselineMaxGenIdx = restored.ledger.baselineMaxGenIdx;
      ledger.emittedRowIndices = restored.ledger.emittedRowIndices;
      ledger.rowOwners = restored.ledger.rowOwners;
      ledger.finalizedRows = restored.ledger.finalizedRows;
      ledger.turns = restored.ledger.turns;
      ledger.pendingDurableEmissions = restored.ledger.pendingDurableEmissions;
      ledger.hadUncertainTurnBoundary = restored.ledger.hadUncertainTurnBoundary;
      ledger.loadedFromHandoff = true;
      ledger.loadedFromFallback = Boolean(restored.ledger.loadedFromFallback);
      ledger.corruptHandoffError = null;
      this.advanceAndRebindActiveIdentitiesOnHydration(
        ledger,
        restored.nextProcessGen,
        restored.nextTurnSeq,
      );
    } else if (restored.status === 'absent') {
      ledger.corruptHandoffError = null;
    } else {
      ledger.corruptHandoffError = restored.error;
    }
  }

  private serializeUsageHandoff(
    conversationId: string,
    ledger: ConversationUsageLedger,
  ): string {
    const payload: PersistedConversationUsageHandoffV1 = {
      version: 1,
      conversationId,
      persistedAt: Date.now(),
      nextProcessGen: this.nextProcessGen,
      nextTurnSeq: this.nextTurnSeq,
      seeded: ledger.seeded,
      baselineMaxGenIdx: ledger.baselineMaxGenIdx,
      emittedRowIndices: Array.from(ledger.emittedRowIndices),
      rowOwners: Array.from(ledger.rowOwners.entries()),
      finalizedRows: ledger.finalizedRows.map((r) => ({
        rowIdx: r.rowIdx,
        owner: r.owner,
        raw: { ...r.raw },
        matchedByTurn: Array.from(r.matchedByTurn.entries()).map(([k, v]) => [k, { ...v }]),
        emittedNet: { ...r.emittedNet },
        usageModel: r.usageModel,
        usageStartedAt: r.usageStartedAt,
        reconcileEmitSeq: r.reconcileEmitSeq,
      })),
      turns: Array.from(ledger.turns.values()).map((t) => ({
        turnSeq: t.turnSeq,
        procGen: t.procGen,
        turnInstanceId: t.turnInstanceId,
        model: t.model,
        startedAt: t.startedAt,
        preMaxStepIdx: t.preMaxStepIdx,
        closedMaxStepIdx: t.closedMaxStepIdx,
        expectedPromptUsage: t.expectedPromptUsage ? { ...t.expectedPromptUsage } : null,
        reconciledKnownSqlTokens: { ...t.reconciledKnownSqlTokens },
        fallbackCredit: { ...t.fallbackCredit },
        unfinishedKnownRows: Array.from(t.unfinishedKnownRows),
        procExitedAfterScan: t.procExitedAfterScan,
        hadGenerationOpportunity: t.hadGenerationOpportunity,
      })),
      pendingDurableEmissions:
        ledger.pendingDurableEmissions.size > 0
          ? Array.from(ledger.pendingDurableEmissions.values()).map((p) => ({
              usageKey: p.usageKey,
              usage: { ...p.usage },
              usageModel: p.usageModel,
              usageStartedAt: p.usageStartedAt,
            }))
          : undefined,
      hadUncertainTurnBoundary: ledger.hadUncertainTurnBoundary,
    };
    return JSON.stringify(payload);
  }

  private persistUsageHandoff(conversationId: string, ledger: ConversationUsageLedger): boolean {
    const handoffPath = this.resolveUsageHandoffPath(conversationId, true);
    if (!handoffPath) return false;
    const serialized = this.serializeUsageHandoff(conversationId, ledger);
    const tmpPath = `${handoffPath}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | null = null;
    try {
      fd = this.handoffFs.openSync(tmpPath, 'wx', 0o600);
      this.handoffFs.writeFileSync(fd, serialized, { encoding: 'utf8' });
      this.handoffFs.chmodSync(tmpPath, 0o600);
      this.handoffFs.fsyncSync(fd);
      this.handoffFs.closeSync(fd);
      fd = null;
      this.handoffFs.renameSync(tmpPath, handoffPath);
      try {
        const dirFd = this.handoffFs.openSync(dirname(handoffPath), 'r');
        try {
          this.handoffFs.fsyncSync(dirFd);
        } finally {
          this.handoffFs.closeSync(dirFd);
        }
      } catch {
        // Parent directory fsync is best-effort on platforms/VFS that reject dir FDs.
      }
      return true;
    } catch (err) {
      if (fd !== null) {
        try {
          this.handoffFs.closeSync(fd);
        } catch {}
      }
      try {
        this.handoffFs.unlinkSync(tmpPath);
      } catch {}
      throw err;
    }
  }

  private removePersistedUsageHandoff(conversationId: string): void {
    const handoffPath = this.resolveUsageHandoffPath(conversationId, false);
    if (!handoffPath) return;
    try {
      this.handoffFs.unlinkSync(handoffPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return;
      }
      throw err;
    }
  }

  async transferUnpersistedHandoffs(
    transfer?: (conversationId: string, serializedHandoff: string | null) => Promise<void>,
  ): Promise<boolean> {
    const targetTransfer = transfer ?? this.persistFallbackHandoff;
    if (!targetTransfer) return false;
    if (this.hasUnconfirmedChildExit) return false;

    for (const [conversationId, ledger] of this.usageLedgers.entries()) {
      if (ledger.corruptHandoffError !== null) {
        this.refreshCorruptLedgerIfPossible(conversationId, ledger);
        if (ledger.corruptHandoffError !== null) {
          return false;
        }
      }

      this.replayUnemittedPendingEmissions(ledger);
      const readOk = this.syncSqlStepUsage(conversationId, null, {
        deferCurrentTurnUnknownRows: false,
      });
      if (readOk) {
        for (const rec of ledger.turns.values()) {
          rec.procExitedAfterScan = true;
        }
        if (this.openInsertCapableTurns(ledger).length === 0) {
          ledger.hadUncertainTurnBoundary = false;
        }
      }

      await this.confirmPendingDurableEmissions(ledger);

      const hasFallback =
        Boolean(ledger.loadedFromFallback) ||
        Boolean(this.loadFallbackHandoff?.(conversationId));
      const hadActivity =
        Boolean(ledger.loadedFromHandoff) ||
        hasFallback ||
        ledger.turns.size > 0 ||
        ledger.rowOwners.size > 0 ||
        ledger.pendingDurableEmissions.size > 0 ||
        ledger.hadUncertainTurnBoundary;
      if (!hadActivity) {
        continue;
      }

      const unresolved =
        !ledger.seeded ||
        !readOk ||
        ledger.rowOwners.size > 0 ||
        ledger.pendingDurableEmissions.size > 0 ||
        ledger.hadUncertainTurnBoundary ||
        Array.from(ledger.turns.values()).some(
          (t) =>
            t.unfinishedKnownRows.size > 0 ||
            (t.hadGenerationOpportunity && !t.procExitedAfterScan),
        );

      if (unresolved) {
        await targetTransfer(conversationId, this.serializeUsageHandoff(conversationId, ledger));
        ledger.loadedFromFallback = true;
        ledger.loadedFromHandoff = true;
      } else {
        let removedLocal = true;
        try {
          this.removePersistedUsageHandoff(conversationId);
        } catch {
          removedLocal = false;
        }
        if (!removedLocal) {
          // Stale local sidecar could not be unlinked; publish newer resolved ledger
          // to fallback metadata so recovery supersedes the stale local file.
          await targetTransfer(conversationId, this.serializeUsageHandoff(conversationId, ledger));
          ledger.loadedFromFallback = true;
        } else if (hasFallback) {
          await targetTransfer(conversationId, null);
          ledger.loadedFromFallback = false;
          ledger.loadedFromHandoff = false;
        }
      }
    }

    this.lastClosePersistFailed = false;
    return true;
  }

  private async reconcileOwnedLedgersOnClose(persistHandoff: boolean): Promise<void> {
    if (persistHandoff) {
      this.lastClosePersistFailed = false;
    }
    const allChildrenExited =
      this.proc === null &&
      this.retiringProcesses.size === 0 &&
      this.unkillableHandles.size === 0;

    let firstPersistError: unknown = null;
    const scannedLedgers: Array<{
      conversationId: string;
      ledger: ConversationUsageLedger;
      readOk: boolean;
    }> = [];

    for (const [conversationId, ledger] of this.usageLedgers.entries()) {
      if (ledger.corruptHandoffError !== null) {
        this.refreshCorruptLedgerIfPossible(conversationId, ledger);
        if (ledger.corruptHandoffError !== null) {
          if (persistHandoff && firstPersistError === null) {
            firstPersistError = ledger.corruptHandoffError;
          }
          continue;
        }
      }

      this.replayUnemittedPendingEmissions(ledger);
      const readOk = this.syncSqlStepUsage(conversationId, null, {
        deferCurrentTurnUnknownRows: false,
      });
      if (allChildrenExited && readOk) {
        for (const rec of ledger.turns.values()) {
          rec.procExitedAfterScan = true;
        }
        if (this.openInsertCapableTurns(ledger).length === 0) {
          ledger.hadUncertainTurnBoundary = false;
        }
      }
      scannedLedgers.push({ conversationId, ledger, readOk });
    }

    let durableConfirmError: unknown = null;
    const anyPendingDurable = scannedLedgers.some(
      ({ ledger }) => ledger.pendingDurableEmissions.size > 0,
    );
    if (this.confirmUsageDurable && anyPendingDurable) {
      try {
        await this.confirmUsageDurable();
        for (const { ledger } of scannedLedgers) {
          for (const key of [...ledger.pendingDurableEmissions.keys()]) {
            if (this.emittedInCurrentProcess.has(key)) {
              ledger.pendingDurableEmissions.delete(key);
            }
          }
        }
      } catch (err) {
        durableConfirmError = err;
      }
    }

    if (!persistHandoff) {
      if (firstPersistError !== null) {
        throw firstPersistError;
      }
      return;
    }

    for (const { conversationId, ledger, readOk } of scannedLedgers) {
      const hasFallback =
        Boolean(ledger.loadedFromFallback) ||
        Boolean(this.loadFallbackHandoff?.(conversationId));
      const hadActivity =
        Boolean(ledger.loadedFromHandoff) ||
        hasFallback ||
        ledger.turns.size > 0 ||
        ledger.rowOwners.size > 0 ||
        ledger.pendingDurableEmissions.size > 0 ||
        ledger.hadUncertainTurnBoundary;
      if (!hadActivity) {
        continue;
      }

      const unresolved =
        !allChildrenExited ||
        !ledger.seeded ||
        !readOk ||
        ledger.rowOwners.size > 0 ||
        ledger.pendingDurableEmissions.size > 0 ||
        ledger.hadUncertainTurnBoundary ||
        Array.from(ledger.turns.values()).some(
          (t) =>
            t.unfinishedKnownRows.size > 0 ||
            (t.hadGenerationOpportunity && !t.procExitedAfterScan),
        );

      try {
        if (unresolved) {
          const wroteSidecar = this.persistUsageHandoff(conversationId, ledger);
          if (!wroteSidecar) {
            throw (
              durableConfirmError ??
              new Error('Unable to resolve Antigravity usage handoff path for unresolved ledger')
            );
          }
          if (hasFallback && this.persistFallbackHandoff) {
            await this.persistFallbackHandoff(
              conversationId,
              this.serializeUsageHandoff(conversationId, ledger),
            ).catch(() => {});
          }
        } else {
          this.removePersistedUsageHandoff(conversationId);
          if (hasFallback && this.persistFallbackHandoff) {
            await this.persistFallbackHandoff(conversationId, null);
          }
          ledger.loadedFromHandoff = false;
          ledger.loadedFromFallback = false;
        }
      } catch (err) {
        if (firstPersistError === null) {
          firstPersistError = err;
        }
      }
    }

    if (firstPersistError !== null) {
      if (persistHandoff) {
        this.lastClosePersistFailed = true;
      }
      throw firstPersistError;
    }
  }

  private getOrCreateLedger(conversationId: string): ConversationUsageLedger {
    let ledger = this.usageLedgers.get(conversationId);
    if (!ledger) {
      const restored = this.loadPersistedUsageHandoff(conversationId);
      if (restored.status === 'loaded') {
        ledger = restored.ledger;
        this.usageLedgers.set(conversationId, ledger);
        this.advanceAndRebindActiveIdentitiesOnHydration(
          ledger,
          restored.nextProcessGen,
          restored.nextTurnSeq,
        );
      } else {
        ledger = {
          seeded: false,
          baselineMaxGenIdx: -1,
          emittedRowIndices: new Set<number>(),
          rowOwners: new Map<number, RowUsageOwner>(),
          finalizedRows: [],
          turns: new Map<number, TurnUsageRecord>(),
          pendingDurableEmissions: new Map<string, PersistedPendingBillingEmission>(),
          hadUncertainTurnBoundary: false,
          corruptHandoffError: restored.status === 'corrupt' ? restored.error : null,
        };
        this.usageLedgers.set(conversationId, ledger);
      }
    } else if (ledger.corruptHandoffError !== null) {
      this.refreshCorruptLedgerIfPossible(conversationId, ledger);
    }
    return ledger;
  }

  private ensureNewConversationLedger(conversationId: string): void {
    const ledger = this.getOrCreateLedger(conversationId);
    if (ledger.corruptHandoffError !== null) {
      return;
    }
    ledger.seeded = true;
    ledger.baselineMaxGenIdx = -1;
  }

  private trySeedExistingConversation(conversationId: string): boolean {
    const ledger = this.getOrCreateLedger(conversationId);
    if (ledger.corruptHandoffError !== null) {
      return false;
    }
    if (ledger.seeded) return true;
    // Never retroactively establish a historical baseline after an owned turn has
    // already had an opportunity to generate new SQLite rows!
    if (Array.from(ledger.turns.values()).some((t) => t.hadGenerationOpportunity)) {
      return false;
    }
    const snap = readAgyConversationStateSnapshot(conversationId, {
      agyHomeDir: this.agyHomeDir,
    });
    if (!snap.readOk) {
      // Do NOT mark `seeded = true` when an existing DB failed to open/read;
      // otherwise a subsequent successful read would recharge historical rows!
      return false;
    }
    ledger.seeded = true;
    ledger.baselineMaxGenIdx = snap.maxGenIdx;
    return true;
  }

  private openInsertCapableTurns(ledger: ConversationUsageLedger): TurnUsageRecord[] {
    const open: TurnUsageRecord[] = [];
    for (const rec of ledger.turns.values()) {
      if (rec.hadGenerationOpportunity && !rec.procExitedAfterScan) {
        open.push(rec);
      }
    }
    return open;
  }

  private registerTurnUsageRecord(
    ledger: ConversationUsageLedger,
    turn: ActiveTurnState,
    procGen: number,
  ): void {
    while (ledger.turns.has(turn.turnSeq)) {
      turn.turnSeq = ++this.nextTurnSeq;
    }
    const preSnap = turn.prePromptSnap;
    const allPriorTurnsStepBounded =
      preSnap !== null &&
      preSnap.readOk &&
      Array.from(ledger.turns.values()).every(
        (u) =>
          (u.closedMaxStepIdx === null || u.closedMaxStepIdx <= preSnap.maxStepIdx) &&
          (!u.hadGenerationOpportunity || u.procExitedAfterScan || u.closedMaxStepIdx !== null),
      );
    const preMaxStepIdx = allPriorTurnsStepBounded && preSnap ? preSnap.maxStepIdx : null;

    ledger.turns.set(turn.turnSeq, {
      turnSeq: turn.turnSeq,
      procGen,
      turnInstanceId: this.sessionInstanceId,
      model: turn.effectiveModel ?? turn.requestedModel ?? null,
      startedAt: turn.turnStartedAt,
      preMaxStepIdx,
      closedMaxStepIdx: null,
      expectedPromptUsage: null,
      reconciledKnownSqlTokens: { input: 0, output: 0, cacheRead: 0 },
      fallbackCredit: { input: 0, output: 0, cacheRead: 0 },
      unfinishedKnownRows: new Set<number>(),
      procExitedAfterScan: false,
      hadGenerationOpportunity: true,
    });
  }

  private reconcilePrePromptUsage(conversationId: string, currentProcGen: number): boolean {
    if (!this.trySeedExistingConversation(conversationId)) return false;
    const ledger = this.getOrCreateLedger(conversationId);
    this.replayUnemittedPendingEmissions(ledger);
    // Scan any delayed SQLite rows from prior turns BEFORE marking exited process
    // generations closed so rows written by an exited process keep their candidate turns.
    const readOk = this.syncSqlStepUsage(conversationId, null);
    if (!readOk) {
      if (this.openInsertCapableTurns(ledger).length > 0) {
        ledger.hadUncertainTurnBoundary = true;
      }
      return false;
    }

    for (const rec of ledger.turns.values()) {
      if (rec.procGen !== currentProcGen) {
        rec.procExitedAfterScan = true;
      }
    }
    if (this.openInsertCapableTurns(ledger).length === 0) {
      ledger.hadUncertainTurnBoundary = false;
      if (
        ledger.loadedFromHandoff &&
        !ledger.loadedFromFallback &&
        ledger.rowOwners.size === 0 &&
        ledger.pendingDurableEmissions.size === 0
      ) {
        try {
          this.removePersistedUsageHandoff(conversationId);
          ledger.loadedFromHandoff = false;
        } catch {
          // Retain `loadedFromHandoff = true` so terminal close retries removal or fails closed.
        }
      }
    }
    return true;
  }

  private finalizeCompletedTurnUsageOwnership(
    conversationId: string,
    turn: ActiveTurnState,
    endSyncOk: boolean,
    rawPromptUsage: unknown,
  ): void {
    const ledger = this.getOrCreateLedger(conversationId);
    const rec = ledger.turns.get(turn.turnSeq);
    if (!rec) return;
    rec.hadGenerationOpportunity = true;
    rec.expectedPromptUsage = parseAcpPromptTurnUsage(rawPromptUsage);

    if (!endSyncOk) {
      return;
    }

    if (rec.preMaxStepIdx !== null) {
      const postSnap = readAgyConversationStateSnapshot(conversationId, {
        agyHomeDir: this.agyHomeDir,
      });
      if (postSnap.readOk && postSnap.maxStepIdx >= rec.preMaxStepIdx) {
        rec.closedMaxStepIdx = postSnap.maxStepIdx;
      }
    }
  }

  private finalizeFailedTurnUsageOwnership(
    conversationId: string,
    turn: ActiveTurnState,
    setupProc: AcpProcessHandle | null,
    errSyncOk: boolean,
  ): void {
    const ledger = this.getOrCreateLedger(conversationId);
    const rec = ledger.turns.get(turn.turnSeq);
    if (!rec) return;

    rec.hadGenerationOpportunity = Boolean(
      turn.promptWriteCompleted ||
        turn.sawAnyTurnStreamEvent ||
        turn.sawOutput ||
        turn.sawToolActivity ||
        turn.observedNewGenRowIndices.size > 0,
    );

    const procConfirmedExited = Boolean(setupProc && setupProc.exited);
    if (procConfirmedExited && errSyncOk) {
      for (const r of ledger.turns.values()) {
        if (r.procGen === setupProc!.gen) {
          r.procExitedAfterScan = true;
        }
      }
      if (this.openInsertCapableTurns(ledger).length === 0) {
        ledger.hadUncertainTurnBoundary = false;
      }
    }
  }

  private matchTurnByStepIndices(
    ledger: ConversationUsageLedger,
    stepIndices: number[] | undefined,
    activeTurn: ActiveTurnState | null,
  ): TurnUsageRecord | null {
    if (!stepIndices || stepIndices.length === 0) return null;
    let minStep = stepIndices[0];
    let maxStep = stepIndices[0];
    if (!Number.isSafeInteger(minStep) || minStep < 0) return null;
    for (let i = 1; i < stepIndices.length; i++) {
      const s = stepIndices[i];
      if (!Number.isSafeInteger(s) || s < 0) return null;
      if (s < minStep) minStep = s;
      if (s > maxStep) maxStep = s;
    }

    for (const rec of ledger.turns.values()) {
      if (
        rec.preMaxStepIdx !== null &&
        rec.closedMaxStepIdx !== null &&
        minStep > rec.preMaxStepIdx &&
        maxStep <= rec.closedMaxStepIdx
      ) {
        return rec;
      }
    }

    if (activeTurn) {
      const activeRec = ledger.turns.get(activeTurn.turnSeq);
      if (
        activeRec &&
        activeRec.preMaxStepIdx !== null &&
        activeRec.closedMaxStepIdx === null &&
        minStep > activeRec.preMaxStepIdx
      ) {
        return activeRec;
      }
    } else if (this.autonomousTurnSeq !== null) {
      const autoRec = ledger.turns.get(this.autonomousTurnSeq);
      if (
        autoRec &&
        autoRec.preMaxStepIdx !== null &&
        autoRec.closedMaxStepIdx === null &&
        minStep > autoRec.preMaxStepIdx
      ) {
        return autoRec;
      }
    }

    return null;
  }

  private recordRowOwner(
    ledger: ConversationUsageLedger,
    rowIdx: number,
    owner: RowUsageOwner,
  ): void {
    const prev = ledger.rowOwners.get(rowIdx);
    if (prev && prev.kind === 'known') {
      ledger.turns.get(prev.turnSeq)?.unfinishedKnownRows.delete(rowIdx);
    }
    ledger.rowOwners.set(rowIdx, owner);
    if (owner.kind === 'known') {
      ledger.turns.get(owner.turnSeq)?.unfinishedKnownRows.add(rowIdx);
    }
  }

  private clearRowOwnerOnFinalize(ledger: ConversationUsageLedger, rowIdx: number): void {
    const prev = ledger.rowOwners.get(rowIdx);
    if (prev && prev.kind === 'known') {
      ledger.turns.get(prev.turnSeq)?.unfinishedKnownRows.delete(rowIdx);
    }
    ledger.emittedRowIndices.add(rowIdx);
    ledger.rowOwners.delete(rowIdx);
  }

  private assignInitialRowOwner(
    ledger: ConversationUsageLedger,
    rowIdx: number,
    stepIndices: number[] | undefined,
    turn: ActiveTurnState | null,
  ): RowUsageOwner {
    const preSnap = turn?.prePromptSnap ?? null;
    const existedInPreSnap = Boolean(
      turn !== null && preSnap?.readOk && preSnap.dbExists && rowIdx <= preSnap.maxGenIdx,
    );
    if (turn && !existedInPreSnap) {
      turn.observedNewGenRowIndices.add(rowIdx);
    }

    const stepMatched = this.matchTurnByStepIndices(ledger, stepIndices, turn);
    if (stepMatched) {
      return {
        kind: 'known',
        model: stepMatched.model,
        startedAt: stepMatched.startedAt,
        turnSeq: stepMatched.turnSeq,
      };
    }

    const existedBeforeCurrentTurn = turn === null || existedInPreSnap;
    const candidateTurns: TurnUsageRecord[] = [];
    for (const rec of ledger.turns.values()) {
      if (existedBeforeCurrentTurn && turn && rec.turnSeq === turn.turnSeq) {
        continue;
      }
      if (!rec.hadGenerationOpportunity || rec.procExitedAfterScan) {
        continue;
      }
      candidateTurns.push(rec);
    }

    if (!ledger.hadUncertainTurnBoundary && candidateTurns.length === 1) {
      const sole = candidateTurns[0];
      return {
        kind: 'known',
        model: sole.model,
        startedAt: sole.startedAt,
        turnSeq: sole.turnSeq,
      };
    }

    return {
      kind: 'unknown',
      candidateTurnSeqs: candidateTurns.map((c) => c.turnSeq),
    };
  }

  private addRowTurnMatch(
    row: FinalizedUsageRow,
    turnSeq: number,
    dim: TokenDim,
    delta: number,
  ): void {
    if (delta === 0) return;
    let triple = row.matchedByTurn.get(turnSeq);
    if (!triple) {
      triple = { input: 0, output: 0, cacheRead: 0 };
      row.matchedByTurn.set(turnSeq, triple);
    }
    triple[dim] += delta;
    if (triple.input === 0 && triple.output === 0 && triple.cacheRead === 0) {
      row.matchedByTurn.delete(turnSeq);
    }
  }

  private augmentCreditFromTurn(
    ledger: ConversationUsageLedger,
    fromTurnSeq: number,
    dim: TokenDim,
    limit: number,
    preferSettledOnly: boolean,
    visitedTurns: Set<number>,
    visitedRows: Set<number>,
  ): number {
    if (limit <= 0) return 0;
    const fromRec = ledger.turns.get(fromTurnSeq);
    if (!fromRec) return 0;

    for (const r of ledger.finalizedRows) {
      if (r.owner.kind !== 'unknown' || visitedRows.has(r.rowIdx)) continue;
      const curMatched = r.matchedByTurn.get(fromTurnSeq)?.[dim] ?? 0;
      if (curMatched <= 0) continue;

      visitedRows.add(r.rowIdx);
      const stepCap = Math.min(limit, curMatched);
      const candidatesDesc = [...r.owner.candidateTurnSeqs].reverse();

      for (const altTurnSeq of candidatesDesc) {
        if (altTurnSeq === fromTurnSeq || visitedTurns.has(altTurnSeq)) continue;
        const altRec = ledger.turns.get(altTurnSeq);
        if (!altRec) continue;
        if (preferSettledOnly && altRec.unfinishedKnownRows.size > 0) continue;
        if (altRec.fallbackCredit[dim] > 0) {
          const delta = Math.min(stepCap, altRec.fallbackCredit[dim]);
          this.addRowTurnMatch(r, fromTurnSeq, dim, -delta);
          this.addRowTurnMatch(r, altTurnSeq, dim, delta);
          altRec.fallbackCredit[dim] -= delta;
          fromRec.fallbackCredit[dim] += delta;
          return delta;
        }
      }

      for (const altTurnSeq of candidatesDesc) {
        if (altTurnSeq === fromTurnSeq || visitedTurns.has(altTurnSeq)) continue;
        const altRec = ledger.turns.get(altTurnSeq);
        if (!altRec) continue;
        visitedTurns.add(altTurnSeq);
        const delta = this.augmentCreditFromTurn(
          ledger,
          altTurnSeq,
          dim,
          stepCap,
          preferSettledOnly,
          visitedTurns,
          visitedRows,
        );
        if (delta > 0) {
          this.addRowTurnMatch(r, fromTurnSeq, dim, -delta);
          this.addRowTurnMatch(r, altTurnSeq, dim, delta);
          altRec.fallbackCredit[dim] -= delta;
          fromRec.fallbackCredit[dim] += delta;
          return delta;
        }
      }
    }

    return 0;
  }

  private matchFinalizedRowAgainstFallbackSupply(
    conversationId: string,
    ledger: ConversationUsageLedger,
    finalizedRow: FinalizedUsageRow,
  ): void {
    const displacedByRow = new Map<FinalizedUsageRow, TokenCounterTriple>();
    const owner = finalizedRow.owner;

    if (owner.kind === 'known') {
      const ownerRec = ledger.turns.get(owner.turnSeq);
      if (ownerRec) {
        ownerRec.reconciledKnownSqlTokens.input = saturatingSafeAdd(
          ownerRec.reconciledKnownSqlTokens.input,
          finalizedRow.raw.input,
        );
        ownerRec.reconciledKnownSqlTokens.output = saturatingSafeAdd(
          ownerRec.reconciledKnownSqlTokens.output,
          finalizedRow.raw.output,
        );
        ownerRec.reconciledKnownSqlTokens.cacheRead = saturatingSafeAdd(
          ownerRec.reconciledKnownSqlTokens.cacheRead,
          finalizedRow.raw.cacheRead,
        );
      }

      for (const dim of TOKEN_DIMS) {
        let need = finalizedRow.raw[dim];
        if (ownerRec && need > 0) {
          const direct = Math.min(need, ownerRec.fallbackCredit[dim]);
          if (direct > 0) {
            ownerRec.fallbackCredit[dim] -= direct;
            this.addRowTurnMatch(finalizedRow, owner.turnSeq, dim, direct);
            need -= direct;
          }

          for (const preferSettledOnly of [true, false]) {
            while (need > 0) {
              const freed = this.augmentCreditFromTurn(
                ledger,
                owner.turnSeq,
                dim,
                need,
                preferSettledOnly,
                new Set<number>([owner.turnSeq]),
                new Set<number>(),
              );
              if (freed <= 0) break;
              const take = Math.min(need, ownerRec.fallbackCredit[dim]);
              ownerRec.fallbackCredit[dim] -= take;
              this.addRowTurnMatch(finalizedRow, owner.turnSeq, dim, take);
              need -= take;
            }
          }

          // If no alternate candidate turn has free supply, a proven `known(turn)` row
          // preempts its own turn's credit from any `unknown` row that provisionally borrowed
          // it, displacing the unmatched tokens onto that `unknown` row's billing record.
          if (need > 0) {
            for (const other of ledger.finalizedRows) {
              if (other.owner.kind !== 'unknown') continue;
              const borrowed = other.matchedByTurn.get(owner.turnSeq)?.[dim] ?? 0;
              if (borrowed <= 0) continue;
              const reclaim = Math.min(need, borrowed);
              this.addRowTurnMatch(other, owner.turnSeq, dim, -reclaim);
              other.emittedNet[dim] = saturatingSafeAdd(other.emittedNet[dim], reclaim);
              let disp = displacedByRow.get(other);
              if (!disp) {
                disp = { input: 0, output: 0, cacheRead: 0 };
                displacedByRow.set(other, disp);
              }
              disp[dim] = saturatingSafeAdd(disp[dim], reclaim);
              this.addRowTurnMatch(finalizedRow, owner.turnSeq, dim, reclaim);
              need -= reclaim;
              if (need <= 0) break;
            }
          }
        }
        finalizedRow.emittedNet[dim] = need;
      }
    } else {
      const candidatesDesc = [...owner.candidateTurnSeqs].reverse();
      for (const dim of TOKEN_DIMS) {
        let need = finalizedRow.raw[dim];
        for (const preferSettledOnly of [true, false]) {
          if (need <= 0) break;
          for (const candSeq of candidatesDesc) {
            if (need <= 0) break;
            const candRec = ledger.turns.get(candSeq);
            if (!candRec) continue;
            if (preferSettledOnly && candRec.unfinishedKnownRows.size > 0) continue;

            const direct = Math.min(need, candRec.fallbackCredit[dim]);
            if (direct > 0) {
              candRec.fallbackCredit[dim] -= direct;
              this.addRowTurnMatch(finalizedRow, candSeq, dim, direct);
              need -= direct;
            }

            while (need > 0) {
              const freed = this.augmentCreditFromTurn(
                ledger,
                candSeq,
                dim,
                need,
                preferSettledOnly,
                new Set<number>([candSeq]),
                new Set<number>(),
              );
              if (freed <= 0) break;
              const take = Math.min(need, candRec.fallbackCredit[dim]);
              candRec.fallbackCredit[dim] -= take;
              this.addRowTurnMatch(finalizedRow, candSeq, dim, take);
              need -= take;
            }
          }
        }
        finalizedRow.emittedNet[dim] = need;
      }
    }

    ledger.finalizedRows.push(finalizedRow);

    for (const [displacedRow, disp] of displacedByRow.entries()) {
      const dispTotal = safeAddNonNegInt(disp.input, disp.output);
      const dispWork = dispTotal !== null ? safeAddNonNegInt(dispTotal, disp.cacheRead) : null;
      if (dispTotal === null || dispWork === null || dispWork <= 0) continue;
      displacedRow.reconcileEmitSeq += 1;
      this.emitBillingStep(ledger, {
        type: 'token-count',
        engine: 'agy',
        scope: 'step',
        usageKey: `${conversationId}:sql:${displacedRow.rowIdx}:reconcile-${displacedRow.reconcileEmitSeq}`,
        usage: {
          input_tokens: disp.input,
          output_tokens: disp.output,
          cache_read_tokens: disp.cacheRead,
          total_tokens: dispTotal,
        },
        contextUsage: null,
        usageModel: displacedRow.usageModel,
        usageStartedAt: displacedRow.usageStartedAt,
      });
    }
  }

  private emitBillingStep(
    ledger: ConversationUsageLedger,
    msg: Extract<AgentMessage, { type: 'token-count' }> & {
      scope: 'step';
      usageKey: string;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        total_tokens: number;
      };
      usageModel: string | null;
      usageStartedAt?: number;
    },
  ): void {
    if (this.confirmUsageDurable) {
      ledger.pendingDurableEmissions.set(msg.usageKey, {
        usageKey: msg.usageKey,
        usage: { ...msg.usage },
        usageModel: msg.usageModel,
        usageStartedAt: msg.usageStartedAt,
      });
    }
    this.emittedInCurrentProcess.add(msg.usageKey);
    this.emit(msg);
  }

  private replayUnemittedPendingEmissions(ledger: ConversationUsageLedger): void {
    for (const pending of ledger.pendingDurableEmissions.values()) {
      if (this.emittedInCurrentProcess.has(pending.usageKey)) continue;
      this.emittedInCurrentProcess.add(pending.usageKey);
      this.emit({
        type: 'token-count',
        engine: 'agy',
        scope: 'step',
        usageKey: pending.usageKey,
        usage: { ...pending.usage },
        contextUsage: null,
        usageModel: pending.usageModel,
        usageStartedAt: pending.usageStartedAt,
      });
    }
  }

  private async confirmPendingDurableEmissions(
    ledger: ConversationUsageLedger,
  ): Promise<boolean> {
    if (!this.confirmUsageDurable || ledger.pendingDurableEmissions.size === 0) {
      return true;
    }
    try {
      await this.confirmUsageDurable();
      for (const key of [...ledger.pendingDurableEmissions.keys()]) {
        if (this.emittedInCurrentProcess.has(key)) {
          ledger.pendingDurableEmissions.delete(key);
        }
      }
      return ledger.pendingDurableEmissions.size === 0;
    } catch {
      return false;
    }
  }

  private syncSqlStepUsage(
    conversationId: string,
    turn: ActiveTurnState | null,
    opts?: { deferCurrentTurnUnknownRows?: boolean },
  ): boolean {
    const ledger = this.getOrCreateLedger(conversationId);
    if (ledger.corruptHandoffError !== null) {
      return false;
    }
    if (!ledger.seeded && !this.trySeedExistingConversation(conversationId)) {
      return false;
    }

    const scan = readAgyConversationGenMetadataSince(conversationId, ledger.baselineMaxGenIdx, {
      agyHomeDir: this.agyHomeDir,
    });
    if (!scan.readOk) {
      return false;
    }
    for (const present of scan.presentRows) {
      if (present.idx <= ledger.baselineMaxGenIdx || ledger.emittedRowIndices.has(present.idx)) {
        continue;
      }
      const existing = ledger.rowOwners.get(present.idx);
      if (!existing) {
        this.recordRowOwner(
          ledger,
          present.idx,
          this.assignInitialRowOwner(ledger, present.idx, present.stepIndices, turn),
        );
      } else if (existing.kind === 'unknown' && present.stepIndices) {
        const matched = this.matchTurnByStepIndices(ledger, present.stepIndices, turn);
        if (matched && existing.candidateTurnSeqs.includes(matched.turnSeq)) {
          this.recordRowOwner(ledger, present.idx, {
            kind: 'known',
            model: matched.model,
            startedAt: matched.startedAt,
            turnSeq: matched.turnSeq,
          });
        }
      }
    }
    if (scan.rows.length === 0) {
      return true;
    }

    const deferCurrentUnknown = Boolean(opts?.deferCurrentTurnUnknownRows && turn !== null);

    for (const row of scan.rows) {
      if (row.idx <= ledger.baselineMaxGenIdx || ledger.emittedRowIndices.has(row.idx)) {
        continue;
      }
      if (!ledger.rowOwners.has(row.idx)) {
        this.recordRowOwner(
          ledger,
          row.idx,
          this.assignInitialRowOwner(ledger, row.idx, row.summary.stepIndices, turn),
        );
      } else {
        const curOwner = ledger.rowOwners.get(row.idx)!;
        if (curOwner.kind === 'unknown' && row.summary.stepIndices) {
          const matched = this.matchTurnByStepIndices(ledger, row.summary.stepIndices, turn);
          if (matched && curOwner.candidateTurnSeqs.includes(matched.turnSeq)) {
            this.recordRowOwner(ledger, row.idx, {
              kind: 'known',
              model: matched.model,
              startedAt: matched.startedAt,
              turnSeq: matched.turnSeq,
            });
          }
        }
      }
      const u = row.summary.usage;
      // Do not mark in-flight `chat_start_metadata` rows (`!u`) as emitted yet;
      // wait until native `agy` populates `ModelUsageStats` on that `idx`, while
      // retaining its `rowOwners` record across arbitrarily many subsequent turns.
      if (!u) continue;

      const pendingOwner = ledger.rowOwners.get(row.idx) ?? { kind: 'unknown', candidateTurnSeqs: [] };
      // While the current turn has not yet registered its `promptResult.usage` fallback supply,
      // defer finalizing `unknown` rows whose candidate set includes the current turn so they
      // neither steal an earlier turn's fallback credit prematurely nor pollute `turn.sqlTokens`.
      if (
        deferCurrentUnknown &&
        turn &&
        pendingOwner.kind === 'unknown' &&
        pendingOwner.candidateTurnSeqs.includes(turn.turnSeq)
      ) {
        continue;
      }

      const rawIn = toSafeNonNegInt(u.inputTokens);
      const rawOut = toSafeNonNegInt(u.outputTokens);
      const rawCache = toSafeNonNegInt(u.cacheReadTokens);
      if (rawIn === null || rawOut === null || rawCache === null) {
        this.clearRowOwnerOnFinalize(ledger, row.idx);
        continue;
      }
      const rawTotal = safeAddNonNegInt(rawIn, rawOut);
      const rawWork = rawTotal !== null ? safeAddNonNegInt(rawTotal, rawCache) : null;
      if (rawTotal === null || rawWork === null || rawWork <= 0) {
        this.clearRowOwnerOnFinalize(ledger, row.idx);
        continue;
      }

      const owner = pendingOwner;
      this.clearRowOwnerOnFinalize(ledger, row.idx);

      const isCurrentTurnOwner = Boolean(
        turn && owner.kind === 'known' && owner.turnSeq === turn.turnSeq,
      );
      const isActiveAutonomousTurnOwner = Boolean(
        !turn &&
          this.autonomousTurnActive &&
          this.autonomousTurnSeq !== null &&
          owner.kind === 'known' &&
          owner.turnSeq === this.autonomousTurnSeq,
      );
      const belongsToLiveTurn = isCurrentTurnOwner || isActiveAutonomousTurnOwner;
      const fallbackModel = owner.kind === 'known' ? owner.model : null;
      const stepUsageModel = row.summary.normalizedModelId ?? fallbackModel;
      const stepUsageStartedAt = owner.kind === 'known' ? owner.startedAt : undefined;

      // Subtract ONLY proven `known(currentTurn)` SQLite rows from the current turn's
      // `promptResult.usage` fallback residual; `unknown` rows match against the turn's
      // fallback supply immediately after `reconcileTurnEndUsage`.
      if (turn && isCurrentTurnOwner) {
        turn.sqlTokens.input = saturatingSafeAdd(turn.sqlTokens.input, rawIn);
        turn.sqlTokens.output = saturatingSafeAdd(turn.sqlTokens.output, rawOut);
        turn.sqlTokens.cacheRead = saturatingSafeAdd(turn.sqlTokens.cacheRead, rawCache);
      }

      const finalizedRow: FinalizedUsageRow = {
        rowIdx: row.idx,
        owner,
        raw: { input: rawIn, output: rawOut, cacheRead: rawCache },
        matchedByTurn: new Map<number, TokenCounterTriple>(),
        emittedNet: { input: 0, output: 0, cacheRead: 0 },
        usageModel: stepUsageModel,
        usageStartedAt: stepUsageStartedAt,
        reconcileEmitSeq: 0,
      };
      this.matchFinalizedRowAgainstFallbackSupply(conversationId, ledger, finalizedRow);

      const netIn = finalizedRow.emittedNet.input;
      const netOut = finalizedRow.emittedNet.output;
      const netCache = finalizedRow.emittedNet.cacheRead;

      const rawStepUsage = {
        input_tokens: rawIn,
        output_tokens: rawOut,
        cache_read_tokens: rawCache,
        total_tokens: rawTotal,
      };

      const netTotal = safeAddNonNegInt(netIn, netOut);
      const netWork = netTotal !== null ? safeAddNonNegInt(netTotal, netCache) : null;
      if (netTotal === null || netWork === null || netWork <= 0) {
        // Billing tokens were fully absorbed by prior fallback credit, but still emit
        // native single-step context fill with this generation's own identity & window.
        this.emit({
          type: 'token-count',
          engine: 'agy',
          scope: 'context',
          conversationId,
          genIdx: row.idx,
          contextWindowTokens: row.summary.maxContextTokens,
          belongsToCurrentTurn: belongsToLiveTurn,
          usage: rawStepUsage,
          usageModel: stepUsageModel,
        });
        continue;
      }

      if (turn && isCurrentTurnOwner) {
        turn.emittedStepCount += 1;
      }
      this.emitBillingStep(ledger, {
        type: 'token-count',
        engine: 'agy',
        scope: 'step',
        usageKey: `${conversationId}:sql:${row.idx}`,
        genIdx: row.idx,
        contextWindowTokens: row.summary.maxContextTokens,
        belongsToCurrentTurn: belongsToLiveTurn,
        usage: {
          input_tokens: netIn,
          output_tokens: netOut,
          cache_read_tokens: netCache,
          total_tokens: netTotal,
        },
        contextUsage: rawStepUsage,
        usageModel: stepUsageModel,
        usageStartedAt: stepUsageStartedAt,
      });
    }

    return true;
  }

  private reconcileTurnEndUsage(
    conversationId: string,
    turn: ActiveTurnState,
    rawPromptUsage: unknown,
  ): void {
    const turnUsage = parseAcpPromptTurnUsage(rawPromptUsage);
    if (!turnUsage) return;

    const remIn = Math.max(0, turnUsage.input - turn.sqlTokens.input);
    const remOut = Math.max(0, turnUsage.output - turn.sqlTokens.output);
    const remCache = Math.max(0, turnUsage.cacheRead - turn.sqlTokens.cacheRead);

    const remTotal = safeAddNonNegInt(remIn, remOut);
    const remWork = remTotal !== null ? safeAddNonNegInt(remTotal, remCache) : null;
    if (remTotal === null || remWork === null || remWork <= 0) {
      return;
    }

    const ledger = this.getOrCreateLedger(conversationId);
    const rec = ledger.turns.get(turn.turnSeq);
    if (rec) {
      rec.fallbackCredit.input = saturatingSafeAdd(rec.fallbackCredit.input, remIn);
      rec.fallbackCredit.output = saturatingSafeAdd(rec.fallbackCredit.output, remOut);
      rec.fallbackCredit.cacheRead = saturatingSafeAdd(rec.fallbackCredit.cacheRead, remCache);
    }

    const instId = rec?.turnInstanceId ?? this.sessionInstanceId;
    turn.emittedStepCount += 1;
    this.emitBillingStep(ledger, {
      type: 'token-count',
      engine: 'agy',
      scope: 'step',
      usageKey: `${conversationId}:acp:${instId}:turn-${turn.turnSeq}:residual`,
      usage: {
        input_tokens: remIn,
        output_tokens: remOut,
        cache_read_tokens: remCache,
        total_tokens: remTotal,
      },
      contextUsage: null,
      usageModel: turn.effectiveModel ?? turn.requestedModel ?? null,
      usageStartedAt: turn.turnStartedAt,
    });
  }

  private handleBrokenStdin(proc: AcpProcessHandle, err: Error | null): AcpProcessClosedError {
    const wasIntentional = proc.closingIntentionally;
    const stderrError = extractAgyStderrError(this.turnStderrBuf || proc.startupStderrBuf);
    const closedErr = new AcpProcessClosedError(
      proc.exitCode,
      proc.exitSignal,
      stderrError ?? err?.message ?? null,
      wasIntentional,
    );
    proc.dead = true;
    if (this.proc === proc) {
      this.proc = null;
      this.resetSessionState();
    }
    this.rejectProcPendingRpcs(proc, closedErr);
    void this.retireProcessHandle(proc, null);
    return closedErr;
  }

  private sendRpc(
    proc: AcpProcessHandle,
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
    expectObjectResult = true,
    onWriteFlushed?: () => void,
  ): Promise<any> {
    if (this.proc !== proc || proc.dead || proc.exited || !proc.child.stdin?.writable) {
      if (proc.fatalSpawnError) {
        return Promise.reject(proc.fatalSpawnError);
      }
      if (!proc.exited && !proc.child.stdin?.writable) {
        return Promise.reject(this.handleBrokenStdin(proc, null));
      }
      return Promise.reject(
        new AcpProcessClosedError(
          proc.exitCode,
          proc.exitSignal,
          extractAgyStderrError(this.turnStderrBuf || proc.startupStderrBuf),
          proc.closingIntentionally,
        ),
      );
    }

    const id = this.nextRpcId++;
    return new Promise((resolve, reject) => {
      const timer =
        typeof timeoutMs === 'number' && timeoutMs > 0
          ? setTimeout(() => {
              proc.pendingRpcs.delete(id);
              const err = new Error(`Antigravity ACP ${method} timed out after ${timeoutMs}ms`);
              this.abortProtocolOnProcess(proc, err);
              reject(err);
            }, timeoutMs)
          : null;

      proc.pendingRpcs.set(id, { method, expectObjectResult, resolve, reject, timer });

      try {
        proc.child.stdin!.write(
          JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
          (writeErr) => {
            if (writeErr) {
              this.handleBrokenStdin(proc, writeErr);
              return;
            }
            onWriteFlushed?.();
          },
        );
      } catch (err) {
        const writeEx = err instanceof Error ? err : new Error(String(err));
        this.handleBrokenStdin(proc, writeEx);
      }
    });
  }

  private writeJsonRpc(proc: AcpProcessHandle, payload: Record<string, unknown>): void {
    if (proc.dead || proc.exited || !proc.child.stdin?.writable) return;
    try {
      proc.child.stdin.write(JSON.stringify(payload) + '\n', (writeErr) => {
        if (writeErr) {
          this.handleBrokenStdin(proc, writeErr);
        }
      });
    } catch (err) {
      this.handleBrokenStdin(proc, err instanceof Error ? err : new Error(String(err)));
    }
  }

  private rejectProcPendingRpcs(proc: AcpProcessHandle, err: Error): void {
    const entries = [...proc.pendingRpcs.values()];
    proc.pendingRpcs.clear();
    for (const pending of entries) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.reject(err);
    }
  }

  private armLongTimeout(onExpire: () => void, totalMs: number): () => void {
    const maxSlice = 2_147_483_647;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (remaining: number) => {
      if (cancelled) return;
      if (remaining <= maxSlice) {
        timer = setTimeout(() => {
          timer = null;
          if (!cancelled) onExpire();
        }, Math.max(0, remaining));
      } else {
        timer = setTimeout(() => {
          timer = null;
          schedule(remaining - maxSlice);
        }, maxSlice);
      }
    };
    schedule(totalMs);
    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }
}
