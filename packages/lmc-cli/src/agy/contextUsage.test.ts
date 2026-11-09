import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionEnvelopeSchema } from 'lmc-wire';
import {
  AgyContextUsageTracker,
  checkAgyIdlePlannerStepFinalized,
  normalizeAgyDisplayModelId,
  parseAgyGenMetadataRow,
  probeAgyAutonomousWakeupState,
  readAgyConversationGenMetadata,
  type AgyGenMetadataRow,
} from './contextUsage';
import { AgyStream } from './stream';

const requireFromHere = createRequire(import.meta.url);

function encodeVarint(value: bigint | number): Buffer {
  let v = typeof value === 'bigint' ? BigInt.asUintN(64, value) : BigInt(value >>> 0);
  const bytes: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    bytes.push(b);
  } while (v > 0n);
  return Buffer.from(bytes);
}

function encodeVarintField(fieldNo: number, value: bigint | number): Buffer {
  return Buffer.concat([encodeVarint((BigInt(fieldNo) << 3n) | 0n), encodeVarint(value)]);
}

function encodeBytesField(fieldNo: number, payload: Uint8Array | string): Buffer {
  const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  return Buffer.concat([encodeVarint((BigInt(fieldNo) << 3n) | 2n), encodeVarint(buf.length), buf]);
}

function buildFakeGenMetadataBlob(opts: {
  systemPromptBytes?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  estimatedTokensUsed?: number;
  maxContextTokens?: number;
  responseModel?: string;
  modelDisplayName?: string;
  negativeSentinel?: boolean;
}): Buffer {
  const chatFields: Buffer[] = [];
  if (opts.systemPromptBytes && opts.systemPromptBytes > 0) {
    chatFields.push(encodeBytesField(1, Buffer.alloc(opts.systemPromptBytes, 0x41)));
  }
  if (opts.negativeSentinel) {
    // Sign-extended negative int32 (-1 = 10-byte varint) on an unrelated field
    chatFields.push(encodeVarintField(13, -1n));
  }
  if (
    opts.inputTokens !== undefined ||
    opts.outputTokens !== undefined ||
    opts.cacheReadTokens !== undefined
  ) {
    const usageFields: Buffer[] = [encodeVarintField(1, 1417)];
    if (opts.inputTokens !== undefined) usageFields.push(encodeVarintField(2, opts.inputTokens));
    if (opts.outputTokens !== undefined) usageFields.push(encodeVarintField(3, opts.outputTokens));
    if (opts.cacheReadTokens !== undefined) usageFields.push(encodeVarintField(5, opts.cacheReadTokens));
    chatFields.push(encodeBytesField(4, Buffer.concat(usageFields)));
  }
  if (opts.estimatedTokensUsed !== undefined || opts.maxContextTokens !== undefined) {
    const cwFields: Buffer[] = [];
    if (opts.estimatedTokensUsed !== undefined) {
      cwFields.push(encodeVarintField(1, opts.estimatedTokensUsed));
    }
    if (opts.maxContextTokens !== undefined) {
      cwFields.push(encodeVarintField(4, opts.maxContextTokens));
    }
    const chatStart = encodeBytesField(10, Buffer.concat(cwFields));
    chatFields.push(encodeBytesField(9, chatStart));
  }
  if (opts.responseModel) {
    chatFields.push(encodeBytesField(19, opts.responseModel));
  }
  if (opts.modelDisplayName) {
    chatFields.push(encodeBytesField(21, opts.modelDisplayName));
  }
  return encodeBytesField(1, Buffer.concat(chatFields));
}

describe('contextUsage', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes Antigravity model display names and CLI model IDs to identical canonical keys', () => {
    expect(normalizeAgyDisplayModelId('Gemini 4 Argon (High)')).toBe(
      normalizeAgyDisplayModelId('gemini-4-argon-high'),
    );
    expect(normalizeAgyDisplayModelId('Gemini 3.8 Flash (Low)')).toBe(
      normalizeAgyDisplayModelId('gemini-3.8-flash-low'),
    );
    expect(normalizeAgyDisplayModelId('Claude Opus 5.5 (Low)')).toBe(
      normalizeAgyDisplayModelId('claude-opus-5-5-low'),
    );
    expect(normalizeAgyDisplayModelId('Claude Sonnet 5.5 (High)')).toBe(
      normalizeAgyDisplayModelId('claude-sonnet-5-5-high'),
    );
    expect(normalizeAgyDisplayModelId('GPT-OSS 120B (Medium)')).toBe(
      normalizeAgyDisplayModelId('gpt-oss-120b-medium'),
    );
    expect(normalizeAgyDisplayModelId('')).toBeUndefined();
    expect(normalizeAgyDisplayModelId(null)).toBeUndefined();
  });

  it('parses CortexStepGeneratorMetadata protobuf rows including large prompts and 64-bit varints', () => {
    const blob = buildFakeGenMetadataBlob({
      systemPromptBytes: 128 * 1024,
      negativeSentinel: true,
      inputTokens: 5859,
      cacheReadTokens: 128977,
      outputTokens: 1456,
      estimatedTokensUsed: 132918,
      maxContextTokens: 256000,
      responseModel: 'gemini-4-argon-d',
      modelDisplayName: 'Gemini 4 Argon (High)',
    });

    const parsed = parseAgyGenMetadataRow(blob);
    expect(parsed).toEqual({
      usage: {
        inputTokens: 5859,
        outputTokens: 1456,
        cacheReadTokens: 128977,
      },
      estimatedTokensUsed: 132918,
      maxContextTokens: 256000,
      responseModel: 'gemini-4-argon-d',
      modelDisplayName: 'Gemini 4 Argon (High)',
      normalizedModelId: 'gemini-4-argon-high',
    });
  });

  it('reads latest gen_metadata rows from conversation SQLite DB in descending order', () => {
    const { DatabaseSync } = requireFromHere('node:sqlite');
    const agyHomeDir = mkdtempSync(join(os.tmpdir(), 'agy-ctx-test-'));
    tempDirs.push(agyHomeDir);
    const convDir = join(agyHomeDir, 'conversations');
    mkdirSync(convDir, { recursive: true });
    const convId = 'conv-sqlite-test-1';
    const db = new DatabaseSync(join(convDir, `${convId}.db`));
    db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER NOT NULL DEFAULT 0)');
    const insert = db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)');

    const row0 = buildFakeGenMetadataBlob({
      inputTokens: 9000,
      cacheReadTokens: 0,
      outputTokens: 200,
      maxContextTokens: 256000,
      modelDisplayName: 'Gemini 4 Argon (High)',
    });
    const row1 = buildFakeGenMetadataBlob({
      inputTokens: 4783,
      cacheReadTokens: 47465,
      outputTokens: 1503,
      maxContextTokens: 256000,
      modelDisplayName: 'Gemini 4 Argon (High)',
    });
    insert.run(0, row0, row0.length);
    insert.run(1, row1, row1.length);
    db.close();

    const rows = readAgyConversationGenMetadata(convId, { agyHomeDir });
    expect(rows).toHaveLength(2);
    expect(rows[0].idx).toBe(1);
    expect(rows[0].summary.usage).toEqual({
      inputTokens: 4783,
      outputTokens: 1503,
      cacheReadTokens: 47465,
    });
    expect(rows[0].summary.maxContextTokens).toBe(256000);

    const tracker = new AgyContextUsageTracker({ agyHomeDir, now: () => 5000 });
    const resumeEnv = tracker.buildResumeUsageEnvelope(convId, 'gemini-4-argon-high');
    expect(resumeEnv).not.toBeNull();
    expect(sessionEnvelopeSchema.safeParse(resumeEnv).success).toBe(true);
    expect(resumeEnv?.turn).toBeUndefined();
    expect(resumeEnv?.ev).toEqual({ t: 'service', text: '' });
    expect(resumeEnv?.usage).toEqual({
      input_tokens: 4783,
      cache_read_input_tokens: 47465,
      output_tokens: 1503,
      context_window: 256000,
    });
  });

  it('tracks live per-step usage, compaction drops, model window changes, and post-turn backfill', () => {
    let fakeRows = [
      {
        idx: 10,
        summary: {
          usage: { inputTokens: 11899, outputTokens: 528, cacheReadTokens: 238965 },
          maxContextTokens: 256000,
          modelDisplayName: 'Gemini 4 Argon (High)',
          normalizedModelId: 'gemini-4-argon-high',
          stepIndices: [1, 2],
        },
      },
    ];
    const tracker = new AgyContextUsageTracker({
      readGenMetadata: () => fakeRows,
      now: () => 10_000,
    });

    // Step before compaction (~98% of 256k)
    tracker.startTurn();
    const env1 = tracker.buildStepUsageEnvelope(
      { input_tokens: 11899, cache_read_tokens: 238965, output_tokens: 528, total_tokens: 12427 },
      'conv-1',
      'gemini-4-argon-high',
      { stepIndex: 1 },
    );
    expect(env1?.time).toBe(10_000);
    expect(env1?.usage).toEqual({
      input_tokens: 11899,
      cache_read_input_tokens: 238965,
      output_tokens: 528,
      context_window: 256000,
    });

    // Next step in the same millisecond after native compaction (~20% of 256k):
    // monotonic time ensures reducer updates latestUsage downwards instead of dropping same-ms packet.
    const env2 = tracker.buildStepUsageEnvelope(
      { input_tokens: 4783, cache_read_tokens: 47465, output_tokens: 1503, total_tokens: 6286 },
      'conv-1',
      'gemini-4-argon-high',
      { stepIndex: 2 },
    );
    expect(env2?.time).toBe(10_001);
    expect(env2?.usage).toEqual({
      input_tokens: 4783,
      cache_read_input_tokens: 47465,
      output_tokens: 1503,
      context_window: 256000,
    });

    // Turn end does NOT re-emit when step already carried context_window
    expect(tracker.reconcileTurnEndEnvelope('conv-1', 'gemini-4-argon-high')).toBeNull();

    // Switch model to Claude Opus 5.5 (Low) before SQLite flushes Claude's row:
    // must NOT contaminate Claude turn with Gemini's 256k window; then backfill 840k on turn end!
    tracker.startTurn();
    const claudeStepBeforeFlush = tracker.buildStepUsageEnvelope(
      { input_tokens: 7002, cache_read_tokens: 5583, output_tokens: 11, total_tokens: 7013 },
      'conv-1',
      'claude-opus-5-5-low',
      { stepIndex: 3 },
    );
    expect(claudeStepBeforeFlush?.usage).toEqual({
      input_tokens: 7002,
      cache_read_input_tokens: 5583,
      output_tokens: 11,
    });

    // Now SQLite commits Claude's gen_metadata row with 840,000 window before terminal `result`:
    fakeRows = [
      {
        idx: 11,
        summary: {
          usage: { inputTokens: 7002, outputTokens: 11, cacheReadTokens: 5583 },
          maxContextTokens: 840000,
          modelDisplayName: 'Claude Opus 5.5 (Low)',
          normalizedModelId: 'claude-opus-5-5-low',
          stepIndices: [3],
        },
      },
      ...fakeRows,
    ];
    const backfilled = tracker.reconcileTurnEndEnvelope('conv-1', 'claude-opus-5-5-low');
    expect(backfilled?.time).toBeGreaterThan(claudeStepBeforeFlush!.time);
    expect(backfilled?.usage).toEqual({
      input_tokens: 7002,
      cache_read_input_tokens: 5583,
      output_tokens: 11,
      context_window: 840000,
    });
  });

  it('fails closed on unsafe >53-bit protobuf token counters or truncated trailing tags without partial emission', () => {
    // 1. ModelUsageStats with inputTokens = 2^53 (unsafe JS integer) + valid outputTokens = 12 -> usage must be undefined!
    const unsafeUsageFields = Buffer.concat([
      encodeVarintField(2, 1n << 53n),
      encodeVarintField(3, 12),
    ]);
    const unsafeBlob = encodeBytesField(1, encodeBytesField(4, unsafeUsageFields));
    expect(parseAgyGenMetadataRow(unsafeBlob)?.usage).toBeUndefined();

    // 2. ModelUsageStats with valid outputTokens = 12 followed by truncated varint [0x10, 0x80] -> usage must be undefined!
    const truncatedUsageFields = Buffer.concat([
      encodeVarintField(3, 12),
      Buffer.from([0x10, 0x80]),
    ]);
    const truncatedBlob = encodeBytesField(1, encodeBytesField(4, truncatedUsageFields));
    expect(parseAgyGenMetadataRow(truncatedBlob)?.usage).toBeUndefined();

    // 3. ContextWindowMetadata with valid maxContextTokens = 256000 followed by truncated varint [0x08, 0x80] -> must drop window!
    const truncatedCw = Buffer.concat([
      encodeVarintField(4, 256000),
      Buffer.from([0x08, 0x80]),
    ]);
    const truncatedCwBlob = encodeBytesField(1, encodeBytesField(9, encodeBytesField(10, truncatedCw)));
    expect(parseAgyGenMetadataRow(truncatedCwBlob)).toBeNull();

    // 4. Enclosing ChatModelMetadata with valid field 4 (outputTokens=12) followed by truncated tag [0x80] -> null!
    expect(parseAgyGenMetadataRow(Uint8Array.from([0x0a, 0x05, 0x22, 0x02, 0x18, 0x0c, 0x80]))).toBeNull();

    // 5. Enclosing root CortexStepGeneratorMetadata with valid field 1 followed by truncated tag [0x80] -> null!
    expect(parseAgyGenMetadataRow(Uint8Array.from([0x0a, 0x04, 0x22, 0x02, 0x18, 0x0c, 0x80]))).toBeNull();

    // 6. Enclosing ChatStartMetadata with valid field 10 followed by truncated tag [0x80] -> null!
    const validCwField10 = encodeBytesField(10, encodeVarintField(4, 200000));
    const truncatedChatStart = Buffer.concat([validCwField10, Buffer.from([0x80])]);
    expect(parseAgyGenMetadataRow(encodeBytesField(1, encodeBytesField(9, truncatedChatStart)))).toBeNull();
  });

  it('pairs delayed known-owner row usage with its own generation window instead of an unlabeled newer head row (R6-P2-2)', () => {
    let fakeRows: AgyGenMetadataRow[] = [
      // Unlabeled head row 2 created by Turn B (M-B, 1,000,000 window, no usage yet)
      {
        idx: 2,
        summary: {
          maxContextTokens: 1_000_000,
        },
      },
      // Delayed row 1 owned by Turn A (M-A, 128,000 window, 4,500 / 250 usage)
      {
        idx: 1,
        summary: {
          usage: { inputTokens: 4500, outputTokens: 250, cacheReadTokens: 0 },
          maxContextTokens: 128_000,
          modelDisplayName: 'Model A',
          normalizedModelId: 'model-a',
          stepIndices: [0],
        },
      },
    ];

    const tracker = new AgyContextUsageTracker({
      readGenMetadata: () => fakeRows,
      now: () => 20_000,
    });

    // Turn B begins
    tracker.startTurn();

    // During Turn B, delayed Row 1 (`genIdx: 1`, `belongsToCurrentTurn: false`) emits:
    // MUST pair A's 4500/250 numerator with A's 128,000 denominator (never B's 1,000,000!)
    // AND must NOT mark Turn B's `lastTurnStep.emittedWithWindow = true`!
    const delayedEnvA = tracker.buildStepUsageEnvelope(
      { input_tokens: 4500, output_tokens: 250, cache_read_tokens: 0, total_tokens: 4750 },
      'conv-r6-p2-2',
      'model-a',
      {
        genIdx: 1,
        contextWindowTokens: 128_000,
        belongsToCurrentTurn: false,
      },
    );
    expect(delayedEnvA?.usage).toEqual({
      input_tokens: 4500,
      output_tokens: 250,
      context_window: 128_000,
    });

    // Even if `contextWindowTokens` were omitted on the event, `genIdx: 1` + `belongsToCurrentTurn: false`
    // still refuses to borrow unlabeled head row 2's 1,000,000 window.
    const trackerNoExplicitWindow = new AgyContextUsageTracker({
      readGenMetadata: () => fakeRows,
      now: () => 21_000,
    });
    trackerNoExplicitWindow.startTurn();
    const delayedEnvFallback = trackerNoExplicitWindow.buildStepUsageEnvelope(
      { input_tokens: 4500, output_tokens: 250, cache_read_tokens: 0, total_tokens: 4750 },
      'conv-r6-p2-2',
      'model-a',
      {
        genIdx: 1,
        belongsToCurrentTurn: false,
      },
    );
    expect(delayedEnvFallback?.usage).toEqual({
      input_tokens: 4500,
      output_tokens: 250,
      context_window: 128_000,
    });

    // Now Row 2 finishes in SQLite right before Turn B's terminal `reconcileTurnEndEnvelope`:
    // because delayed Row 1 did NOT poison `lastTurnStep` or bump `lastEmittedDbIdx` to 2,
    // Turn B's terminal reconciliation emits Row 2 with B's 1,000,000 window!
    fakeRows = [
      {
        idx: 2,
        summary: {
          usage: { inputTokens: 9200, outputTokens: 600, cacheReadTokens: 0 },
          maxContextTokens: 1_000_000,
        },
      },
      fakeRows[1],
    ];
    const reconciledB = tracker.reconcileTurnEndEnvelope('conv-r6-p2-2', 'model-b');
    expect(reconciledB?.usage).toEqual({
      input_tokens: 9200,
      output_tokens: 600,
      context_window: 1_000_000,
    });
  });

  it('bounds terminal backfill and model-window cache lookups strictly to the step generation without borrowing future denominators (R7-P2-1)', () => {
    // Counterexample 1a (explicit `genIdx: 1`):
    // Generation 1 emits step usage without a context window; SQLite later contains unlabeled
    // Generation 2 (1,000,000) and Generation 1 (128,000). `reconcileTurnEndEnvelope()` MUST emit 128,000!
    let rowsAcp: AgyGenMetadataRow[] = [];
    const trackerAcp = new AgyContextUsageTracker({
      readGenMetadata: () => rowsAcp,
      now: () => 30_000,
    });
    trackerAcp.startTurn();
    const step1NoWin = trackerAcp.buildStepUsageEnvelope(
      { input_tokens: 4100, output_tokens: 210, cache_read_tokens: 0, total_tokens: 4310 },
      'conv-r7-p2-1-acp',
      'model-a',
      { genIdx: 1, belongsToCurrentTurn: true },
    );
    expect(step1NoWin?.usage).toEqual({
      input_tokens: 4100,
      output_tokens: 210,
    });

    rowsAcp = [
      { idx: 2, summary: { maxContextTokens: 1_000_000 } },
      {
        idx: 1,
        summary: {
          usage: { inputTokens: 4100, outputTokens: 210, cacheReadTokens: 0 },
          maxContextTokens: 128_000,
          modelDisplayName: 'Model A',
          normalizedModelId: 'model-a',
        },
      },
    ];
    const backfilledAcp = trackerAcp.reconcileTurnEndEnvelope('conv-r7-p2-1-acp', 'model-a');
    expect(backfilledAcp?.usage).toEqual({
      input_tokens: 4100,
      output_tokens: 210,
      context_window: 128_000,
    });

    // Counterexample 1b (print-mode `stepIndex: 7` correlated strictly via SQLite `stepIndices: [7]`):
    let rowsPrint: AgyGenMetadataRow[] = [];
    const trackerPrint = new AgyContextUsageTracker({
      readGenMetadata: () => rowsPrint,
      now: () => 31_000,
    });
    trackerPrint.startTurn();
    const printStep1 = trackerPrint.buildStepUsageEnvelope(
      { input_tokens: 4100, output_tokens: 210, cache_read_tokens: 0, total_tokens: 4310 },
      'conv-r7-p2-1-print',
      'model-a',
      { stepIndex: 7 },
    );
    expect(printStep1?.usage).toEqual({
      input_tokens: 4100,
      output_tokens: 210,
    });

    rowsPrint = [
      { idx: 2, summary: { maxContextTokens: 1_000_000, stepIndices: [8] } },
      { idx: 1, summary: { maxContextTokens: 128_000, stepIndices: [7] } },
    ];
    const backfilledPrint = trackerPrint.reconcileTurnEndEnvelope('conv-r7-p2-1-print', 'model-a');
    expect(backfilledPrint?.usage).toEqual({
      input_tokens: 4100,
      output_tokens: 210,
      context_window: 128_000,
    });

    // Counterexample 2a (same-model context-window change across generations + cache eviction):
    // Generation 0 observed `gemini-4-argon-high` at 128,000; Generation 2 observed `gemini-4-argon-high`
    // at 1,000,000; Generation 1 (`gemini-4-argon-high`) lacks `maxContextTokens`.
    // Resolving Generation 1 MUST use Generation 0's 128,000 (even if Generation 0 scrolled out of SQLite's
    // `LIMIT 16` slice and exists only in `modelWindowHistory`) and NEVER Generation 2's 1,000,000!
    let rowsSameModel: AgyGenMetadataRow[] = [
      {
        idx: 0,
        summary: {
          usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0 },
          maxContextTokens: 128_000,
          modelDisplayName: 'Gemini 4 Argon (High)',
          normalizedModelId: 'gemini-4-argon-high',
        },
      },
    ];
    const trackerSameModel = new AgyContextUsageTracker({
      readGenMetadata: () => rowsSameModel,
      now: () => 32_000,
    });
    expect(
      trackerSameModel.buildResumeUsageEnvelope('conv-r7-same-model', 'gemini-4-argon-high')?.usage,
    ).toEqual({
      input_tokens: 1000,
      output_tokens: 50,
      context_window: 128_000,
    });

    // Simulate idx=0 scrolling out of active SQLite slice while future idx=2 has 1,000,000 and idx=1 has no window:
    rowsSameModel = [
      {
        idx: 2,
        summary: {
          usage: { inputTokens: 9000, outputTokens: 400, cacheReadTokens: 0 },
          maxContextTokens: 1_000_000,
          modelDisplayName: 'Gemini 4 Argon (High)',
          normalizedModelId: 'gemini-4-argon-high',
        },
      },
      {
        idx: 1,
        summary: {
          usage: { inputTokens: 3500, outputTokens: 150, cacheReadTokens: 0 },
          modelDisplayName: 'Gemini 4 Argon (High)',
          normalizedModelId: 'gemini-4-argon-high',
        },
      },
    ];
    trackerSameModel.startTurn();
    const gen1FromCache = trackerSameModel.buildStepUsageEnvelope(
      { input_tokens: 3500, output_tokens: 150, cache_read_tokens: 0, total_tokens: 3650 },
      'conv-r7-same-model',
      'gemini-4-argon-high',
      { genIdx: 1, belongsToCurrentTurn: true },
    );
    expect(gen1FromCache?.usage).toEqual({
      input_tokens: 3500,
      output_tokens: 150,
      context_window: 128_000,
    });

    // Counterexample 2b (absence of historical evidence must NOT borrow future denominator):
    const rowsFutureOnly: AgyGenMetadataRow[] = [
      {
        idx: 2,
        summary: {
          usage: { inputTokens: 9000, outputTokens: 400, cacheReadTokens: 0 },
          maxContextTokens: 1_000_000,
          modelDisplayName: 'Gemini 4 Argon (High)',
          normalizedModelId: 'gemini-4-argon-high',
        },
      },
      {
        idx: 1,
        summary: {
          usage: { inputTokens: 3500, outputTokens: 150, cacheReadTokens: 0 },
          modelDisplayName: 'Gemini 4 Argon (High)',
          normalizedModelId: 'gemini-4-argon-high',
        },
      },
    ];
    const trackerNoHistory = new AgyContextUsageTracker({
      readGenMetadata: () => rowsFutureOnly,
      now: () => 33_000,
    });
    trackerNoHistory.startTurn();
    const gen1NoHistory = trackerNoHistory.buildStepUsageEnvelope(
      { input_tokens: 3500, output_tokens: 150, cache_read_tokens: 0, total_tokens: 3650 },
      'conv-r7-no-history',
      'gemini-4-argon-high',
      { genIdx: 1, belongsToCurrentTurn: true },
    );
    expect(gen1NoHistory?.usage).toEqual({
      input_tokens: 3500,
      output_tokens: 150,
    });
    expect(
      trackerNoHistory.reconcileTurnEndEnvelope('conv-r7-no-history', 'gemini-4-argon-high'),
    ).toBeNull();
  });

  it('never borrows a future generation context window on unidentified print-mode steps and resolves identical-counter generations strictly by stepIndices (R8-P2-3)', () => {
    // 0. Verify AgyStream carries `stepIndex` on print-mode `step_update` token-count events:
    const streamMessages: any[] = [];
    const stream = new AgyStream(
      (msg) => streamMessages.push(msg),
      () => {},
      'conv-r8-p2-3',
    );
    stream.push(
      `${JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-r8-p2-3',
          step_index: 3,
          step_type: 'agent_response',
          state: 'DONE',
          usage: { input_tokens: 4100, output_tokens: 210, cache_read_tokens: 0 },
        },
      })}\n`,
    );
    const stepTokenMsg = streamMessages.find((m) => m.type === 'token-count' && m.scope === 'step');
    expect(stepTokenMsg).toBeDefined();
    expect(stepTokenMsg.stepIndex).toBe(3);
    expect(stepTokenMsg.usageKey).toBe('conv-r8-p2-3:3');

    // 1. Exact R8-P2-3 counterexample:
    // Print-mode generation-1 usage event (`stepIndex: 3`, no `genIdx`) arrives while SQLite has no metadata row;
    // at terminal reconciliation, SQLite contains ONLY an unlabeled generation-2 row (`maxContextTokens = 1_000_000`)
    // while generation 1's row is still unavailable -> MUST NOT fabricate `1_000_000` denominator!
    let rowsMissingGen1: AgyGenMetadataRow[] = [];
    const trackerMissingGen1 = new AgyContextUsageTracker({
      readGenMetadata: () => rowsMissingGen1,
      now: () => 40_000,
    });
    trackerMissingGen1.startTurn();
    const envStep = trackerMissingGen1.buildStepUsageEnvelope(
      stepTokenMsg.usage,
      'conv-r8-p2-3',
      'model-a',
      { stepIndex: stepTokenMsg.stepIndex },
    );
    expect(envStep?.usage).toEqual({
      input_tokens: 4100,
      output_tokens: 210,
    });

    rowsMissingGen1 = [
      {
        idx: 2,
        summary: {
          maxContextTokens: 1_000_000,
        },
      },
    ];
    expect(trackerMissingGen1.reconcileTurnEndEnvelope('conv-r8-p2-3', 'model-a')).toBeNull();

    // Even if `idx: 2` also has coincidentally identical counters `4100 / 210` without `stepIndices: [3]`,
    // `reconcileTurnEndEnvelope` still refuses to guess generation identity!
    rowsMissingGen1 = [
      {
        idx: 2,
        summary: {
          usage: { inputTokens: 4100, outputTokens: 210, cacheReadTokens: 0 },
          maxContextTokens: 1_000_000,
          stepIndices: [5],
        },
      },
    ];
    expect(trackerMissingGen1.reconcileTurnEndEnvelope('conv-r8-p2-3', 'model-a')).toBeNull();

    // 2. Two generations with IDENTICAL usage counters (`4100 / 210 / 0`) and DIFFERENT windows (`128_000` vs `1_000_000`):
    // `stepIndex: 3` (`idx: 1`) and `stepIndex: 5` (`idx: 2`) resolve strictly to their own generation's denominator!
    const identicalCounterRows: AgyGenMetadataRow[] = [
      {
        idx: 2,
        summary: {
          usage: { inputTokens: 4100, outputTokens: 210, cacheReadTokens: 0 },
          maxContextTokens: 1_000_000,
          stepIndices: [5],
        },
      },
      {
        idx: 1,
        summary: {
          usage: { inputTokens: 4100, outputTokens: 210, cacheReadTokens: 0 },
          maxContextTokens: 128_000,
          stepIndices: [3],
        },
      },
    ];
    const trackerIdentical = new AgyContextUsageTracker({
      readGenMetadata: () => identicalCounterRows,
      now: () => 41_000,
    });
    trackerIdentical.startTurn();
    const g1 = trackerIdentical.buildStepUsageEnvelope(
      { input_tokens: 4100, output_tokens: 210, cache_read_tokens: 0, total_tokens: 4310 },
      'conv-r8-identical',
      'model-a',
      { stepIndex: 3 },
    );
    expect(g1?.usage).toEqual({
      input_tokens: 4100,
      output_tokens: 210,
      context_window: 128_000,
    });

    const g2 = trackerIdentical.buildStepUsageEnvelope(
      { input_tokens: 4100, output_tokens: 210, cache_read_tokens: 0, total_tokens: 4310 },
      'conv-r8-identical',
      'model-b',
      { stepIndex: 5 },
    );
    expect(g2?.usage).toEqual({
      input_tokens: 4100,
      output_tokens: 210,
      context_window: 1_000_000,
    });

    // And an event with NO `genIdx` and NO `stepIndex` never guesses either row:
    const gUnknown = trackerIdentical.buildStepUsageEnvelope(
      { input_tokens: 4100, output_tokens: 210, cache_read_tokens: 0, total_tokens: 4310 },
      'conv-r8-identical',
      'model-a',
    );
    expect(gUnknown?.usage).toEqual({
      input_tokens: 4100,
      output_tokens: 210,
    });
  });

  it('rejects out-of-order print steps and refuses labeled window fallback on unidentified events after high-water mark advances (R9-P2-3)', () => {
    const labeledRows: AgyGenMetadataRow[] = [
      {
        idx: 2,
        summary: {
          usage: { inputTokens: 8200, outputTokens: 400, cacheReadTokens: 0 },
          maxContextTokens: 1_000_000,
          modelDisplayName: 'Model A',
          normalizedModelId: 'model-a',
          stepIndices: [5, 6],
        },
      },
      {
        idx: 1,
        summary: {
          usage: { inputTokens: 3100, outputTokens: 150, cacheReadTokens: 0 },
          maxContextTokens: 128_000,
          modelDisplayName: 'Model A',
          normalizedModelId: 'model-a',
          stepIndices: [3],
        },
      },
    ];

    const tracker = new AgyContextUsageTracker({
      readGenMetadata: () => labeledRows,
      now: () => 50_000,
    });
    tracker.startTurn();

    // 1. Print step 5 arrives first -> resolves to Generation 2 (`1,000,000`) and advances `lastEmittedDbIdx` to 2:
    const envStep5 = tracker.buildStepUsageEnvelope(
      { input_tokens: 8000, output_tokens: 200, cache_read_tokens: 0, total_tokens: 8200 },
      'conv-r9-p2-3',
      'model-a',
      { stepIndex: 5 },
    );
    expect(envStep5?.usage).toEqual({
      input_tokens: 8000,
      output_tokens: 200,
      context_window: 1_000_000,
    });

    // 2. Delayed print step 3 (`idx: 1`) arrives AFTER step 5 (`idx: 2`):
    // Must resolve step 3's true identity (`idx: 1`) BEFORE applying the ordering guard,
    // rejecting the stale event (`null`) instead of borrowing Gen 2's `1,000,000` window!
    const delayedStep3 = tracker.buildStepUsageEnvelope(
      { input_tokens: 3100, output_tokens: 150, cache_read_tokens: 0, total_tokens: 3250 },
      'conv-r9-p2-3',
      'model-a',
      { stepIndex: 3 },
    );
    expect(delayedStep3).toBeNull();

    // 3. Subsequent step 6 within the SAME generation 2 (`stepIndices: [5, 6]`) still resolves cleanly,
    // while delayed replay of step 5 after step 6 is rejected:
    const envStep6 = tracker.buildStepUsageEnvelope(
      { input_tokens: 8200, output_tokens: 400, cache_read_tokens: 0, total_tokens: 8600 },
      'conv-r9-p2-3',
      'model-a',
      { stepIndex: 6 },
    );
    expect(envStep6?.usage).toEqual({
      input_tokens: 8200,
      output_tokens: 400,
      context_window: 1_000_000,
    });
    expect(
      tracker.buildStepUsageEnvelope(
        { input_tokens: 8000, output_tokens: 200, cache_read_tokens: 0, total_tokens: 8200 },
        'conv-r9-p2-3',
        'model-a',
        { stepIndex: 5 },
      ),
    ).toBeNull();

    // 4. An unidentified event (no `genIdx`, no `stepIndex`) with `activeModel = 'model-a'`
    // MUST NOT borrow labeled Generation 2's `1,000,000` window merely because `lastEmittedDbIdx` is 2!
    const unidentified = tracker.buildStepUsageEnvelope(
      { input_tokens: 2900, output_tokens: 90, cache_read_tokens: 0, total_tokens: 2990 },
      'conv-r9-p2-3',
      'model-a',
    );
    expect(unidentified?.usage).toEqual({
      input_tokens: 2900,
      output_tokens: 90,
    });
  });

  it('flushes terminal ERROR_MESSAGE steps without gen_metadata and probes SYSTEM_MESSAGE reactive wakeups', () => {
    const { DatabaseSync } = requireFromHere('node:sqlite');
    const tmpHome = mkdtempSync(join(os.tmpdir(), 'agy-wakeup-probe-'));
    try {
      const convDir = join(tmpHome, 'conversations');
      mkdirSync(convDir, { recursive: true });
      const convId = 'conv-wakeup-probe-1';
      const db = new DatabaseSync(join(convDir, `${convId}.db`));
      db.exec(`
        CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER NOT NULL);
        CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER NOT NULL DEFAULT 0);
      `);

      // Step 1: completed planner step (`step_type = 15, status = 3`)
      db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (1, 15, 3)').run();
      expect(probeAgyAutonomousWakeupState(convId, 1, { agyHomeDir: tmpHome })).toEqual({
        dbExists: true,
        readOk: true,
        hasSystemWakeup: false,
        maxStepIdx: 1,
        latestStep: { idx: 1, stepType: 15, status: 3 },
      });

      // Step 2: terminal ERROR_MESSAGE (`step_type = 17, status = 3`) with NO gen_metadata row
      db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (2, 17, 3)').run();
      expect(checkAgyIdlePlannerStepFinalized(convId, 1, 5, { agyHomeDir: tmpHome })).toEqual({
        finalized: true,
        stepIdx: 2,
        genIdx: 5,
      });

      // Step 3: in-flight PLANNER_RESPONSE (`step_type = 15, status = 8` RUNNING) -> NOT finalized!
      db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (3, 15, 8)').run();
      expect(checkAgyIdlePlannerStepFinalized(convId, 1, 5, { agyHomeDir: tmpHome })).toEqual({
        finalized: false,
      });

      // Step 4: reactive wakeup SYSTEM_MESSAGE (`step_type = 101, status = 3`) after baseline 3
      db.prepare('UPDATE steps SET status = 3 WHERE idx = 3').run();
      db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (4, 101, 3), (5, 15, 8)').run();
      expect(probeAgyAutonomousWakeupState(convId, 3, { agyHomeDir: tmpHome })).toEqual({
        dbExists: true,
        readOk: true,
        hasSystemWakeup: true,
        maxStepIdx: 5,
        latestStep: { idx: 5, stepType: 15, status: 8 },
      });

      db.close();
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
