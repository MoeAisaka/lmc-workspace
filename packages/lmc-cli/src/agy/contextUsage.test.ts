import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionEnvelopeSchema } from 'lmc-wire';
import {
  AgyContextUsageTracker,
  normalizeAgyDisplayModelId,
  parseAgyGenMetadataRow,
  readAgyConversationGenMetadata,
} from './contextUsage';

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
});
