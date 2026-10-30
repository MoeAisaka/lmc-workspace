import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildExactSizeValidGif,
  buildExactSizeValidJpeg,
  buildExactSizeValidPng,
  buildExactSizeValidWebp,
  isValidGifBytes,
  isValidJpegBytes,
  isValidPngBytes,
  isValidWebpBytes,
  repairCorruptedAgyConversationMedia,
} from './conversationRepair';

const requireFromHere = createRequire(import.meta.url);

function encodeVarint(n: number): Buffer {
  const bytes: number[] = [];
  let v = n;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function makeMediaStepPayload(mime: string, data: Buffer): Buffer {
  const mimeBuf = Buffer.from(mime, 'ascii');
  const inner = Buffer.concat([
    Buffer.from([0x0a, mimeBuf.length]),
    mimeBuf,
    Buffer.from([0x12]),
    encodeVarint(data.length),
    data,
  ]);
  const prefix = Buffer.from('prefix-metadata-before-media"', 'ascii');
  const suffix = Buffer.from('2\x1etype.googleapis.com/ReadFile', 'ascii');
  return Buffer.concat([prefix, encodeVarint(inner.length), inner, suffix]);
}

describe('Antigravity corrupted media detection and exact-size repair', () => {
  it('validates and builds exact-size PNG, JPEG, GIF, and WebP replacements', () => {
    for (const size of [96, 512, 44_997, 44_998]) {
      const png = buildExactSizeValidPng(size);
      expect(png).not.toBeNull();
      expect(png!.length).toBe(size);
      expect(isValidPngBytes(png!)).toBe(true);
      expect(isValidPngBytes(png!.subarray(0, size - 7))).toBe(false);
    }

    for (const size of [200, 201, 202, 203, 45_001]) {
      const jpg = buildExactSizeValidJpeg(size);
      expect(jpg).not.toBeNull();
      expect(jpg!.length).toBe(size);
      expect(isValidJpegBytes(jpg!)).toBe(true);
      expect(isValidJpegBytes(jpg!.subarray(0, size - 2))).toBe(false);
    }

    for (const size of [40, 41, 300, 1024]) {
      const gif = buildExactSizeValidGif(size);
      expect(gif).not.toBeNull();
      expect(gif!.length).toBe(size);
      expect(isValidGifBytes(gif!)).toBe(true);
      expect(isValidGifBytes(gif!.subarray(0, size - 1))).toBe(false);

      const webp = buildExactSizeValidWebp(size);
      expect(webp).not.toBeNull();
      expect(webp!.length).toBe(size);
      expect(isValidWebpBytes(webp!)).toBe(true);
    }
  });

  it('repairs truncated PNG blobs in-place inside SQLite conversation DB without changing payload byte length', () => {
    const { DatabaseSync } = requireFromHere('node:sqlite');
    const tmpHome = mkdtempSync(join(os.tmpdir(), 'agy-repair-test-'));
    try {
      const convId = '47cca48f-7d13-44b7-adea-3bb0373e47eb';
      const convDir = join(tmpHome, 'conversations');
      const mediaLogDir = join(tmpHome, 'brain', convId, '.system_generated', 'logs', 'media');
      mkdirSync(convDir, { recursive: true });
      mkdirSync(mediaLogDir, { recursive: true });

      const dbPath = join(convDir, `${convId}.db`);
      const validPng = buildExactSizeValidPng(1200)!;
      const fullLargePng = buildExactSizeValidPng(60_000)!;
      const truncatedPng = Buffer.from(fullLargePng.subarray(0, 44_997)); // Missing IEND + truncated chunk
      expect(isValidPngBytes(truncatedPng)).toBe(false);

      const mediaFile = join(mediaLogDir, 'step_12256_media_0.png');
      writeFileSync(mediaFile, truncatedPng);

      const validPayload = makeMediaStepPayload('image/png', validPng);
      const poisonedPayload = makeMediaStepPayload('image/png', truncatedPng);

      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');
      const ins = db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)');
      ins.run(100, 132, validPayload);
      ins.run(12256, 132, poisonedPayload);
      db.close();

      const res = repairCorruptedAgyConversationMedia(convId, { agyHomeDir: tmpHome });
      expect(res.repairedCount).toBe(1);
      expect(res.repairedSteps).toEqual([12256]);
      expect(res.backupPath).toBeTruthy();

      // Verify SQLite payload length stayed byte-for-byte identical and image is now valid
      const checkDb = new DatabaseSync(dbPath, { readOnly: true });
      const row100 = Buffer.from(checkDb.prepare('SELECT step_payload FROM steps WHERE idx = 100').get().step_payload);
      const row12256 = Buffer.from(checkDb.prepare('SELECT step_payload FROM steps WHERE idx = 12256').get().step_payload);
      checkDb.close();

      expect(row100.equals(validPayload)).toBe(true);
      expect(row12256.length).toBe(poisonedPayload.length);
      expect(row12256.equals(poisonedPayload)).toBe(false);
      expect(isValidPngBytes(readFileSync(mediaFile))).toBe(true);

      // Second pass must be a no-op
      const second = repairCorruptedAgyConversationMedia(convId, { agyHomeDir: tmpHome });
      expect(second.repairedCount).toBe(0);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
