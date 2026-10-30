import { existsSync } from 'node:fs';
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

function parseModelUsageStats(buf: Uint8Array, start: number, end: number): AgyStepTokenUsage | undefined {
  let pos = start;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens = 0;

  while (pos < end) {
    const tag = readVarintBigInt(buf, pos, end);
    if (!tag) break;
    pos = tag.nextPos;
    const fieldNo = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (fieldNo <= 0) break;

    if (wireType === 0) {
      const v = readVarintBigInt(buf, pos, end);
      if (!v) break;
      pos = v.nextPos;
      if (fieldNo === 2) inputTokens = toNonNegativeSafeInt(v.value);
      else if (fieldNo === 3) outputTokens = toNonNegativeSafeInt(v.value);
      else if (fieldNo === 5) cacheReadTokens = toNonNegativeSafeInt(v.value) ?? 0;
    } else if (wireType === 2) {
      const len = readVarintBigInt(buf, pos, end);
      if (!len) break;
      const byteLen = toNonNegativeSafeInt(len.value);
      if (byteLen === undefined || len.nextPos + byteLen > end) break;
      pos = len.nextPos + byteLen;
    } else if (wireType === 1) {
      if (pos + 8 > end) break;
      pos += 8;
    } else if (wireType === 5) {
      if (pos + 4 > end) break;
      pos += 4;
    } else {
      break;
    }
  }

  if (inputTokens === undefined && outputTokens === undefined && cacheReadTokens === 0) {
    return undefined;
  }
  const resolved = {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens,
  };
  return resolved.inputTokens + resolved.outputTokens + resolved.cacheReadTokens > 0
    ? resolved
    : undefined;
}

function parseContextWindowMetadata(
  buf: Uint8Array,
  start: number,
  end: number,
): { estimatedTokensUsed?: number; maxContextTokens?: number } {
  let pos = start;
  let estimatedTokensUsed: number | undefined;
  let maxContextTokens: number | undefined;

  while (pos < end) {
    const tag = readVarintBigInt(buf, pos, end);
    if (!tag) break;
    pos = tag.nextPos;
    const fieldNo = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (fieldNo <= 0) break;

    if (wireType === 0) {
      const v = readVarintBigInt(buf, pos, end);
      if (!v) break;
      pos = v.nextPos;
      if (fieldNo === 1) estimatedTokensUsed = toPositiveSafeInt(v.value);
      else if (fieldNo === 4) maxContextTokens = toPositiveSafeInt(v.value);
    } else if (wireType === 2) {
      const len = readVarintBigInt(buf, pos, end);
      if (!len) break;
      const byteLen = toNonNegativeSafeInt(len.value);
      if (byteLen === undefined || len.nextPos + byteLen > end) break;
      pos = len.nextPos + byteLen;
    } else if (wireType === 1) {
      if (pos + 8 > end) break;
      pos += 8;
    } else if (wireType === 5) {
      if (pos + 4 > end) break;
      pos += 4;
    } else {
      break;
    }
  }

  return { estimatedTokensUsed, maxContextTokens };
}

function parseChatStartMetadata(
  buf: Uint8Array,
  start: number,
  end: number,
): { estimatedTokensUsed?: number; maxContextTokens?: number } {
  let pos = start;
  while (pos < end) {
    const tag = readVarintBigInt(buf, pos, end);
    if (!tag) break;
    pos = tag.nextPos;
    const fieldNo = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (fieldNo <= 0) break;

    if (wireType === 2) {
      const len = readVarintBigInt(buf, pos, end);
      if (!len) break;
      const byteLen = toNonNegativeSafeInt(len.value);
      if (byteLen === undefined || len.nextPos + byteLen > end) break;
      const subStart = len.nextPos;
      const subEnd = subStart + byteLen;
      pos = subEnd;
      if (fieldNo === 10) {
        return parseContextWindowMetadata(buf, subStart, subEnd);
      }
    } else if (wireType === 0) {
      const v = readVarintBigInt(buf, pos, end);
      if (!v) break;
      pos = v.nextPos;
    } else if (wireType === 1) {
      if (pos + 8 > end) break;
      pos += 8;
    } else if (wireType === 5) {
      if (pos + 4 > end) break;
      pos += 4;
    } else {
      break;
    }
  }
  return {};
}

function parseChatModelMetadata(buf: Uint8Array, start: number, end: number): AgyGenMetadataSummary {
  let pos = start;
  const summary: AgyGenMetadataSummary = {};

  while (pos < end) {
    const tag = readVarintBigInt(buf, pos, end);
    if (!tag) break;
    pos = tag.nextPos;
    const fieldNo = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (fieldNo <= 0) break;

    if (wireType === 2) {
      const len = readVarintBigInt(buf, pos, end);
      if (!len) break;
      const byteLen = toNonNegativeSafeInt(len.value);
      if (byteLen === undefined || len.nextPos + byteLen > end) break;
      const subStart = len.nextPos;
      const subEnd = subStart + byteLen;
      pos = subEnd;

      // Skip large system_prompt (f1) and message_prompts (f2) in O(1) without copying.
      if (fieldNo === 4) {
        summary.usage = parseModelUsageStats(buf, subStart, subEnd);
      } else if (fieldNo === 9) {
        const cw = parseChatStartMetadata(buf, subStart, subEnd);
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
    } else if (wireType === 0) {
      const v = readVarintBigInt(buf, pos, end);
      if (!v) break;
      pos = v.nextPos;
    } else if (wireType === 1) {
      if (pos + 8 > end) break;
      pos += 8;
    } else if (wireType === 5) {
      if (pos + 4 > end) break;
      pos += 4;
    } else {
      break;
    }
  }

  return summary;
}

/**
 * Parse a `gen_metadata.data` protobuf blob (`CortexStepGeneratorMetadata`) from
 * `~/.gemini/antigravity-cli/conversations/<conversationId>.db`.
 */
export function parseAgyGenMetadataRow(data: Uint8Array): AgyGenMetadataSummary | null {
  if (!data || data.byteLength === 0) return null;
  let pos = 0;
  const end = data.byteLength;

  while (pos < end) {
    const tag = readVarintBigInt(data, pos, end);
    if (!tag) break;
    pos = tag.nextPos;
    const fieldNo = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (fieldNo <= 0) break;

    if (wireType === 2) {
      const len = readVarintBigInt(data, pos, end);
      if (!len) break;
      const byteLen = toNonNegativeSafeInt(len.value);
      if (byteLen === undefined || len.nextPos + byteLen > end) break;
      const subStart = len.nextPos;
      const subEnd = subStart + byteLen;
      pos = subEnd;
      if (fieldNo === 1) {
        const summary = parseChatModelMetadata(data, subStart, subEnd);
        if (
          summary.usage !== undefined ||
          summary.maxContextTokens !== undefined ||
          summary.estimatedTokensUsed !== undefined
        ) {
          return summary;
        }
      }
    } else if (wireType === 0) {
      const v = readVarintBigInt(data, pos, end);
      if (!v) break;
      pos = v.nextPos;
    } else if (wireType === 1) {
      if (pos + 8 > end) break;
      pos += 8;
    } else if (wireType === 5) {
      if (pos + 4 > end) break;
      pos += 4;
    } else {
      break;
    }
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
  if (input + output + cacheRead <= 0) return null;
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

export class AgyContextUsageTracker {
  private readonly contextWindowByModel = new Map<string, number>();
  private readonly readRows: (conversationId: string | null | undefined) => AgyGenMetadataRow[];
  private readonly now: () => number;
  private lastTime = 0;
  private lastTurnStep: { usage: AgyStepTokenUsage; emittedWithWindow: boolean } | null = null;
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

  private rememberRowModelWindows(rows: readonly AgyGenMetadataRow[]): void {
    // Iterate oldest-to-newest so the freshest observation wins if an experiment changes.
    for (let i = rows.length - 1; i >= 0; i--) {
      const { summary } = rows[i];
      const windowTokens = summary.maxContextTokens;
      if (!windowTokens || windowTokens <= 0) continue;
      if (summary.normalizedModelId) {
        this.contextWindowByModel.set(summary.normalizedModelId, windowTokens);
      }
      if (summary.modelDisplayName) {
        this.contextWindowByModel.set(summary.modelDisplayName.toLowerCase(), windowTokens);
      }
      if (summary.responseModel) {
        this.contextWindowByModel.set(summary.responseModel.toLowerCase(), windowTokens);
      }
    }
  }

  private resolveContextWindowFromRows(
    rows: readonly AgyGenMetadataRow[],
    activeModel?: string | null,
    allowUnlabeledHeadRow = false,
  ): number | undefined {
    this.rememberRowModelWindows(rows);

    const trimmedModel = typeof activeModel === 'string' ? activeModel.trim().toLowerCase() : '';
    const hasSpecificModel = trimmedModel.length > 0 && trimmedModel !== 'default';
    const normalizedTarget = hasSpecificModel
      ? normalizeAgyDisplayModelId(trimmedModel) ?? trimmedModel
      : undefined;

    for (let i = 0; i < rows.length; i++) {
      const { summary } = rows[i];
      if (!summary.maxContextTokens || summary.maxContextTokens <= 0) continue;
      if (!normalizedTarget) {
        return summary.maxContextTokens;
      }
      if (summary.normalizedModelId) {
        if (summary.normalizedModelId === normalizedTarget) {
          return summary.maxContextTokens;
        }
        continue;
      }
      if (
        summary.modelDisplayName &&
        summary.modelDisplayName.toLowerCase() === trimmedModel
      ) {
        return summary.maxContextTokens;
      }
      // An in-flight head row writes chat_start_metadata (with max_context_tokens)
      // before response metadata populates model_display_name.
      if (i === 0 && allowUnlabeledHeadRow) {
        return summary.maxContextTokens;
      }
    }

    if (normalizedTarget) {
      return this.contextWindowByModel.get(normalizedTarget) ?? this.contextWindowByModel.get(trimmedModel);
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
    const rows = this.readRows(conversationId);
    if (rows.length === 0) return null;
    this.rememberRowModelWindows(rows);

    for (const row of rows) {
      if (!row.summary.usage) continue;
      const contextWindow =
        row.summary.maxContextTokens ??
        this.resolveContextWindowFromRows(rows, row.summary.normalizedModelId ?? activeModel, false);
      if (!contextWindow || contextWindow <= 0) continue;
      this.lastEmittedDbIdx = Math.max(this.lastEmittedDbIdx, row.idx);
      return createUsageServiceEnvelope(row.summary.usage, contextWindow, this.nextTime());
    }
    return null;
  }

  /**
   * Build a live per-step usage service envelope from native `agy` `step_update.usage`
   * paired with the active conversation's native `max_context_tokens` denominator.
   */
  buildStepUsageEnvelope(
    rawUsage: unknown,
    conversationId: string | null | undefined,
    activeModel?: string | null,
  ): SessionEnvelope | null {
    const usage = normalizeAgyStepUsage(rawUsage);
    if (!usage) return null;

    const rows = this.readRows(conversationId);
    if (rows.length > 0) {
      this.lastEmittedDbIdx = Math.max(this.lastEmittedDbIdx, rows[0].idx);
    }
    const contextWindow = this.resolveContextWindowFromRows(rows, activeModel, true);
    this.lastTurnStep = {
      usage,
      emittedWithWindow: Boolean(contextWindow && contextWindow > 0),
    };
    return createUsageServiceEnvelope(usage, contextWindow, this.nextTime());
  }

  /**
   * Reconcile context usage when the turn's terminal `result` event arrives.
   * Never uses `result.usage` (which sums across every step of the conversation);
   * only backfills `context_window` onto the last single-step usage if SQLite
   * committed `gen_metadata` after `step_update` hit stdout, or reads the newest
   * single-step `gen_metadata` row if no step event was observed.
   */
  reconcileTurnEndEnvelope(
    conversationId: string | null | undefined,
    activeModel?: string | null,
  ): SessionEnvelope | null {
    if (this.lastTurnStep?.emittedWithWindow) {
      return null;
    }

    const rows = this.readRows(conversationId);
    const contextWindow = this.resolveContextWindowFromRows(rows, activeModel, true);

    if (this.lastTurnStep) {
      if (!contextWindow || contextWindow <= 0) return null;
      this.lastTurnStep.emittedWithWindow = true;
      return createUsageServiceEnvelope(this.lastTurnStep.usage, contextWindow, this.nextTime());
    }

    for (const row of rows) {
      if (row.idx <= this.lastEmittedDbIdx || !row.summary.usage) continue;
      const rowWindow = row.summary.maxContextTokens ?? contextWindow;
      if (!rowWindow || rowWindow <= 0) continue;
      this.lastEmittedDbIdx = row.idx;
      this.lastTurnStep = { usage: row.summary.usage, emittedWithWindow: true };
      return createUsageServiceEnvelope(row.summary.usage, rowWindow, this.nextTime());
    }

    return null;
  }
}
