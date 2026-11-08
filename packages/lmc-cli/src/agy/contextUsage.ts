import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createEnvelope, type SessionEnvelope, type SessionUsage } from 'lmc-wire';
import { resolveDefaultAgyHomeDir } from './conversationRepair';

const requireFromHere = createRequire(import.meta.url);

const VALID_CONVERSATION_ID = /^[a-zA-Z0-9_-]{1,200}$/;

export interface AgyStepTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface AgyGenMetadataSummary {
  usage?: AgyStepTokenUsage;
  estimatedTokensUsed?: number;
  maxContextTokens?: number;
  responseModel?: string;
  modelDisplayName?: string;
  normalizedModelId?: string;
  stepIndices?: number[];
}

export interface AgyPresentGenRow {
  idx: number;
  stepIndices?: number[];
}

export interface AgyGenMetadataRow {
  idx: number;
  summary: AgyGenMetadataSummary;
}

/**
 * Canonicalize an Antigravity model display name or CLI model ID so punctuation
 * differences across model families (e.g. "Claude Opus 5.5 (Low)" vs "claude-opus-5-5-low",
 * "Gemini 3.8 Flash (Low)" vs "gemini-3.8-flash-low") compare identically.
 */
export function normalizeAgyDisplayModelId(displayName: string | null | undefined): string | undefined {
  if (typeof displayName !== 'string') return undefined;
  const normalized = displayName
    .trim()
    .toLowerCase()
    .replace(/[()]/g, '')
    .trim()
    .replace(/[\s._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized : undefined;
}

function readVarintBigInt(buf: Uint8Array, startPos: number, endPos: number): { value: bigint; nextPos: number } | null {
  let value = 0n;
  let shift = 0n;
  let pos = startPos;
  while (pos < endPos) {
    if (shift > 63n) return null;
    const byte = buf[pos++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, nextPos: pos };
    }
    shift += 7n;
  }
  return null;
}

function toNonNegativeSafeInt(value: bigint): number | undefined {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(value);
}

function toPositiveSafeInt(value: bigint): number | undefined {
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(value);
}

function parseModelUsageStats(buf: Uint8Array, start: number, end: number): AgyStepTokenUsage | undefined | null {
  let pos = start;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens: number | undefined;

  while (pos < end) {
    const tag = readVarintBigInt(buf, pos, end);
    if (!tag) return null;
    pos = tag.nextPos;
    const fieldNo = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (fieldNo <= 0) return null;

    if (wireType === 0) {
      const v = readVarintBigInt(buf, pos, end);
      if (!v) return null;
      pos = v.nextPos;
      if (fieldNo === 2 || fieldNo === 3 || fieldNo === 5) {
        const safeVal = toNonNegativeSafeInt(v.value);
        if (safeVal === undefined) return null;
        if (fieldNo === 2) inputTokens = safeVal;
        else if (fieldNo === 3) outputTokens = safeVal;
        else cacheReadTokens = safeVal;
      }
    } else if (fieldNo === 2 || fieldNo === 3 || fieldNo === 5) {
      return null;
    } else if (wireType === 2) {
      const len = readVarintBigInt(buf, pos, end);
      if (!len) return null;
      const byteLen = toNonNegativeSafeInt(len.value);
      if (byteLen === undefined || len.nextPos + byteLen > end) return null;
      pos = len.nextPos + byteLen;
    } else if (wireType === 1) {
      if (pos + 8 > end) return null;
      pos += 8;
    } else if (wireType === 5) {
      if (pos + 4 > end) return null;
      pos += 4;
    } else {
      return null;
    }
  }

  if (inputTokens === undefined && outputTokens === undefined && cacheReadTokens === undefined) {
    return undefined;
  }
  const inTok = inputTokens ?? 0;
  const outTok = outputTokens ?? 0;
  const cacheTok = cacheReadTokens ?? 0;
  const nativeTotal = inTok + outTok;
  const allWork = nativeTotal + cacheTok;
  if (!Number.isSafeInteger(nativeTotal) || !Number.isSafeInteger(allWork)) {
    return null;
  }
  if (allWork <= 0) {
    return undefined;
  }
  return {
    inputTokens: inTok,
    outputTokens: outTok,
    cacheReadTokens: cacheTok,
  };
}

function parseContextWindowMetadata(
  buf: Uint8Array,
  start: number,
  end: number,
): { estimatedTokensUsed?: number; maxContextTokens?: number } | null {
  let pos = start;
  let estimatedTokensUsed: number | undefined;
  let maxContextTokens: number | undefined;

  while (pos < end) {
    const tag = readVarintBigInt(buf, pos, end);
    if (!tag) return null;
    pos = tag.nextPos;
    const fieldNo = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (fieldNo <= 0) return null;

    if (wireType === 0) {
      const v = readVarintBigInt(buf, pos, end);
      if (!v) return null;
      pos = v.nextPos;
      if (fieldNo === 1 || fieldNo === 4) {
        if (v.value < 0n || v.value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        const positive = toPositiveSafeInt(v.value);
        if (fieldNo === 1) estimatedTokensUsed = positive;
        else maxContextTokens = positive;
      }
    } else if (fieldNo === 1 || fieldNo === 4) {
      return null;
    } else if (wireType === 2) {
      const len = readVarintBigInt(buf, pos, end);
      if (!len) return null;
      const byteLen = toNonNegativeSafeInt(len.value);
      if (byteLen === undefined || len.nextPos + byteLen > end) return null;
      pos = len.nextPos + byteLen;
    } else if (wireType === 1) {
      if (pos + 8 > end) return null;
      pos += 8;
    } else if (wireType === 5) {
      if (pos + 4 > end) return null;
      pos += 4;
    } else {
      return null;
    }
  }

  return { estimatedTokensUsed, maxContextTokens };
}

function parseChatStartMetadata(
  buf: Uint8Array,
  start: number,
  end: number,
): { estimatedTokensUsed?: number; maxContextTokens?: number } | null {
  let pos = start;
  let result: { estimatedTokensUsed?: number; maxContextTokens?: number } = {};
  while (pos < end) {
    const tag = readVarintBigInt(buf, pos, end);
    if (!tag) return null;
    pos = tag.nextPos;
    const fieldNo = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (fieldNo <= 0) return null;

    if (wireType === 2) {
      const len = readVarintBigInt(buf, pos, end);
      if (!len) return null;
      const byteLen = toNonNegativeSafeInt(len.value);
      if (byteLen === undefined || len.nextPos + byteLen > end) return null;
      const subStart = len.nextPos;
      const subEnd = subStart + byteLen;
      pos = subEnd;
      if (fieldNo === 10) {
        const cw = parseContextWindowMetadata(buf, subStart, subEnd);
        if (cw === null) return null;
        result = cw;
      }
    } else if (fieldNo === 10) {
      return null;
    } else if (wireType === 0) {
      const v = readVarintBigInt(buf, pos, end);
      if (!v) return null;
      pos = v.nextPos;
    } else if (wireType === 1) {
      if (pos + 8 > end) return null;
      pos += 8;
    } else if (wireType === 5) {
      if (pos + 4 > end) return null;
      pos += 4;
    } else {
      return null;
    }
  }
  return result;
}

function parseChatModelMetadata(buf: Uint8Array, start: number, end: number): AgyGenMetadataSummary | null {
  let pos = start;
  const summary: AgyGenMetadataSummary = {};

  while (pos < end) {
    const tag = readVarintBigInt(buf, pos, end);
    if (!tag) return null;
    pos = tag.nextPos;
    const fieldNo = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (fieldNo <= 0) return null;

    if (wireType === 2) {
      const len = readVarintBigInt(buf, pos, end);
      if (!len) return null;
      const byteLen = toNonNegativeSafeInt(len.value);
      if (byteLen === undefined || len.nextPos + byteLen > end) return null;
      const subStart = len.nextPos;
      const subEnd = subStart + byteLen;
      pos = subEnd;

      // Skip large system_prompt (f1) and message_prompts (f2) in O(1) without copying.
      if (fieldNo === 4) {
        const usage = parseModelUsageStats(buf, subStart, subEnd);
        if (usage === null) return null;
        if (usage !== undefined) summary.usage = usage;
      } else if (fieldNo === 9) {
        const cw = parseChatStartMetadata(buf, subStart, subEnd);
        if (cw === null) return null;
        if (cw.estimatedTokensUsed !== undefined) summary.estimatedTokensUsed = cw.estimatedTokensUsed;
        if (cw.maxContextTokens !== undefined) summary.maxContextTokens = cw.maxContextTokens;
      } else if (fieldNo === 19 && byteLen <= 256) {
        const str = Buffer.from(buf.buffer, buf.byteOffset + subStart, byteLen).toString('utf8').trim();
        if (str) summary.responseModel = str;
      } else if (fieldNo === 21 && byteLen <= 256) {
        const str = Buffer.from(buf.buffer, buf.byteOffset + subStart, byteLen).toString('utf8').trim();
        if (str) {
          summary.modelDisplayName = str;
          summary.normalizedModelId = normalizeAgyDisplayModelId(str);
        }
      }
    } else if (fieldNo === 4 || fieldNo === 9 || fieldNo === 19 || fieldNo === 21) {
      return null;
    } else if (wireType === 0) {
      const v = readVarintBigInt(buf, pos, end);
      if (!v) return null;
      pos = v.nextPos;
    } else if (wireType === 1) {
      if (pos + 8 > end) return null;
      pos += 8;
    } else if (wireType === 5) {
      if (pos + 4 > end) return null;
      pos += 4;
    } else {
      return null;
    }
  }

  return summary;
}

/**
 * Parse root `field 2` (`repeated uint32 step_indices`, packed or unpacked) from
 * `CortexStepGeneratorMetadata` (`gen_metadata.data`) without requiring `ChatModelMetadata`
 * to be finished yet.
 */
export function parseAgyGenStepIndices(data: Uint8Array | null | undefined): number[] | undefined {
  if (!data || data.byteLength === 0) return undefined;
  let pos = 0;
  const end = data.byteLength;
  const stepIndices: number[] = [];

  while (pos < end) {
    const tag = readVarintBigInt(data, pos, end);
    if (!tag) return undefined;
    pos = tag.nextPos;
    const fieldNo = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (fieldNo <= 0) return undefined;

    if (wireType === 2) {
      const len = readVarintBigInt(data, pos, end);
      if (!len) return undefined;
      const byteLen = toNonNegativeSafeInt(len.value);
      if (byteLen === undefined || len.nextPos + byteLen > end) return undefined;
      const subStart = len.nextPos;
      const subEnd = subStart + byteLen;
      pos = subEnd;
      if (fieldNo === 2) {
        let p = subStart;
        while (p < subEnd) {
          const sv = readVarintBigInt(data, p, subEnd);
          if (!sv) return undefined;
          const idxVal = toNonNegativeSafeInt(sv.value);
          if (idxVal === undefined) return undefined;
          stepIndices.push(idxVal);
          p = sv.nextPos;
        }
      }
    } else if (wireType === 0) {
      const v = readVarintBigInt(data, pos, end);
      if (!v) return undefined;
      pos = v.nextPos;
      if (fieldNo === 2) {
        const idxVal = toNonNegativeSafeInt(v.value);
        if (idxVal === undefined) return undefined;
        stepIndices.push(idxVal);
      }
    } else if (fieldNo === 2) {
      return undefined;
    } else if (wireType === 1) {
      if (pos + 8 > end) return undefined;
      pos += 8;
    } else if (wireType === 5) {
      if (pos + 4 > end) return undefined;
      pos += 4;
    } else {
      return undefined;
    }
  }

  return stepIndices.length > 0 ? stepIndices : undefined;
}

/**
 * Parse a `gen_metadata.data` protobuf blob (`CortexStepGeneratorMetadata`) from
 * `~/.gemini/antigravity-cli/conversations/<conversationId>.db`.
 */
export function parseAgyGenMetadataRow(data: Uint8Array): AgyGenMetadataSummary | null {
  if (!data || data.byteLength === 0) return null;
  let pos = 0;
  const end = data.byteLength;
  let chatModelSummary: AgyGenMetadataSummary | null = null;
  const stepIndices: number[] = [];

  while (pos < end) {
    const tag = readVarintBigInt(data, pos, end);
    if (!tag) return null;
    pos = tag.nextPos;
    const fieldNo = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (fieldNo <= 0) return null;

    if (wireType === 2) {
      const len = readVarintBigInt(data, pos, end);
      if (!len) return null;
      const byteLen = toNonNegativeSafeInt(len.value);
      if (byteLen === undefined || len.nextPos + byteLen > end) return null;
      const subStart = len.nextPos;
      const subEnd = subStart + byteLen;
      pos = subEnd;
      if (fieldNo === 1) {
        const summary = parseChatModelMetadata(data, subStart, subEnd);
        if (summary === null) return null;
        chatModelSummary = summary;
      } else if (fieldNo === 2) {
        let p = subStart;
        while (p < subEnd) {
          const sv = readVarintBigInt(data, p, subEnd);
          if (!sv) return null;
          const idxVal = toNonNegativeSafeInt(sv.value);
          if (idxVal === undefined) return null;
          stepIndices.push(idxVal);
          p = sv.nextPos;
        }
      }
    } else if (fieldNo === 1) {
      return null;
    } else if (wireType === 0) {
      const v = readVarintBigInt(data, pos, end);
      if (!v) return null;
      pos = v.nextPos;
      if (fieldNo === 2) {
        const idxVal = toNonNegativeSafeInt(v.value);
        if (idxVal === undefined) return null;
        stepIndices.push(idxVal);
      }
    } else if (fieldNo === 2) {
      return null;
    } else if (wireType === 1) {
      if (pos + 8 > end) return null;
      pos += 8;
    } else if (wireType === 5) {
      if (pos + 4 > end) return null;
      pos += 4;
    } else {
      return null;
    }
  }

  if (
    chatModelSummary &&
    (chatModelSummary.usage !== undefined ||
      chatModelSummary.maxContextTokens !== undefined ||
      chatModelSummary.estimatedTokensUsed !== undefined)
  ) {
    if (stepIndices.length > 0) {
      chatModelSummary.stepIndices = stepIndices;
    }
    return chatModelSummary;
  }

  if (stepIndices.length > 0) {
    return chatModelSummary ? { ...chatModelSummary, stepIndices } : { stepIndices };
  }

  return null;
}

export function normalizeAgyStepUsage(raw: unknown): AgyStepTokenUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const input = record.input_tokens;
  const output = record.output_tokens;
  const cacheRead = record.cache_read_tokens ?? 0;
  if (
    typeof input !== 'number' ||
    !Number.isSafeInteger(input) ||
    input < 0 ||
    typeof output !== 'number' ||
    !Number.isSafeInteger(output) ||
    output < 0 ||
    typeof cacheRead !== 'number' ||
    !Number.isSafeInteger(cacheRead) ||
    cacheRead < 0
  ) {
    return null;
  }
  const nativeTotal = input + output;
  const allWork = nativeTotal + cacheRead;
  if (!Number.isSafeInteger(nativeTotal) || !Number.isSafeInteger(allWork) || allWork <= 0) {
    return null;
  }
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
  };
}

export interface ReadAgyGenMetadataOptions {
  agyHomeDir?: string;
  limit?: number;
}

export interface AgyConversationStateSnapshot {
  dbExists: boolean;
  readOk: boolean;
  maxStepIdx: number;
  maxExecIdx: number;
  maxGenIdx: number;
}

function queryTableMaxIdx(roDb: any, tableName: string): number {
  const tableExists = roDb
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName);
  if (!tableExists) return -1;
  const row = roDb.prepare(`SELECT COALESCE(MAX(idx), -1) AS maxIdx FROM ${tableName}`).get() as
    | { maxIdx?: unknown }
    | undefined;
  return typeof row?.maxIdx === 'number' && Number.isSafeInteger(row.maxIdx) ? row.maxIdx : -1;
}

function probeSqliteFilePresence(dbPath: string): 'exists' | 'absent' | 'error' {
  try {
    statSync(dbPath);
    return 'exists';
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'absent' : 'error';
  }
}

export function readAgyConversationStateSnapshot(
  conversationId: string | null | undefined,
  opts: { agyHomeDir?: string } = {},
): AgyConversationStateSnapshot {
  if (typeof conversationId !== 'string' || !VALID_CONVERSATION_ID.test(conversationId)) {
    return { dbExists: false, readOk: true, maxStepIdx: -1, maxExecIdx: -1, maxGenIdx: -1 };
  }
  const agyHomeDir = opts.agyHomeDir ?? resolveDefaultAgyHomeDir();
  const dbPath = join(agyHomeDir, 'conversations', `${conversationId}.db`);
  const presence = probeSqliteFilePresence(dbPath);
  if (presence === 'absent') {
    return { dbExists: false, readOk: true, maxStepIdx: -1, maxExecIdx: -1, maxGenIdx: -1 };
  }
  if (presence === 'error') {
    return { dbExists: true, readOk: false, maxStepIdx: -1, maxExecIdx: -1, maxGenIdx: -1 };
  }

  let DatabaseSyncCtor: any;
  try {
    ({ DatabaseSync: DatabaseSyncCtor } = requireFromHere('node:sqlite'));
  } catch {
    return { dbExists: true, readOk: false, maxStepIdx: -1, maxExecIdx: -1, maxGenIdx: -1 };
  }

  try {
    const roDb = new DatabaseSyncCtor(dbPath, { readOnly: true });
    try {
      const maxStepIdx = queryTableMaxIdx(roDb, 'steps');
      const maxExecIdx = queryTableMaxIdx(roDb, 'executor_metadata');
      const maxGenIdx = queryTableMaxIdx(roDb, 'gen_metadata');
      return { dbExists: true, readOk: true, maxStepIdx, maxExecIdx, maxGenIdx };
    } finally {
      roDb.close();
    }
  } catch {
    return { dbExists: true, readOk: false, maxStepIdx: -1, maxExecIdx: -1, maxGenIdx: -1 };
  }
}

const AGY_STEP_TYPE_PLANNER_RESPONSE = 15;
const AGY_STEP_STATUS_DONE = 3;

export type AgyIdlePlannerStepCompletion =
  | { finalized: false }
  | { finalized: true; stepIdx: number; genIdx: number };

/**
 * Check whether the pending tool-less `PLANNER_RESPONSE` step (`step_type === 15`) has
 * genuinely finalized (`status === 3`, `DONE`) in SQLite `steps` AND `gen_metadata`
 * (`ModelUsageStats` populated, `stepIndices` ending at `latestStep.idx`).
 *
 * Used by persistent `agy acp --stdio` idle flush so network/decoding pauses mid-sentence
 * NEVER split a single streaming Markdown message into multiple chat bubbles, while a
 * completed tool-less response entering `WaitForConversationFullyIdle` still flushes
 * within `midTurnFlushMs`.
 */
export function checkAgyIdlePlannerStepFinalized(
  conversationId: string | null | undefined,
  afterStepIdx: number,
  afterGenIdx: number,
  opts: { agyHomeDir?: string } = {},
): AgyIdlePlannerStepCompletion {
  if (typeof conversationId !== 'string' || !VALID_CONVERSATION_ID.test(conversationId)) {
    return { finalized: false };
  }
  const agyHomeDir = opts.agyHomeDir ?? resolveDefaultAgyHomeDir();
  const dbPath = join(agyHomeDir, 'conversations', `${conversationId}.db`);
  if (probeSqliteFilePresence(dbPath) !== 'exists') {
    return { finalized: false };
  }

  let DatabaseSyncCtor: any;
  try {
    ({ DatabaseSync: DatabaseSyncCtor } = requireFromHere('node:sqlite'));
  } catch {
    return { finalized: false };
  }

  const safeAfterStep = Number.isSafeInteger(afterStepIdx) ? afterStepIdx : -1;
  const safeAfterGen = Number.isSafeInteger(afterGenIdx) ? afterGenIdx : -1;

  try {
    const roDb = new DatabaseSyncCtor(dbPath, { readOnly: true });
    try {
      const stepCols = roDb.prepare('PRAGMA table_info(steps)').all() as Array<{ name?: unknown }>;
      const hasStatusCol = stepCols.some((c) => c?.name === 'status');
      const hasStepTypeCol = stepCols.some((c) => c?.name === 'step_type');
      if (!hasStatusCol || !hasStepTypeCol) {
        return { finalized: false };
      }

      const latestStep = roDb
        .prepare('SELECT idx, step_type, status FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1')
        .get(safeAfterStep) as { idx?: unknown; step_type?: unknown; status?: unknown } | undefined;
      if (
        !latestStep ||
        typeof latestStep.idx !== 'number' ||
        !Number.isSafeInteger(latestStep.idx) ||
        latestStep.step_type !== AGY_STEP_TYPE_PLANNER_RESPONSE ||
        latestStep.status !== AGY_STEP_STATUS_DONE
      ) {
        return { finalized: false };
      }

      const hasGenTable = roDb
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gen_metadata' LIMIT 1")
        .get();
      if (!hasGenTable) {
        return { finalized: false };
      }

      const latestGen = roDb
        .prepare('SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx DESC LIMIT 1')
        .get(safeAfterGen) as { idx?: unknown; data?: Uint8Array | null } | undefined;
      if (
        !latestGen ||
        typeof latestGen.idx !== 'number' ||
        !Number.isSafeInteger(latestGen.idx) ||
        !latestGen.data ||
        latestGen.data.byteLength === 0
      ) {
        return { finalized: false };
      }

      const summary = parseAgyGenMetadataRow(latestGen.data);
      if (!summary || summary.usage === undefined) {
        return { finalized: false };
      }

      const stepIndices = summary.stepIndices;
      if (!Array.isArray(stepIndices) || stepIndices.length === 0) {
        return { finalized: false };
      }
      let maxGenStepIdx = -1;
      let includesLatestStep = false;
      for (const s of stepIndices) {
        if (!Number.isSafeInteger(s) || s < 0) return { finalized: false };
        if (s === latestStep.idx) includesLatestStep = true;
        if (s > maxGenStepIdx) maxGenStepIdx = s;
      }
      if (!includesLatestStep || maxGenStepIdx !== latestStep.idx) {
        return { finalized: false };
      }

      return {
        finalized: true,
        stepIdx: latestStep.idx,
        genIdx: latestGen.idx,
      };
    } finally {
      roDb.close();
    }
  } catch {
    return { finalized: false };
  }
}

/**
 * Advance step/generation output baselines to the highest terminal (`DONE` / `CANCELED` / `ERROR`)
 * `steps.idx` and highest `ModelUsageStats`-finalized `gen_metadata.idx` without ever skipping
 * past an already-started in-flight next step.
 */
export function readAgyCompletedOutputBaseline(
  conversationId: string | null | undefined,
  currentStepBaselineIdx: number,
  currentGenBaselineIdx: number,
  opts: { agyHomeDir?: string } = {},
): { stepBaselineIdx: number; genBaselineIdx: number } {
  const safeStep = Number.isSafeInteger(currentStepBaselineIdx) ? currentStepBaselineIdx : -1;
  const safeGen = Number.isSafeInteger(currentGenBaselineIdx) ? currentGenBaselineIdx : -1;
  if (typeof conversationId !== 'string' || !VALID_CONVERSATION_ID.test(conversationId)) {
    return { stepBaselineIdx: safeStep, genBaselineIdx: safeGen };
  }
  const agyHomeDir = opts.agyHomeDir ?? resolveDefaultAgyHomeDir();
  const dbPath = join(agyHomeDir, 'conversations', `${conversationId}.db`);
  if (probeSqliteFilePresence(dbPath) !== 'exists') {
    return { stepBaselineIdx: safeStep, genBaselineIdx: safeGen };
  }

  let DatabaseSyncCtor: any;
  try {
    ({ DatabaseSync: DatabaseSyncCtor } = requireFromHere('node:sqlite'));
  } catch {
    return { stepBaselineIdx: safeStep, genBaselineIdx: safeGen };
  }

  let nextStep = safeStep;
  let nextGen = safeGen;
  try {
    const roDb = new DatabaseSyncCtor(dbPath, { readOnly: true });
    try {
      const stepCols = roDb.prepare('PRAGMA table_info(steps)').all() as Array<{ name?: unknown }>;
      if (stepCols.some((c) => c?.name === 'status')) {
        const row = roDb
          .prepare('SELECT COALESCE(MAX(idx), ?) AS maxIdx FROM steps WHERE idx > ? AND status IN (3, 6, 7)')
          .get(safeStep, safeStep) as { maxIdx?: unknown } | undefined;
        if (typeof row?.maxIdx === 'number' && Number.isSafeInteger(row.maxIdx) && row.maxIdx > nextStep) {
          nextStep = row.maxIdx;
        }
      }

      const hasGenTable = roDb
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gen_metadata' LIMIT 1")
        .get();
      if (hasGenTable) {
        const genRows = roDb
          .prepare('SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx DESC LIMIT 8')
          .all(safeGen) as Array<{ idx?: unknown; data?: Uint8Array | null }>;
        for (const g of genRows) {
          if (typeof g.idx !== 'number' || !Number.isSafeInteger(g.idx) || !g.data || g.data.byteLength === 0) {
            continue;
          }
          const summary = parseAgyGenMetadataRow(g.data);
          if (summary && summary.usage !== undefined) {
            if (g.idx > nextGen) {
              nextGen = g.idx;
            }
            break;
          }
        }
      }
    } finally {
      roDb.close();
    }
  } catch {
    return { stepBaselineIdx: nextStep, genBaselineIdx: nextGen };
  }

  return { stepBaselineIdx: nextStep, genBaselineIdx: nextGen };
}

export function readAgyConversationGenMetadataSince(
  conversationId: string | null | undefined,
  afterIdx: number,
  opts: { agyHomeDir?: string; pageSize?: number } = {},
): {
  dbExists: boolean;
  readOk: boolean;
  rows: AgyGenMetadataRow[];
  presentRowIndices: number[];
  presentRows: AgyPresentGenRow[];
} {
  if (typeof conversationId !== 'string' || !VALID_CONVERSATION_ID.test(conversationId)) {
    return { dbExists: false, readOk: true, rows: [], presentRowIndices: [], presentRows: [] };
  }
  const agyHomeDir = opts.agyHomeDir ?? resolveDefaultAgyHomeDir();
  const dbPath = join(agyHomeDir, 'conversations', `${conversationId}.db`);
  const presence = probeSqliteFilePresence(dbPath);
  if (presence === 'absent') {
    return { dbExists: false, readOk: true, rows: [], presentRowIndices: [], presentRows: [] };
  }
  if (presence === 'error') {
    return { dbExists: true, readOk: false, rows: [], presentRowIndices: [], presentRows: [] };
  }

  let DatabaseSyncCtor: any;
  try {
    ({ DatabaseSync: DatabaseSyncCtor } = requireFromHere('node:sqlite'));
  } catch {
    return { dbExists: true, readOk: false, rows: [], presentRowIndices: [], presentRows: [] };
  }

  const pageSize = Math.max(1, Math.min(500, opts.pageSize ?? 200));
  try {
    const roDb = new DatabaseSyncCtor(dbPath, { readOnly: true });
    try {
      const hasTable = roDb
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gen_metadata' LIMIT 1")
        .get();
      if (!hasTable) {
        return { dbExists: true, readOk: true, rows: [], presentRowIndices: [], presentRows: [] };
      }
      const stmt = roDb.prepare(
        'SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx ASC LIMIT ?',
      );
      const parsed: AgyGenMetadataRow[] = [];
      const presentRowIndices: number[] = [];
      const presentRows: AgyPresentGenRow[] = [];
      let cursor = Number.isSafeInteger(afterIdx) ? afterIdx : -1;
      while (true) {
        const rawRows = stmt.all(cursor, pageSize) as { idx: number; data: Uint8Array | null }[];
        if (rawRows.length === 0) break;
        let maxBatchIdx = cursor;
        for (const row of rawRows) {
          if (!Number.isSafeInteger(row.idx)) continue;
          if (row.idx > maxBatchIdx) maxBatchIdx = row.idx;
          presentRowIndices.push(row.idx);
          if (!row.data || row.data.byteLength === 0) {
            presentRows.push({ idx: row.idx });
            continue;
          }
          const summary = parseAgyGenMetadataRow(row.data);
          if (summary) {
            presentRows.push({ idx: row.idx, stepIndices: summary.stepIndices });
            parsed.push({ idx: row.idx, summary });
          } else {
            presentRows.push({ idx: row.idx, stepIndices: parseAgyGenStepIndices(row.data) });
          }
        }
        if (rawRows.length < pageSize || maxBatchIdx <= cursor) break;
        cursor = maxBatchIdx;
      }
      return { dbExists: true, readOk: true, rows: parsed, presentRowIndices, presentRows };
    } finally {
      roDb.close();
    }
  } catch {
    return { dbExists: true, readOk: false, rows: [], presentRowIndices: [], presentRows: [] };
  }
}

export function readAgyConversationGenMetadata(
  conversationId: string | null | undefined,
  opts: ReadAgyGenMetadataOptions = {},
): AgyGenMetadataRow[] {
  if (typeof conversationId !== 'string' || !VALID_CONVERSATION_ID.test(conversationId)) {
    return [];
  }
  const agyHomeDir = opts.agyHomeDir ?? resolveDefaultAgyHomeDir();
  const dbPath = join(agyHomeDir, 'conversations', `${conversationId}.db`);
  if (!existsSync(dbPath)) {
    return [];
  }

  let DatabaseSyncCtor: any;
  try {
    ({ DatabaseSync: DatabaseSyncCtor } = requireFromHere('node:sqlite'));
  } catch {
    return [];
  }

  const limit = Math.max(1, Math.min(20, opts.limit ?? 8));
  try {
    const roDb = new DatabaseSyncCtor(dbPath, { readOnly: true });
    try {
      const rawRows = roDb
        .prepare('SELECT idx, data FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx DESC LIMIT ?')
        .all(limit) as { idx: number; data: Uint8Array }[];
      const parsed: AgyGenMetadataRow[] = [];
      for (const row of rawRows) {
        if (!Number.isSafeInteger(row.idx) || !row.data || row.data.byteLength === 0) continue;
        const summary = parseAgyGenMetadataRow(row.data);
        if (summary) {
          parsed.push({ idx: row.idx, summary });
        }
      }
      return parsed;
    } finally {
      roDb.close();
    }
  } catch {
    return [];
  }
}

function createUsageServiceEnvelope(
  usage: AgyStepTokenUsage,
  contextWindow: number | undefined,
  time: number,
): SessionEnvelope {
  const sessionUsage: SessionUsage = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.cacheReadTokens > 0 ? { cache_read_input_tokens: usage.cacheReadTokens } : {}),
    ...(contextWindow && contextWindow > 0 ? { context_window: contextWindow } : {}),
  };
  // Deliberately omit `turn` so older clients without usage-only-service filtering
  // never render empty chat bubbles, matching Codex token_count envelopes.
  return createEnvelope('agent', { t: 'service', text: '' }, { usage: sessionUsage, time });
}

export interface AgyContextUsageTrackerOptions {
  agyHomeDir?: string;
  readGenMetadata?: (conversationId: string | null | undefined) => AgyGenMetadataRow[];
  now?: () => number;
}

export interface AgyStepUsageContextOptions {
  genIdx?: number;
  stepIndex?: number;
  contextWindowTokens?: number;
  belongsToCurrentTurn?: boolean;
}

type StepGenIdentityResolution =
  | { kind: 'none' }
  | { kind: 'not_found' }
  | { kind: 'unique'; idx: number }
  | { kind: 'ambiguous'; maxIdx: number };

function resolveStepGenIdentity(
  rows: readonly AgyGenMetadataRow[],
  stepIndex: number | undefined,
): StepGenIdentityResolution {
  if (typeof stepIndex !== 'number' || !Number.isSafeInteger(stepIndex) || stepIndex < 0) {
    return { kind: 'none' };
  }
  const matches = rows.filter(
    (r) => Array.isArray(r.summary.stepIndices) && r.summary.stepIndices.includes(stepIndex),
  );
  if (matches.length === 0) return { kind: 'not_found' };
  if (matches.length === 1) return { kind: 'unique', idx: matches[0].idx };
  let maxIdx = matches[0].idx;
  for (let i = 1; i < matches.length; i++) {
    if (matches[i].idx > maxIdx) maxIdx = matches[i].idx;
  }
  return { kind: 'ambiguous', maxIdx };
}

function normalizeConversationScopeKey(conversationId: string | null | undefined): string {
  return typeof conversationId === 'string' && conversationId.trim().length > 0
    ? conversationId.trim()
    : '__default__';
}

export class AgyContextUsageTracker {
  private readonly modelWindowHistory = new Map<string, Map<number, number>>();
  private readonly lastEmittedStepIdxByConv = new Map<string, number>();
  private readonly readRows: (conversationId: string | null | undefined) => AgyGenMetadataRow[];
  private readonly now: () => number;
  private lastTime = 0;
  private lastTurnStep: {
    usage: AgyStepTokenUsage;
    emittedWithWindow: boolean;
    genIdx?: number;
    stepIndex?: number;
    model: string | null;
    baselineDbIdx: number;
  } | null = null;
  private lastEmittedDbIdx = -1;

  constructor(opts: AgyContextUsageTrackerOptions = {}) {
    this.readRows =
      opts.readGenMetadata ??
      ((conversationId) => readAgyConversationGenMetadata(conversationId, { agyHomeDir: opts.agyHomeDir }));
    this.now = opts.now ?? (() => Date.now());
  }

  private nextTime(): number {
    this.lastTime = Math.max(this.lastTime + 1, this.now());
    return this.lastTime;
  }

  startTurn(): void {
    this.lastTurnStep = null;
  }

  private recordModelWindowAtIdx(
    convScope: string,
    modelKey: string | undefined,
    idx: number,
    windowTokens: number,
  ): void {
    if (!modelKey) return;
    const trimmed = modelKey.trim().toLowerCase();
    if (!trimmed) return;
    const compositeKey = `${convScope}\0${trimmed}`;
    let byIdx = this.modelWindowHistory.get(compositeKey);
    if (!byIdx) {
      byIdx = new Map<number, number>();
      this.modelWindowHistory.set(compositeKey, byIdx);
    }
    byIdx.set(idx, windowTokens);
  }

  private rememberRowModelWindows(
    conversationId: string | null | undefined,
    rows: readonly AgyGenMetadataRow[],
  ): void {
    const convScope = normalizeConversationScopeKey(conversationId);
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      const { summary } = row;
      const windowTokens = summary.maxContextTokens;
      if (!windowTokens || windowTokens <= 0) continue;
      this.recordModelWindowAtIdx(convScope, summary.normalizedModelId, row.idx, windowTokens);
      if (summary.modelDisplayName) {
        this.recordModelWindowAtIdx(convScope, summary.modelDisplayName, row.idx, windowTokens);
        this.recordModelWindowAtIdx(
          convScope,
          normalizeAgyDisplayModelId(summary.modelDisplayName),
          row.idx,
          windowTokens,
        );
      }
      if (summary.responseModel) {
        this.recordModelWindowAtIdx(convScope, summary.responseModel, row.idx, windowTokens);
        this.recordModelWindowAtIdx(
          convScope,
          normalizeAgyDisplayModelId(summary.responseModel),
          row.idx,
          windowTokens,
        );
      }
    }
  }

  private lookupCachedModelWindow(
    conversationId: string | null | undefined,
    modelKeys: readonly string[],
    maxAllowedIdx: number,
  ): number | undefined {
    if (!Number.isSafeInteger(maxAllowedIdx) || maxAllowedIdx < 0) {
      return undefined;
    }
    const convScope = normalizeConversationScopeKey(conversationId);
    let bestIdx = -1;
    let bestWindow: number | undefined;
    for (const rawKey of modelKeys) {
      const trimmed = rawKey.trim().toLowerCase();
      if (!trimmed) continue;
      const byIdx = this.modelWindowHistory.get(`${convScope}\0${trimmed}`);
      if (!byIdx) continue;
      for (const [obsIdx, win] of byIdx.entries()) {
        if (obsIdx <= maxAllowedIdx && obsIdx > bestIdx && win > 0) {
          bestIdx = obsIdx;
          bestWindow = win;
        }
      }
    }
    return bestWindow;
  }

  private resolveContextWindowFromRows(
    conversationId: string | null | undefined,
    rows: readonly AgyGenMetadataRow[],
    activeModel: string | null | undefined,
    opts: {
      unlabeledAllowedIdx?: number;
      maxAllowedIdx: number;
    },
  ): number | undefined {
    this.rememberRowModelWindows(conversationId, rows);

    const trimmedModel = typeof activeModel === 'string' ? activeModel.trim().toLowerCase() : '';
    const hasSpecificModel = trimmedModel.length > 0 && trimmedModel !== 'default';
    const normalizedTarget = hasSpecificModel
      ? normalizeAgyDisplayModelId(trimmedModel) ?? trimmedModel
      : undefined;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.idx > opts.maxAllowedIdx) continue;
      const { summary } = row;
      if (!summary.maxContextTokens || summary.maxContextTokens <= 0) continue;

      const hasRowModelLabel = Boolean(
        summary.normalizedModelId || summary.modelDisplayName || summary.responseModel,
      );

      if (!normalizedTarget) {
        if (opts.unlabeledAllowedIdx !== undefined && row.idx === opts.unlabeledAllowedIdx && !hasRowModelLabel) {
          return summary.maxContextTokens;
        }
        if (hasRowModelLabel) {
          return summary.maxContextTokens;
        }
        continue;
      }

      if (summary.normalizedModelId) {
        if (summary.normalizedModelId === normalizedTarget) {
          return summary.maxContextTokens;
        }
        continue;
      }
      if (summary.modelDisplayName) {
        const displayLower = summary.modelDisplayName.trim().toLowerCase();
        const displayNorm = normalizeAgyDisplayModelId(summary.modelDisplayName) ?? displayLower;
        if (displayNorm === normalizedTarget || displayLower === trimmedModel) {
          return summary.maxContextTokens;
        }
        continue;
      }
      if (summary.responseModel) {
        const respLower = summary.responseModel.trim().toLowerCase();
        const respNorm = normalizeAgyDisplayModelId(summary.responseModel) ?? respLower;
        if (respNorm === normalizedTarget || respLower === trimmedModel) {
          return summary.maxContextTokens;
        }
        continue;
      }

      // An in-flight generation row writes chat_start_metadata (with max_context_tokens)
      // before response metadata populates model_display_name; allow ONLY when `row.idx`
      // is the exact generation being resolved.
      if (opts.unlabeledAllowedIdx !== undefined && row.idx === opts.unlabeledAllowedIdx) {
        return summary.maxContextTokens;
      }
    }

    if (normalizedTarget) {
      return this.lookupCachedModelWindow(
        conversationId,
        [normalizedTarget, trimmedModel],
        opts.maxAllowedIdx,
      );
    }
    return undefined;
  }

  /**
   * Read the latest persisted step usage + context window when resuming or refreshing
   * an existing Antigravity conversation so the context gauge appears immediately
   * without waiting for a new prompt.
   */
  buildResumeUsageEnvelope(
    conversationId: string | null | undefined,
    activeModel?: string | null,
  ): SessionEnvelope | null {
    const rows = [...this.readRows(conversationId)].sort((a, b) => b.idx - a.idx);
    if (rows.length === 0) return null;
    this.rememberRowModelWindows(conversationId, rows);

    for (const row of rows) {
      if (!row.summary.usage) continue;
      const contextWindow =
        row.summary.maxContextTokens ??
        this.resolveContextWindowFromRows(
          conversationId,
          rows.filter((r) => r.idx <= row.idx),
          row.summary.normalizedModelId ?? activeModel,
          { maxAllowedIdx: row.idx },
        );
      if (!contextWindow || contextWindow <= 0) continue;
      this.lastEmittedDbIdx = Math.max(this.lastEmittedDbIdx, row.idx);
      this.advanceEmittedStepWatermarkFromRow(conversationId, row);
      return createUsageServiceEnvelope(row.summary.usage, contextWindow, this.nextTime());
    }
    return null;
  }

  private advanceEmittedStepWatermark(
    conversationId: string | null | undefined,
    stepIndex: number | undefined,
  ): void {
    if (typeof stepIndex !== 'number' || !Number.isSafeInteger(stepIndex) || stepIndex < 0) return;
    const convScope = normalizeConversationScopeKey(conversationId);
    const prev = this.lastEmittedStepIdxByConv.get(convScope) ?? -1;
    if (stepIndex > prev) {
      this.lastEmittedStepIdxByConv.set(convScope, stepIndex);
    }
  }

  private advanceEmittedStepWatermarkFromRow(
    conversationId: string | null | undefined,
    row: AgyGenMetadataRow | undefined,
  ): void {
    if (!row || !Array.isArray(row.summary.stepIndices)) return;
    for (const s of row.summary.stepIndices) {
      this.advanceEmittedStepWatermark(conversationId, s);
    }
  }

  /**
   * Build a live per-step usage service envelope from native `agy` `step_update.usage`
   * paired with the generation's own `max_context_tokens` denominator.
   */
  buildStepUsageEnvelope(
    rawUsage: unknown,
    conversationId: string | null | undefined,
    activeModel?: string | null,
    opts?: AgyStepUsageContextOptions,
  ): SessionEnvelope | null {
    const usage = normalizeAgyStepUsage(rawUsage);
    if (!usage) return null;

    const baselineDbIdx = this.lastEmittedDbIdx;
    const convScope = normalizeConversationScopeKey(conversationId);
    const baselineStepIdx = this.lastEmittedStepIdxByConv.get(convScope) ?? -1;
    const rows = [...this.readRows(conversationId)].sort((a, b) => b.idx - a.idx);
    this.rememberRowModelWindows(conversationId, rows);

    const hasExplicitGenIdx =
      typeof opts?.genIdx === 'number' && Number.isSafeInteger(opts.genIdx) && opts.genIdx >= 0;
    const genIdx = hasExplicitGenIdx ? opts!.genIdx! : undefined;
    const stepIndex =
      typeof opts?.stepIndex === 'number' &&
      Number.isSafeInteger(opts.stepIndex) &&
      opts.stepIndex >= 0
        ? opts.stepIndex
        : undefined;
    const belongsToCurrentTurn = opts?.belongsToCurrentTurn ?? true;

    let provenStepGenIdx: number | undefined;
    if (genIdx !== undefined) {
      if (genIdx <= baselineDbIdx) {
        // Never overwrite a newer generation's live context gauge with an older delayed row.
        return null;
      }
    } else {
      // Resolve step identity across ALL SQLite rows BEFORE applying the emitted-generation
      // ordering guard so delayed older print steps are rejected instead of falling through
      // as unresolved events that could borrow a newer generation's denominator.
      const stepIdentity = resolveStepGenIdentity(rows, stepIndex);
      if (stepIdentity.kind === 'unique') {
        if (stepIdentity.idx < baselineDbIdx) {
          return null;
        }
        if (stepIdentity.idx === baselineDbIdx) {
          const isNewerStepInSameGen =
            belongsToCurrentTurn &&
            stepIndex !== undefined &&
            (baselineStepIdx < 0 || stepIndex > baselineStepIdx);
          if (!isNewerStepInSameGen) {
            return null;
          }
        } else if (stepIndex !== undefined && baselineStepIdx >= 0 && stepIndex <= baselineStepIdx) {
          return null;
        }
        if (belongsToCurrentTurn) {
          provenStepGenIdx = stepIdentity.idx;
        }
      } else if (stepIdentity.kind === 'ambiguous') {
        if (
          stepIdentity.maxIdx < baselineDbIdx ||
          (stepIdentity.maxIdx === baselineDbIdx &&
            (stepIndex === undefined || (baselineStepIdx >= 0 && stepIndex <= baselineStepIdx)))
        ) {
          return null;
        }
      } else if (stepIdentity.kind === 'not_found') {
        if (stepIndex !== undefined && baselineStepIdx >= 0 && stepIndex <= baselineStepIdx) {
          return null;
        }
      }
    }

    const targetGenIdx = genIdx ?? provenStepGenIdx;
    const matchedRow =
      targetGenIdx !== undefined ? rows.find((r) => r.idx === targetGenIdx) : undefined;

    const explicitCallerWindow =
      typeof opts?.contextWindowTokens === 'number' &&
      Number.isSafeInteger(opts.contextWindowTokens) &&
      opts.contextWindowTokens > 0
        ? opts.contextWindowTokens
        : undefined;

    const explicitRowWindow =
      explicitCallerWindow ??
      (targetGenIdx !== undefined &&
      matchedRow?.summary.maxContextTokens &&
      matchedRow.summary.maxContextTokens > 0
        ? matchedRow.summary.maxContextTokens
        : undefined);

    const lookupModel =
      (targetGenIdx !== undefined ? matchedRow?.summary.normalizedModelId : undefined) ??
      activeModel;
    const hasKnownModel =
      typeof lookupModel === 'string' &&
      lookupModel.trim().length > 0 &&
      lookupModel.trim().toLowerCase() !== 'default';

    // Never treat an advancing `baselineDbIdx` as a valid lookup bound for an unresolved
    // print event (`targetGenIdx === undefined`): without a proven generation identity,
    // an older/concurrent event must never borrow a newer generation's model window.
    let contextWindow = explicitRowWindow;
    if (
      contextWindow === undefined &&
      targetGenIdx !== undefined &&
      targetGenIdx >= 0 &&
      (belongsToCurrentTurn || hasKnownModel)
    ) {
      const candidateRows = rows.filter((r) => r.idx <= targetGenIdx);
      const unlabeledAllowedIdx =
        genIdx !== undefined || belongsToCurrentTurn ? targetGenIdx : undefined;
      contextWindow = this.resolveContextWindowFromRows(
        conversationId,
        candidateRows,
        lookupModel,
        {
          unlabeledAllowedIdx,
          maxAllowedIdx: targetGenIdx,
        },
      );
    }

    if (genIdx !== undefined) {
      this.lastEmittedDbIdx = Math.max(this.lastEmittedDbIdx, genIdx);
      this.advanceEmittedStepWatermarkFromRow(conversationId, matchedRow);
    } else if (
      belongsToCurrentTurn &&
      targetGenIdx !== undefined &&
      contextWindow !== undefined &&
      contextWindow > 0
    ) {
      this.lastEmittedDbIdx = Math.max(this.lastEmittedDbIdx, targetGenIdx);
    }
    this.advanceEmittedStepWatermark(conversationId, stepIndex);

    if (belongsToCurrentTurn) {
      const normalizedStoredModel = hasKnownModel ? lookupModel!.trim() : null;
      const boundGenIdx =
        genIdx ??
        (targetGenIdx !== undefined && contextWindow !== undefined && contextWindow > 0
          ? targetGenIdx
          : undefined);
      this.lastTurnStep = {
        usage,
        emittedWithWindow: Boolean(contextWindow && contextWindow > 0),
        genIdx: boundGenIdx,
        stepIndex,
        model: normalizedStoredModel,
        baselineDbIdx,
      };
    }

    return createUsageServiceEnvelope(usage, contextWindow, this.nextTime());
  }

  /**
   * Reconcile context usage when the turn's terminal `result` event arrives.
   * Never uses `result.usage` (which sums across every step of the conversation);
   * only backfills `context_window` onto the last single-step usage bounded to that
   * step's own proven generation, or reads the newest unemitted single-step `gen_metadata`
   * row if no step event was observed.
   */
  reconcileTurnEndEnvelope(
    conversationId: string | null | undefined,
    activeModel?: string | null,
  ): SessionEnvelope | null {
    if (this.lastTurnStep?.emittedWithWindow) {
      return null;
    }

    const rows = [...this.readRows(conversationId)].sort((a, b) => b.idx - a.idx);
    this.rememberRowModelWindows(conversationId, rows);

    if (this.lastTurnStep) {
      let targetGenIdx = this.lastTurnStep.genIdx;
      if (targetGenIdx === undefined) {
        const stepIdentity = resolveStepGenIdentity(rows, this.lastTurnStep.stepIndex);
        if (stepIdentity.kind === 'unique') {
          targetGenIdx = stepIdentity.idx;
        }
      }
      if (targetGenIdx === undefined) {
        return null;
      }
      if (
        targetGenIdx < this.lastEmittedDbIdx ||
        (targetGenIdx === this.lastEmittedDbIdx && this.lastTurnStep.genIdx !== targetGenIdx)
      ) {
        return null;
      }
      if (targetGenIdx <= this.lastTurnStep.baselineDbIdx && this.lastTurnStep.genIdx !== targetGenIdx) {
        return null;
      }

      const targetRow = rows.find((r) => r.idx === targetGenIdx);
      const lookupModel =
        targetRow?.summary.normalizedModelId ?? this.lastTurnStep.model ?? activeModel;
      const directRowWindow =
        targetRow?.summary.maxContextTokens && targetRow.summary.maxContextTokens > 0
          ? targetRow.summary.maxContextTokens
          : undefined;
      const contextWindow =
        directRowWindow ??
        this.resolveContextWindowFromRows(
          conversationId,
          rows.filter((r) => r.idx <= targetGenIdx),
          lookupModel,
          {
            unlabeledAllowedIdx: targetGenIdx,
            maxAllowedIdx: targetGenIdx,
          },
        );
      if (!contextWindow || contextWindow <= 0) return null;

      this.lastEmittedDbIdx = Math.max(this.lastEmittedDbIdx, targetGenIdx);
      this.advanceEmittedStepWatermark(conversationId, this.lastTurnStep.stepIndex);
      this.advanceEmittedStepWatermarkFromRow(conversationId, targetRow);
      this.lastTurnStep.emittedWithWindow = true;
      this.lastTurnStep.genIdx = targetGenIdx;
      return createUsageServiceEnvelope(this.lastTurnStep.usage, contextWindow, this.nextTime());
    }

    const maxRowIdx = rows.length > 0 ? rows[0].idx : -1;
    for (const row of rows) {
      if (row.idx <= this.lastEmittedDbIdx || !row.summary.usage) continue;
      const isHeadRow = row.idx === maxRowIdx;
      const rowModel = row.summary.normalizedModelId ?? (isHeadRow ? activeModel : null);
      const hasKnownRowModel =
        typeof rowModel === 'string' &&
        rowModel.trim().length > 0 &&
        rowModel.trim().toLowerCase() !== 'default';
      const rowWindow =
        row.summary.maxContextTokens ??
        (isHeadRow || hasKnownRowModel
          ? this.resolveContextWindowFromRows(
              conversationId,
              rows.filter((r) => r.idx <= row.idx),
              rowModel,
              {
                unlabeledAllowedIdx: isHeadRow ? row.idx : undefined,
                maxAllowedIdx: row.idx,
              },
            )
          : undefined);
      if (!rowWindow || rowWindow <= 0) continue;
      const prevDbIdx = this.lastEmittedDbIdx;
      this.lastEmittedDbIdx = Math.max(this.lastEmittedDbIdx, row.idx);
      this.advanceEmittedStepWatermarkFromRow(conversationId, row);
      this.lastTurnStep = {
        usage: row.summary.usage,
        emittedWithWindow: true,
        genIdx: row.idx,
        model: hasKnownRowModel ? rowModel!.trim() : null,
        baselineDbIdx: prevDbIdx,
      };
      return createUsageServiceEnvelope(row.summary.usage, rowWindow, this.nextTime());
    }

    return null;
  }
}
