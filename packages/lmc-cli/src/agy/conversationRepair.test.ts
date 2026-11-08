import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  buildExactSizeValidGif,
  buildExactSizeValidJpeg,
  buildExactSizeValidPng,
  buildExactSizeValidWebp,
  inspectGifBytes,
  inspectJpegBytes,
  inspectPngBytes,
  inspectWebpBytes,
  isValidGifBytes,
  isValidJpegBytes,
  isValidPngBytes,
  isValidWebpBytes,
  repairCorruptedAgyConversationMedia,
  sanitizeCorruptedMediaStepPayload,
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

function encodeLenField(fieldNo: number, payload: Buffer): Buffer {
  return Buffer.concat([encodeVarint(fieldNo * 8 + 2), encodeVarint(payload.length), payload]);
}

function encodeVarintField(fieldNo: number, val: number): Buffer {
  return Buffer.concat([encodeVarint(fieldNo * 8), encodeVarint(val)]);
}

function makeExaMediaMessage(mime: string, inlineData: Buffer): Buffer {
  return Buffer.concat([
    encodeLenField(1, Buffer.from(mime, 'utf8')),
    encodeLenField(2, inlineData),
  ]);
}

// Real `.gemini_coder.Step` -> `generic(140)` -> `result(2)` -> `media(4)` wire layout.
function makeGenericMediaStepPayload(mime: string, data: Buffer, textNote = 'Showing binary file'): Buffer {
  const mediaMsg = makeExaMediaMessage(mime, data);
  const genericResult = Buffer.concat([
    encodeLenField(1, Buffer.from(textNote, 'utf8')),
    encodeLenField(4, mediaMsg),
  ]);
  const cortexGeneric = encodeLenField(2, genericResult);
  return Buffer.concat([
    encodeVarintField(1, 132),
    encodeVarintField(4, 3),
    encodeLenField(140, cortexGeneric),
  ]);
}

// Real `.gemini_coder.Step` -> `user_input(19)` -> `media(9)` wire layout.
function makeUserInputMediaStepPayload(mime: string, data: Buffer): Buffer {
  const mediaMsg = makeExaMediaMessage(mime, data);
  const userInput = Buffer.concat([
    encodeLenField(1, Buffer.from('user prompt text', 'utf8')),
    encodeLenField(9, mediaMsg),
  ]);
  return Buffer.concat([
    encodeVarintField(1, 19),
    encodeLenField(19, userInput),
  ]);
}

describe('Antigravity corrupted media detection and exact-size repair', () => {
  it('validates and builds exact-size PNG, JPEG, GIF, and WebP replacements and verifies them with an independent decoder', () => {
    // Reject baseline JPEG missing AC Huffman table 0 even when SOS + EOI markers exist.
    const invalidAcLessJpeg = Buffer.from(
      'ffd8ffe000104a46494600010101006000600000' +
        'ffdb004300' +
        '01'.repeat(64) +
        'ffc0000b080001000101011100' +
        'ffc40014000100000000000000000000000000000000' +
        'ffda0008010100003f007fffe0ffd9',
      'hex',
    );
    expect(isValidJpegBytes(invalidAcLessJpeg)).toBe(false);

    const pngSamples: Buffer[] = [];
    for (const size of [96, 512, 44_997, 44_998]) {
      const png = buildExactSizeValidPng(size);
      expect(png).not.toBeNull();
      expect(png!.length).toBe(size);
      expect(isValidPngBytes(png!)).toBe(true);
      expect(isValidPngBytes(png!.subarray(0, size - 7))).toBe(false);
      pngSamples.push(png!);
    }

    const jpegSamples: Buffer[] = [];
    for (const size of [160, 161, 162, 163, 200, 201, 202, 203, 45_001]) {
      const jpg = buildExactSizeValidJpeg(size);
      expect(jpg).not.toBeNull();
      expect(jpg!.length).toBe(size);
      expect(isValidJpegBytes(jpg!)).toBe(true);
      expect(isValidJpegBytes(jpg!.subarray(0, size - 2))).toBe(false);
      jpegSamples.push(jpg!);
    }

    const gifSamples: Buffer[] = [];
    for (const size of [40, 41, 300, 1024]) {
      const gif = buildExactSizeValidGif(size);
      expect(gif).not.toBeNull();
      expect(gif!.length).toBe(size);
      expect(isValidGifBytes(gif!)).toBe(true);
      expect(isValidGifBytes(gif!.subarray(0, size - 1))).toBe(false);
      gifSamples.push(gif!);
    }

    const webpSamples: Buffer[] = [];
    expect(buildExactSizeValidWebp(40)).toBeNull();
    for (const size of [38, 46, 47, 300, 1024]) {
      const webp = buildExactSizeValidWebp(size);
      expect(webp).not.toBeNull();
      expect(webp!.length).toBe(size);
      expect(isValidWebpBytes(webp!)).toBe(true);
      webpSamples.push(webp!);
    }

    // Independent Pillow (libpng / libjpeg-turbo / GIF / libwebp) pixel decode verification.
    const tmpDecodeDir = mkdtempSync(join(os.tmpdir(), 'agy-img-decode-'));
    try {
      const expectedFiles: Array<{ path: string; fmt: string }> = [];
      pngSamples.forEach((b, i) => {
        const p = join(tmpDecodeDir, `p_${i}.png`);
        writeFileSync(p, b);
        expectedFiles.push({ path: p, fmt: 'PNG' });
      });
      jpegSamples.forEach((b, i) => {
        const p = join(tmpDecodeDir, `j_${i}.jpg`);
        writeFileSync(p, b);
        expectedFiles.push({ path: p, fmt: 'JPEG' });
      });
      gifSamples.forEach((b, i) => {
        const p = join(tmpDecodeDir, `g_${i}.gif`);
        writeFileSync(p, b);
        expectedFiles.push({ path: p, fmt: 'GIF' });
      });
      webpSamples.forEach((b, i) => {
        const p = join(tmpDecodeDir, `w_${i}.webp`);
        writeFileSync(p, b);
        expectedFiles.push({ path: p, fmt: 'WEBP' });
      });
      const invalidPath = join(tmpDecodeDir, 'invalid_ac_less.jpg');
      writeFileSync(invalidPath, invalidAcLessJpeg);

      const pyCheck = spawnSync(
        'python3',
        [
          '-c',
          `
import json, sys
from PIL import Image

def collect_dht_classes(raw: bytes):
    pos = 2
    classes = set()
    while pos + 4 <= len(raw) and raw[pos] == 0xFF:
        while pos < len(raw) and raw[pos] == 0xFF:
            pos += 1
        marker = raw[pos]
        pos += 1
        if marker == 0xDA or marker == 0xD9:
            break
        seg_len = (raw[pos] << 8) | raw[pos + 1]
        seg = raw[pos + 2 : pos + seg_len]
        if marker == 0xC4 and len(seg) >= 17:
            classes.add((seg[0] >> 4, seg[0] & 0x0F))
        pos += seg_len
    return classes

items = json.loads(sys.argv[1])
bad_jpg = sys.argv[2]
for item in items:
    raw = open(item["path"], "rb").read()
    if item["fmt"] == "JPEG":
        dht = collect_dht_classes(raw)
        assert (0, 0) in dht and (1, 0) in dht, f"Missing DC0/AC0 DHT: {dht}"
    with Image.open(item["path"]) as im:
        im.load()
        assert im.format == item["fmt"], (item, im.format)
        assert im.size == (1, 1), (item, im.size)
bad_dht = collect_dht_classes(open(bad_jpg, "rb").read())
assert (1, 0) not in bad_dht, f"Expected missing AC0 DHT in negative fixture: {bad_dht}"
print("DECODE_OK")
`,
          JSON.stringify(expectedFiles),
          invalidPath,
        ],
        { encoding: 'utf8' },
      );
      expect(pyCheck.stderr).toBe('');
      expect(pyCheck.status).toBe(0);
      expect(pyCheck.stdout).toContain('DECODE_OK');
    } finally {
      rmSync(tmpDecodeDir, { recursive: true, force: true });
    }
  });

  it('never overwrites matching MIME signatures inside text, tool output, or unknown protobuf fields', () => {
    const fakeMediaBytesInText = Buffer.concat([
      Buffer.from('\x0a\x09image/png\x12', 'binary'),
      Buffer.from([100]),
      Buffer.alloc(100, 0x41),
    ]);

    // 1. Direct top-level string field (field 1, not a Step media path)
    const rawTextEnvelope = encodeLenField(1, fakeMediaBytesInText);
    expect(sanitizeCorruptedMediaStepPayload(rawTextEnvelope)).toEqual({
      updatedPayload: null,
      repairedMedia: [],
    });

    // 2. Signature inside `Step.generic(140).result(2).text(1)` and `Step.run_command(28)` output
    const genericResultWithTextOnly = encodeLenField(1, fakeMediaBytesInText);
    const stepWithToolText = Buffer.concat([
      encodeVarintField(1, 132),
      encodeLenField(140, encodeLenField(2, genericResultWithTextOnly)),
      encodeLenField(28, encodeLenField(4, fakeMediaBytesInText)),
      encodeLenField(999, fakeMediaBytesInText),
    ]);
    expect(sanitizeCorruptedMediaStepPayload(stepWithToolText)).toEqual({
      updatedPayload: null,
      repairedMedia: [],
    });

    // 3. Truncated / malformed outer protobuf framing fails closed without mutating valid-looking inner media
    const truncatedPng = Buffer.alloc(120, 0x42);
    const validStep = makeUserInputMediaStepPayload('image/png', truncatedPng);
    const malformedStep = Buffer.concat([validStep, Buffer.from([0x80, 0x80])]);
    expect(sanitizeCorruptedMediaStepPayload(malformedStep)).toEqual({
      updatedPayload: null,
      repairedMedia: [],
    });
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
      const truncatedPng = Buffer.from(fullLargePng.subarray(0, 44_997));
      expect(isValidPngBytes(truncatedPng)).toBe(false);

      const mediaFile = join(mediaLogDir, 'step_12256_media_0.png');
      writeFileSync(mediaFile, truncatedPng);

      const validPayload = makeGenericMediaStepPayload('image/png', validPng);
      const poisonedPayload = makeGenericMediaStepPayload('image/png', truncatedPng);
      const textDecoyPayload = encodeLenField(
        140,
        encodeLenField(
          2,
          encodeLenField(
            1,
            Buffer.concat([
              Buffer.from('\x0a\x09image/png\x12', 'binary'),
              Buffer.from([100]),
              Buffer.alloc(100, 0x41),
            ]),
          ),
        ),
      );

      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');
      const ins = db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)');
      ins.run(100, 132, validPayload);
      ins.run(200, 132, textDecoyPayload);
      ins.run(12256, 132, poisonedPayload);
      db.close();

      const res = repairCorruptedAgyConversationMedia(convId, { agyHomeDir: tmpHome });
      expect(res.repairedCount).toBe(1);
      expect(res.repairedSteps).toEqual([12256]);
      expect(res.backupPath).toBeTruthy();

      const checkDb = new DatabaseSync(dbPath, { readOnly: true });
      const row100 = Buffer.from(checkDb.prepare('SELECT step_payload FROM steps WHERE idx = 100').get().step_payload);
      const row200 = Buffer.from(checkDb.prepare('SELECT step_payload FROM steps WHERE idx = 200').get().step_payload);
      const row12256 = Buffer.from(checkDb.prepare('SELECT step_payload FROM steps WHERE idx = 12256').get().step_payload);
      checkDb.close();

      expect(row100.equals(validPayload)).toBe(true);
      expect(row200.equals(textDecoyPayload)).toBe(true);
      expect(row12256.length).toBe(poisonedPayload.length);
      expect(row12256.equals(poisonedPayload)).toBe(false);
      expect(isValidPngBytes(readFileSync(mediaFile))).toBe(true);

      const second = repairCorruptedAgyConversationMedia(convId, { agyHomeDir: tmpHome });
      expect(second.repairedCount).toBe(0);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('creates a standalone WAL-complete backup that restores uncheckpointed SIGKILL writer steps', () => {
    const { DatabaseSync } = requireFromHere('node:sqlite');
    const tmpHome = mkdtempSync(join(os.tmpdir(), 'agy-repair-wal-'));
    const restoreDir = mkdtempSync(join(os.tmpdir(), 'agy-restore-wal-'));
    try {
      const convId = 'wal-sigkill-conv-1';
      const convDir = join(tmpHome, 'conversations');
      mkdirSync(convDir, { recursive: true });
      const dbPath = join(convDir, `${convId}.db`);

      const truncatedPng = Buffer.alloc(150, 0x55);
      const poisonedPayload = makeUserInputMediaStepPayload('image/png', truncatedPng);
      const payloadFile = join(tmpHome, 'poisoned.bin');
      writeFileSync(payloadFile, poisonedPayload);

      // Child writes in WAL mode with wal_autocheckpoint=0 and SIGKILLs itself without closing SQLite.
      const writerScript = `
        const fs = require('node:fs');
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(${JSON.stringify(dbPath)});
        db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
        db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');
        const ins = db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)');
        ins.run(1, 19, fs.readFileSync(${JSON.stringify(payloadFile)}));
        process.kill(process.pid, 'SIGKILL');
      `;
      const childRes = spawnSync(process.execPath, ['-e', writerScript]);
      expect(childRes.signal).toBe('SIGKILL');
      expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);

      const res = repairCorruptedAgyConversationMedia(convId, { agyHomeDir: tmpHome });
      expect(res.repairedCount).toBe(1);
      expect(res.repairedSteps).toEqual([1]);
      expect(res.backupPath).toBeTruthy();

      // Copy ONLY the standalone `.db.bak` file into an isolated directory without `-wal`
      // and verify it restores the exact pre-repair uncheckpointed step bytes.
      const restoredDbPath = join(restoreDir, 'restored.db');
      copyFileSync(res.backupPath!, restoredDbPath);
      const restoredDb = new DatabaseSync(restoredDbPath, { readOnly: true });
      const restoredRow = Buffer.from(
        restoredDb.prepare('SELECT step_payload FROM steps WHERE idx = 1').get().step_payload,
      );
      restoredDb.close();
      expect(restoredRow.equals(poisonedPayload)).toBe(true);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
      rmSync(restoreDir, { recursive: true, force: true });
    }
  });

  it('preserves valid multi-scan sequential baseline SOF0 JPEGs untouched during media repair (R6-P2-3)', () => {
    // 8x8 RGB baseline SOF0 (0xC0) JPEG encoded by libjpeg-turbo `cjpeg -scans "0;\n1;\n2;\n"`:
    // 3 non-interleaved sequential SOS scans (Y, Cb, Cr) with intervening chroma DHT tables after SOS(Y).
    const multiScanSof0RgbJpeg = Buffer.from(
      'ffd8ffe000104a46494600010100000100010000' +
        'ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432' +
        'ffdb0043010909090c0b0c180d0d1832211c213232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232' +
        'ffc00011080008000803012200021101031101' +
        'ffc4001f0000010501010101010100000000000000000102030405060708090a0b' +
        'ffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa' +
        'ffda0008010100003f006687e0658915de2c01edd6bf' +
        'ffc4001f0100030101010101010101010000000000000102030405060708090a0b' +
        'ffc400b51100020102040403040705040400010277000102031104052131061241510761711322328108144291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9fa' +
        'ffda0008010211003f00f1337cf71782aea8d1b5ac9edea7' +
        'ffda0008010311003f005916678996113723ffd9',
      'hex',
    );

    expect(multiScanSof0RgbJpeg.length).toBe(675);
    expect(isValidJpegBytes(multiScanSof0RgbJpeg)).toBe(true);
    // Truncated multi-scan SOF0 JPEG is still rejected as corrupt
    expect(isValidJpegBytes(multiScanSof0RgbJpeg.subarray(0, multiScanSof0RgbJpeg.length - 3))).toBe(false);

    // Independent Pillow (libjpeg-turbo) pixel decode verification of the multi-scan SOF0 fixture
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'agy-multiscan-sof0-'));
    try {
      const jpgPath = join(tmpDir, 'multiscan_sof0.jpg');
      writeFileSync(jpgPath, multiScanSof0RgbJpeg);
      const pyRes = spawnSync(
        'python3',
        [
          '-c',
          `
import sys
from PIL import Image
with Image.open(sys.argv[1]) as im:
    im.load()
    assert im.format == "JPEG" and im.mode == "RGB" and im.size == (8, 8)
print("MULTISCAN_SOF0_OK")
`,
          jpgPath,
        ],
        { encoding: 'utf8' },
      );
      expect(pyRes.stderr).toBe('');
      expect(pyRes.status).toBe(0);
      expect(pyRes.stdout).toContain('MULTISCAN_SOF0_OK');

      // Ensure `sanitizeCorruptedMediaStepPayload` and `repairCorruptedAgyConversationMedia` preserve
      // the valid multi-scan SOF0 JPEG byte-for-byte while repairing an adjacent corrupted JPEG!
      const validMultiScanStep = makeGenericMediaStepPayload('image/jpeg', multiScanSof0RgbJpeg);
      expect(sanitizeCorruptedMediaStepPayload(validMultiScanStep)).toEqual({
        updatedPayload: null,
        repairedMedia: [],
      });

      const truncatedMultiScan = Buffer.from(multiScanSof0RgbJpeg.subarray(0, 500));
      const corruptedStep = makeUserInputMediaStepPayload('image/jpeg', truncatedMultiScan);

      const { DatabaseSync } = requireFromHere('node:sqlite');
      const convId = 'r6-multiscan-sof0-conv';
      const convDir = join(tmpDir, 'conversations');
      mkdirSync(convDir, { recursive: true });
      const dbPath = join(convDir, `${convId}.db`);
      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');
      const ins = db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)');
      ins.run(10, 132, validMultiScanStep);
      ins.run(11, 19, corruptedStep);
      db.close();

      const rep = repairCorruptedAgyConversationMedia(convId, { agyHomeDir: tmpDir });
      expect(rep.repairedCount).toBe(1);
      expect(rep.repairedSteps).toEqual([11]);

      const checkDb = new DatabaseSync(dbPath, { readOnly: true });
      const row10 = Buffer.from(checkDb.prepare('SELECT step_payload FROM steps WHERE idx = 10').get().step_payload);
      const row11 = Buffer.from(checkDb.prepare('SELECT step_payload FROM steps WHERE idx = 11').get().step_payload);
      checkDb.close();

      expect(row10.equals(validMultiScanStep)).toBe(true);
      expect(row11.length).toBe(corruptedStep.length);
      expect(row11.equals(corruptedStep)).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite concurrent SQLite writer mutations after backup verification and verifies backups by digest (R7-P1-1)', () => {
    const { DatabaseSync } = requireFromHere('node:sqlite');
    const tmpHome = mkdtempSync(join(os.tmpdir(), 'agy-repair-cas-'));
    try {
      const convId = 'r7-concurrent-writer-conv';
      const convDir = join(tmpHome, 'conversations');
      mkdirSync(convDir, { recursive: true });
      const dbPath = join(convDir, `${convId}.db`);

      const truncatedPng = Buffer.alloc(180, 0x42);
      const poisonedPayloadP = makeGenericMediaStepPayload('image/png', truncatedPng);
      const untargetedPayload = encodeLenField(1, Buffer.from('original-text-payload-same-len', 'utf8'));
      expect(isValidPngBytes(truncatedPng)).toBe(false);

      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');
      const ins = db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)');
      ins.run(1, 14, untargetedPayload);
      ins.run(2, 132, poisonedPayloadP);
      db.close();

      // Case A: Concurrent writer commits payload Q (same byte length as P!) at targeted idx=2
      // AFTER backup verification and BEFORE repair's `BEGIN IMMEDIATE` transaction.
      const concurrentValidPng = buildExactSizeValidPng(truncatedPng.length)!;
      const concurrentPayloadQ = makeGenericMediaStepPayload('image/png', concurrentValidPng);
      expect(concurrentPayloadQ.length).toBe(poisonedPayloadP.length);

      const logsA: string[] = [];
      const resA = repairCorruptedAgyConversationMedia(convId, {
        agyHomeDir: tmpHome,
        log: (m) => logsA.push(m),
        afterBackupVerifiedBeforeWrite: () => {
          const writer2 = new DatabaseSync(dbPath);
          writer2.prepare('UPDATE steps SET step_payload = ? WHERE idx = 2').run(concurrentPayloadQ);
          writer2.close();
        },
      });
      expect(resA).toEqual({ repairedCount: 0, repairedSteps: [] });
      expect(logsA.some((m) => m.includes('changed concurrently'))).toBe(true);

      // Concurrent writer's payload Q MUST survive untouched, and uncommitted backup must be cleaned up!
      const backupDir = join(tmpHome, 'cache', 'media-repair-backups');
      expect(existsSync(backupDir) ? readdirSync(backupDir) : []).toEqual([]);

      const checkA = new DatabaseSync(dbPath, { readOnly: true });
      const survivingRow2 = Buffer.from(
        checkA.prepare('SELECT step_payload FROM steps WHERE idx = 2').get().step_payload,
      );
      checkA.close();
      expect(survivingRow2.equals(concurrentPayloadQ)).toBe(true);

      // Case B: Reset targeted idx=2 back to P, then have a concurrent writer make a same-length
      // 1-byte mutation on untargeted idx=1 after backup verification -> repair must ALSO abort
      // so the standalone backup never diverges from pre-transaction database state!
      const resetDb = new DatabaseSync(dbPath);
      resetDb.prepare('UPDATE steps SET step_payload = ? WHERE idx = 2').run(poisonedPayloadP);
      resetDb.close();

      const mutatedUntargetedSameLen = encodeLenField(
        1,
        Buffer.from('mutated!-text-payload-same-len', 'utf8'),
      );
      expect(mutatedUntargetedSameLen.length).toBe(untargetedPayload.length);

      const resB = repairCorruptedAgyConversationMedia(convId, {
        agyHomeDir: tmpHome,
        afterBackupVerifiedBeforeWrite: () => {
          const writer2 = new DatabaseSync(dbPath);
          writer2.prepare('UPDATE steps SET step_payload = ? WHERE idx = 1').run(mutatedUntargetedSameLen);
          writer2.close();
        },
      });
      expect(resB).toEqual({ repairedCount: 0, repairedSteps: [] });
      expect(existsSync(backupDir) ? readdirSync(backupDir) : []).toEqual([]);

      const checkB = new DatabaseSync(dbPath, { readOnly: true });
      const row1AfterB = Buffer.from(
        checkB.prepare('SELECT step_payload FROM steps WHERE idx = 1').get().step_payload,
      );
      const row2AfterB = Buffer.from(
        checkB.prepare('SELECT step_payload FROM steps WHERE idx = 2').get().step_payload,
      );
      checkB.close();
      expect(row1AfterB.equals(mutatedUntargetedSameLen)).toBe(true);
      expect(row2AfterB.equals(poisonedPayloadP)).toBe(true);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('rejects malformed progressive scans, incomplete sequential component scans, and invalid component selectors while accepting real SOF1 and progressive SOF2 JPEGs (R7-P2-3)', () => {
    // 1. Direct R7-P2-3 counterexample: `buildExactSizeValidJpeg(160)` with SOF0 (FF C0) mutated to
    // SOF2 (FF C2) while keeping baseline SOS `Ss=0, Se=63, AhAl=0` MUST be rejected and repaired!
    const baseline160 = buildExactSizeValidJpeg(160)!;
    const sof0Idx = baseline160.indexOf(Buffer.from([0xff, 0xc0]));
    expect(sof0Idx).toBeGreaterThan(0);

    const bogusProgressiveSof2 = Buffer.from(baseline160);
    bogusProgressiveSof2[sof0Idx + 1] = 0xc2;
    expect(isValidJpegBytes(bogusProgressiveSof2)).toBe(false);

    // Unsupported SOF3 / SOF9 frame markers are NOT valid supported DCT JPEGs (`isValidJpegBytes === false`),
    // but intact containers ending cleanly at EOI are classified as `'unsupported'` (preserved, NOT destructively
    // replaced), whereas truncated unsupported frames missing EOI are classified as `'corrupt'` and repaired!
    for (const unsupportedSof of [0xc3, 0xc9]) {
      const bogusSof = Buffer.from(baseline160);
      bogusSof[sof0Idx + 1] = unsupportedSof;
      expect(isValidJpegBytes(bogusSof)).toBe(false);
      expect(inspectJpegBytes(bogusSof)).toBe('unsupported');
      expect(sanitizeCorruptedMediaStepPayload(makeGenericMediaStepPayload('image/jpeg', bogusSof))).toEqual({
        updatedPayload: null,
        repairedMedia: [],
      });
      const truncatedUnsupported = bogusSof.subarray(0, bogusSof.length - 3);
      expect(inspectJpegBytes(truncatedUnsupported)).toBe('corrupt');
    }

    // Unknown component selector in SOS (Cs=2 when SOF0 only declared Ci=1) is rejected.
    const sosIdx160 = baseline160.indexOf(Buffer.from([0xff, 0xda]));
    expect(sosIdx160).toBeGreaterThan(0);
    const unknownCompJpeg = Buffer.from(baseline160);
    unknownCompJpeg[sosIdx160 + 5] = 0x02;
    expect(isValidJpegBytes(unknownCompJpeg)).toBe(false);

    // Repair sanitizes `bogusProgressiveSof2` in-place to a valid 160-byte baseline JPEG.
    const malformedStep = makeUserInputMediaStepPayload('image/jpeg', bogusProgressiveSof2);
    const sanitized = sanitizeCorruptedMediaStepPayload(malformedStep);
    expect(sanitized.repairedMedia).toHaveLength(1);
    expect(sanitized.repairedMedia[0].replacement.length).toBe(160);
    expect(isValidJpegBytes(sanitized.repairedMedia[0].replacement)).toBe(true);

    // 2. Real libjpeg-turbo SOF1 fixtures (interleaved 1-scan 16-bit DQT + non-interleaved 3-scan)
    // and real 10-scan progressive SOF2 RGB fixture.
    const realInterleavedSof1Jpeg = Buffer.from(
      'ffd8ffe000104a46494600010100000100010000' +
        'ffdb008310001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010012c' +
        'ffdb00430112121212121212121212121212121212121212121212121212121212121212121212121212121212121212121212121212121212121212121212121212121212' +
        'ffc10011080008000803011100021101031101' +
        'ffc4001f0000010501010101010100000000000000000102030405060708090a0b' +
        'ffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa' +
        'ffc4001f0100030101010101010101010000000000000102030405060708090a0b' +
        'ffc400b51100020102040403040705040400010277000102031104052131061241510761711322328108144291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9fa' +
        'ffda000c03010002110311003f00ceb78acfc993fd1ee7fd53ff00cb38bfb87fe9b55d0a75b9e1fbca5f147ed4fbafee0e84f11f56affbda3fc0abf6e7ff003ee5ff004ecfffd9',
      'hex',
    );
    const realMultiScanSof1Jpeg = Buffer.from(
      'ffd8ffe000104a46494600010100000100010000' +
        'ffdb008310001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010001000100010012c' +
        'ffc10011080008000803012200021100031100' +
        'ffc4001f0000010501010101010100000000000000000102030405060708090a0b' +
        'ffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa' +
        'ffda0008010100003f00c8af' +
        'ffc4001f0100030101010101010101010000000000000102030405060708090a0b' +
        'ffc400b51100020102040403040705040400010277000102031104052131061241510761711322328108144291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9fa' +
        'ffda0008010211003f00fa23' +
        'ffda0008010311003f00ee3fffd9',
      'hex',
    );
    const realProgressiveSof2Jpeg = Buffer.from(
      'ffd8ffe000104a46494600010100000100010000' +
        'ffdb0043000503040404030504040405050506070c08070707070f0b0b090c110f1212110f111113161c1713141a1511111821181a1d1d1f1f1f13172224221e241c1e1f1e' +
        'ffdb0043010505050706070e08080e1e1411141e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e' +
        'ffc20011080008000803012200021101031101' +
        'ffc4001500010100000000000000000000000000000005' +
        'ffc4001501010100000000000000000000000000000304' +
        'ffda000c030100021003100000019a295f' +
        'ffc4001510010100000000000000000000000000000500' +
        'ffda000801010001050238ab' +
        'ffc400191100010500000000000000000000000000050001041421' +
        'ffda0008010301013f01104e4566d5' +
        'ffc40017110100030000000000000000000000000001000312' +
        'ffda0008010201013f01a9733f' +
        'ffc400161000030000000000000000000000000000000122' +
        'ffda0008010100063f02527f' +
        'ffc40015100101000000000000000000000000000000f1' +
        'ffda0008010100013f2188' +
        'ffda000c0301000200030000001003' +
        'ffc40014110100000000000000000000000000000000' +
        'ffda0008010301013f1037' +
        'ffc4001511010100000000000000000000000000000011' +
        'ffda0008010201013f1098' +
        'ffc40015100101000000000000000000000000000000a1' +
        'ffda0008010100013f10827fffd9',
      'hex',
    );

    expect(isValidJpegBytes(realInterleavedSof1Jpeg)).toBe(true);
    expect(isValidJpegBytes(realMultiScanSof1Jpeg)).toBe(true);
    expect(isValidJpegBytes(realProgressiveSof2Jpeg)).toBe(true);

    // Duplicate component selector within a single interleaved SOS ([1, 2, 3] -> [1, 1, 3]) is rejected.
    const dupInterleavedSof1 = Buffer.from(realInterleavedSof1Jpeg);
    const sof1SosIdx = dupInterleavedSof1.indexOf(Buffer.from([0xff, 0xda, 0x00, 0x0c, 0x03]));
    expect(sof1SosIdx).toBeGreaterThan(0);
    dupInterleavedSof1[sof1SosIdx + 7] = 0x01;
    expect(isValidJpegBytes(dupInterleavedSof1)).toBe(false);

    // 16-bit DQT (`Pq=1`) downgraded from SOF1 to baseline SOF0 (`FF C0`) is rejected per ITU-T T.81 Table B.2.
    const illegal16BitDqtSof0 = Buffer.from(realInterleavedSof1Jpeg);
    const sof1HdrIdx = illegal16BitDqtSof0.indexOf(Buffer.from([0xff, 0xc1, 0x00, 0x11]));
    expect(sof1HdrIdx).toBeGreaterThan(0);
    illegal16BitDqtSof0[sof1HdrIdx + 1] = 0xc0;
    expect(isValidJpegBytes(illegal16BitDqtSof0)).toBe(false);

    // Missing sequential component scans: retaining only the 1st component scan + EOI on 3-component
    // multi-scan SOF1 (and SOF0) MUST be rejected because components 2 & 3 were never scanned!
    const secondSosIdx = realMultiScanSof1Jpeg.indexOf(
      Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x02]),
    );
    expect(secondSosIdx).toBeGreaterThan(0);
    const incompleteOneScanSof1 = Buffer.concat([
      realMultiScanSof1Jpeg.subarray(0, secondSosIdx),
      Buffer.from([0xff, 0xd9]),
    ]);
    expect(isValidJpegBytes(incompleteOneScanSof1)).toBe(false);

    const incompleteOneScanSof0 = Buffer.from(incompleteOneScanSof1);
    // Also verify on a pure 8-bit DQT 3-component SOF0 truncated after scan 1 + EOI:
    const multiScanSof0 = Buffer.from(
      'ffd8ffe000104a46494600010100000100010000' +
        'ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432' +
        'ffdb0043010909090c0b0c180d0d1832211c213232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232' +
        'ffc00011080008000803012200021101031101' +
        'ffc4001f0000010501010101010100000000000000000102030405060708090a0b' +
        'ffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa' +
        'ffda0008010100003f006687e0658915de2c01edd6bfffd9',
      'hex',
    );
    expect(incompleteOneScanSof0.length).toBeGreaterThan(0);
    expect(isValidJpegBytes(multiScanSof0)).toBe(false);

    // Duplicate sequential component scan across multiple SOS segments (scanning component 1 twice, omitting 3) is rejected.
    const dupMultiScanSof1 = Buffer.from(realMultiScanSof1Jpeg);
    const thirdSosIdx = dupMultiScanSof1.indexOf(
      Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x03]),
    );
    expect(thirdSosIdx).toBeGreaterThan(0);
    dupMultiScanSof1[thirdSosIdx + 5] = 0x01;
    expect(isValidJpegBytes(dupMultiScanSof1)).toBe(false);

    // Valid lower-precision progressive SOF2: removing the final luminance AC refinement scan
    // (at its preceding DHT marker boundary) + EOI leaves luminance AC at Al=1 while all components'
    // DC scans are present -> MUST be accepted as `'valid'` and preserved (R8-P2-1)!
    const lastProgDhtBeforeFinalSosIdx = realProgressiveSof2Jpeg.lastIndexOf(
      Buffer.from([0xff, 0xc4, 0x00, 0x15, 0x10]),
    );
    expect(lastProgDhtBeforeFinalSosIdx).toBeGreaterThan(0);
    const lowerPrecisionProgressiveSof2 = Buffer.concat([
      realProgressiveSof2Jpeg.subarray(0, lastProgDhtBeforeFinalSosIdx),
      Buffer.from([0xff, 0xd9]),
    ]);
    expect(inspectJpegBytes(lowerPrecisionProgressiveSof2)).toBe('valid');
    expect(isValidJpegBytes(lowerPrecisionProgressiveSof2)).toBe(true);

    // Conversely, a 3-component non-interleaved progressive SOF2 truncated before component 3's DC scan + EOI
    // MUST be rejected as `'corrupt'`, while the complete 3-scan DC-only (`Al=1`, zero AC) image is `'valid'`!
    const dcOnly3ScanProgressiveSof2 = Buffer.from(
      'ffd8ffe000104a46494600010100000100010000' +
        'ffdb0043000503040404030504040405050506070c08070707070f0b0b090c110f1212110f111113161c1713141a1511111821181a1d1d1f1f1f13172224221e241c1e1f1e' +
        'ffdb0043010505050706070e08080e1e1411141e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e' +
        'ffc20011080008000803012200021101031101' +
        'ffc40014000100000000000000000000000000000005ffda000801010000000113' +
        'ffc40014010100000000000000000000000000000006ffda000801021000000169' +
        'ffc40014010100000000000000000000000000000004ffda000801031000000177ffd9',
      'hex',
    );
    expect(isValidJpegBytes(dcOnly3ScanProgressiveSof2)).toBe(true);
    const missingComp3DcIdx = dcOnly3ScanProgressiveSof2.lastIndexOf(
      Buffer.from([0xff, 0xc4, 0x00, 0x14, 0x01]),
    );
    expect(missingComp3DcIdx).toBeGreaterThan(0);
    const missingDcCompProgressiveSof2 = Buffer.concat([
      dcOnly3ScanProgressiveSof2.subarray(0, missingComp3DcIdx),
      Buffer.from([0xff, 0xd9]),
    ]);
    expect(inspectJpegBytes(missingDcCompProgressiveSof2)).toBe('corrupt');
    expect(isValidJpegBytes(missingDcCompProgressiveSof2)).toBe(false);

    // Reduced-precision 16x16 RGB progressive SOF2 encoded via cjpeg scan script
    // (`0, 1, 2: 0-0, 0, 1; 0: 1-15, 0, 1; 1: 1-8, 0, 1; 2: 1-8, 0, 1;` — DC at Al=1, AC bands truncated at 15/8 and Al=1):
    const reducedPrecisionScanScriptSof2 = Buffer.from(
      'ffd8ffe000104a46494600010100000100010000' +
        'ffdb0043000503040404030504040405050506070c08070707070f0b0b090c110f1212110f111113161c1713141a1511111821181a1d1d1f1f1f13172224221e241c1e1f1e' +
        'ffdb0043010505050706070e08080e1e1411141e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e' +
        'ffc20011080010001003012200021101031101' +
        'ffc4001500010100000000000000000000000000000304' +
        'ffc40014010100000000000000000000000000000000' +
        'ffda000c030100021003100000019ee233' +
        'ffc4001c1000020300030100000000000000000000020301040500121315' +
        'ffda0008010100010f01cb5e1655107a92eba421395f50c0ec0d545519e4bb4af5bf0a19e8ae88e6e212e78d4d5d6efd183f' +
        'ffc40017110100030000000000000000000000000001001121' +
        'ffda000801020101080175a9' +
        'ffc400161101010100000000000000000000000000010011' +
        'ffda0008010301010801706fffd9',
      'hex',
    );
    expect(inspectJpegBytes(reducedPrecisionScanScriptSof2)).toBe('valid');
    expect(isValidJpegBytes(reducedPrecisionScanScriptSof2)).toBe(true);

    // Independent Pillow decode check on valid SOF1 / full & reduced-precision SOF2 fixtures + byte-for-byte preservation under BOTH payload sanitization and SQLite repair!
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'agy-sof1-sof2-'));
    try {
      const p1 = join(tmpDir, 'sof1_interleaved.jpg');
      const p2 = join(tmpDir, 'sof1_multiscan.jpg');
      const p3 = join(tmpDir, 'sof2_prog.jpg');
      const p4 = join(tmpDir, 'sof2_lower_prec.jpg');
      const p5 = join(tmpDir, 'sof2_scan_script_reduced.jpg');
      writeFileSync(p1, realInterleavedSof1Jpeg);
      writeFileSync(p2, realMultiScanSof1Jpeg);
      writeFileSync(p3, realProgressiveSof2Jpeg);
      writeFileSync(p4, lowerPrecisionProgressiveSof2);
      writeFileSync(p5, reducedPrecisionScanScriptSof2);

      const pyRes = spawnSync(
        'python3',
        [
          '-c',
          `
import sys
from PIL import Image
expected = [
    (sys.argv[1], (8, 8)),
    (sys.argv[2], (8, 8)),
    (sys.argv[3], (8, 8)),
    (sys.argv[4], (8, 8)),
    (sys.argv[5], (16, 16)),
]
for p, sz in expected:
    with Image.open(p) as im:
        im.load()
        assert im.format == "JPEG" and im.mode == "RGB" and im.size == sz, (p, im.format, im.mode, im.size)
print("SOF1_SOF2_DECODE_OK")
`,
          p1,
          p2,
          p3,
          p4,
          p5,
        ],
        { encoding: 'utf8' },
      );
      expect(pyRes.stderr).toBe('');
      expect(pyRes.status).toBe(0);
      expect(pyRes.stdout).toContain('SOF1_SOF2_DECODE_OK');

      for (const validFixture of [
        realInterleavedSof1Jpeg,
        realMultiScanSof1Jpeg,
        realProgressiveSof2Jpeg,
        lowerPrecisionProgressiveSof2,
        reducedPrecisionScanScriptSof2,
      ]) {
        expect(sanitizeCorruptedMediaStepPayload(makeGenericMediaStepPayload('image/jpeg', validFixture))).toEqual({
          updatedPayload: null,
          repairedMedia: [],
        });
      }

      // Verify SQLite repair preserves reduced-precision progressive SOF2 + unsupported SOF3 byte-for-byte while repairing adjacent corrupt JPEG!
      const { DatabaseSync } = requireFromHere('node:sqlite');
      const convId = 'r8-p2-1-prog-preserve';
      const convDir = join(tmpDir, 'conversations');
      mkdirSync(convDir, { recursive: true });
      const dbPath = join(convDir, `${convId}.db`);
      const reducedStep = makeGenericMediaStepPayload('image/jpeg', reducedPrecisionScanScriptSof2);
      const unsupportedSof3 = Buffer.from(baseline160);
      unsupportedSof3[sof0Idx + 1] = 0xc3;
      const unsupportedStep = makeGenericMediaStepPayload('image/jpeg', unsupportedSof3);
      const corruptStep = makeUserInputMediaStepPayload('image/jpeg', missingDcCompProgressiveSof2);

      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');
      const ins = db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)');
      ins.run(1, 132, reducedStep);
      ins.run(2, 132, unsupportedStep);
      ins.run(3, 19, corruptStep);
      db.close();

      const rep = repairCorruptedAgyConversationMedia(convId, { agyHomeDir: tmpDir });
      expect(rep.repairedCount).toBe(1);
      expect(rep.repairedSteps).toEqual([3]);

      const checkDb = new DatabaseSync(dbPath, { readOnly: true });
      const r1 = Buffer.from(checkDb.prepare('SELECT step_payload FROM steps WHERE idx = 1').get().step_payload);
      const r2 = Buffer.from(checkDb.prepare('SELECT step_payload FROM steps WHERE idx = 2').get().step_payload);
      const r3 = Buffer.from(checkDb.prepare('SELECT step_payload FROM steps WHERE idx = 3').get().step_payload);
      checkDb.close();
      expect(r1.equals(reducedStep)).toBe(true);
      expect(r2.equals(unsupportedStep)).toBe(true);
      expect(r3.length).toBe(corruptStep.length);
      expect(r3.equals(corruptStep)).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects and repairs invalid JPEG Huffman symbols/trees/entropy streams, image-less GIFs, and image-less WebPs (R8-P2-2)', () => {
    // 1. Exact R8-P2-2 counterexample: `buildExactSizeValidJpeg(160)` with DC symbol `0x08` mutated to `0xff`
    const validJpg160 = buildExactSizeValidJpeg(160)!;
    const dcDhtIdx = validJpg160.indexOf(Buffer.from([0xff, 0xc4, 0x00, 0x14, 0x00]));
    expect(dcDhtIdx).toBeGreaterThan(0);
    const badDcSymbolJpeg = Buffer.from(validJpg160);
    expect(badDcSymbolJpeg[dcDhtIdx + 21]).toBe(0x08);
    badDcSymbolJpeg[dcDhtIdx + 21] = 0xff;
    expect(inspectJpegBytes(badDcSymbolJpeg)).toBe('corrupt');
    expect(isValidJpegBytes(badDcSymbolJpeg)).toBe(false);

    // 2. Oversubscribed Huffman tree: `counts[0] = 3` (three 1-bit codes > 2^1 = 2)
    const oversubscribedDhtJpeg = Buffer.concat([
      validJpg160.subarray(0, dcDhtIdx),
      Buffer.from('ffc400160003000000000000000000000000000000000102', 'hex'),
      validJpg160.subarray(dcDhtIdx + 22),
    ]);
    expect(inspectJpegBytes(oversubscribedDhtJpeg)).toBe('corrupt');
    expect(isValidJpegBytes(oversubscribedDhtJpeg)).toBe(false);

    // 3. Invalid entropy scan bitstream: `DC0` only defines 1-bit code `0` -> mutating first scan bit to `1` (`0x5d -> 0xdd`) fails Huffman decode!
    const sosIdx = validJpg160.indexOf(Buffer.from([0xff, 0xda, 0x00, 0x08]));
    expect(sosIdx).toBeGreaterThan(0);
    const badEntropyJpeg = Buffer.from(validJpg160);
    expect(badEntropyJpeg[sosIdx + 10]).toBe(0x5d);
    badEntropyJpeg[sosIdx + 10] = 0xdd;
    expect(inspectJpegBytes(badEntropyJpeg)).toBe('corrupt');
    expect(isValidJpegBytes(badEntropyJpeg)).toBe(false);

    // 4. GIFs with valid header + trailer `0x3b` but no encoded image (both zeroed interior and comment-only container)
    const zeroedGif = Buffer.alloc(160);
    zeroedGif.write('GIF89a', 0, 'ascii');
    zeroedGif[159] = 0x3b;
    expect(inspectGifBytes(zeroedGif)).toBe('corrupt');
    expect(isValidGifBytes(zeroedGif)).toBe(false);

    const imagelessCommentGif = Buffer.from('47494638396101000100800000000000ffffff21fe0474657374003b', 'hex');
    const paddedImagelessGif = Buffer.concat([
      imagelessCommentGif.subarray(0, imagelessCommentGif.length - 1),
      Buffer.from([0x21, 0xfe, 0x10]),
      Buffer.alloc(16, 0x61),
      Buffer.from([0x00, 0x3b]),
    ]);
    expect(inspectGifBytes(paddedImagelessGif)).toBe('corrupt');
    expect(isValidGifBytes(paddedImagelessGif)).toBe(false);

    // 5. Exact R8-P2-2 WebP counterexample (`RIFF` + size + `WEBP` + zeros) AND `JUNK`-only WebP without any VP8/VP8L image chunk
    const badWebpZeroes = Buffer.alloc(160);
    badWebpZeroes.write('RIFF', 0, 'ascii');
    badWebpZeroes.writeUInt32LE(152, 4);
    badWebpZeroes.write('WEBP', 8, 'ascii');
    expect(inspectWebpBytes(badWebpZeroes)).toBe('corrupt');
    expect(isValidWebpBytes(badWebpZeroes)).toBe(false);

    const junkOnlyWebp = Buffer.alloc(60);
    junkOnlyWebp.write('RIFF', 0, 'ascii');
    junkOnlyWebp.writeUInt32LE(52, 4);
    junkOnlyWebp.write('WEBP', 8, 'ascii');
    junkOnlyWebp.write('JUNK', 12, 'ascii');
    junkOnlyWebp.writeUInt32LE(40, 16);
    expect(inspectWebpBytes(junkOnlyWebp)).toBe('corrupt');
    expect(isValidWebpBytes(junkOnlyWebp)).toBe(false);

    // 6. PNGs with valid CRC chunks (`IHDR` + `IDAT` + `IEND`) whose inflated bytes violate PNG scanline rules
    const makePngChunk = (type: string, data: Buffer): Buffer => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length, 0);
      const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(typeAndData) >>> 0, 0);
      return Buffer.concat([len, typeAndData, crc]);
    };
    const ihdr1x1Rgb = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
    const padTextChunk = makePngChunk('tEXt', Buffer.from('Comment\x00test-pad-png', 'ascii'));
    // Invalid filter byte `9 > 4` with exact expected inflated byte count (4 bytes) and valid chunk CRCs:
    const badFilterPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      makePngChunk('IHDR', ihdr1x1Rgb),
      padTextChunk,
      makePngChunk('IDAT', deflateSync(Buffer.from([9, 0, 0, 0]))),
      makePngChunk('IEND', Buffer.alloc(0)),
    ]);
    expect(inspectPngBytes(badFilterPng)).toBe('corrupt');
    expect(isValidPngBytes(badFilterPng)).toBe(false);

    // Truncated inflated scanline byte count (3 bytes instead of 4 bytes) with valid zlib stream and valid chunk CRCs:
    const badLenPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      makePngChunk('IHDR', ihdr1x1Rgb),
      padTextChunk,
      makePngChunk('IDAT', deflateSync(Buffer.from([0, 0, 0]))),
      makePngChunk('IEND', Buffer.alloc(0)),
    ]);
    expect(inspectPngBytes(badLenPng)).toBe('corrupt');
    expect(isValidPngBytes(badLenPng)).toBe(false);

    // Verify all malformed payloads above are detected AND repaired in-place to decodable exact-size images!
    for (const [mime, payload] of [
      ['image/jpeg', badDcSymbolJpeg],
      ['image/jpeg', oversubscribedDhtJpeg],
      ['image/jpeg', badEntropyJpeg],
      ['image/gif', zeroedGif],
      ['image/gif', paddedImagelessGif],
      ['image/webp', badWebpZeroes],
      ['image/webp', junkOnlyWebp],
      ['image/png', badFilterPng],
      ['image/png', badLenPng],
    ] as const) {
      const step = makeUserInputMediaStepPayload(mime, payload);
      const res = sanitizeCorruptedMediaStepPayload(step);
      expect(res.repairedMedia).toHaveLength(1);
      expect(res.repairedMedia[0].replacement.length).toBe(payload.length);
      if (mime === 'image/jpeg') expect(isValidJpegBytes(res.repairedMedia[0].replacement)).toBe(true);
      if (mime === 'image/gif') expect(isValidGifBytes(res.repairedMedia[0].replacement)).toBe(true);
      if (mime === 'image/webp') expect(isValidWebpBytes(res.repairedMedia[0].replacement)).toBe(true);
      if (mime === 'image/png') expect(isValidPngBytes(res.repairedMedia[0].replacement)).toBe(true);
    }
  });

  it('validates compressed WebP VP8/VP8L/ALPH bitstreams and GIF LZW EOI codes (R9-P2-1)', () => {
    // 1. Real libwebp lossy `VP8 `, lossless `VP8L`, and `VP8X + ALPH + VP8 ` fixtures validate cleanly:
    const validVp8Lossy = Buffer.from(
      '524946463c0000005745425056503820300000001002009d012a0200020001402625a00274ba01f801f80003c800feedcedffecabe1323ff54cffea709720c7d0a000000',
      'hex',
    );
    const validVp8xAlph = Buffer.from(
      '524946465c00000057454250565038580a00000010000000010000010000414c50480500000000808080800056503820300000001002009d012a0200020001402625a00274ba01f801f80003c800feedcedffecabe1323ff54cffea709720c7d0a000000',
      'hex',
    );
    const validVp8lRgba = Buffer.from(
      '524946461e000000574542505650384c110000002f014000100750bc5294bb808188e87f0000',
      'hex',
    );
    expect(inspectWebpBytes(validVp8Lossy)).toBe('valid');
    expect(inspectWebpBytes(validVp8xAlph)).toBe('valid');
    expect(inspectWebpBytes(validVp8lRgba)).toBe('valid');

    // 2. Exact R9-P2-1 counterexample: 46-byte container-valid `VP8L + JUNK` with truncated lossless bitstream
    const r9CounterexampleWebp = Buffer.from(
      '5249464626000000574542505650384c060000002f00000000004a554e4b0c000000000000000000000000000000',
      'hex',
    );
    expect(r9CounterexampleWebp.length).toBe(46);
    expect(inspectWebpBytes(r9CounterexampleWebp)).toBe('corrupt');
    expect(isValidWebpBytes(r9CounterexampleWebp)).toBe(false);

    // 3. Container-valid `VP8 ` lossy WebP with truncated compressed macroblock payload (kept >= 46B via JUNK)
    const truncatedVp8Payload = validVp8Lossy.subarray(20, 42); // 22 bytes instead of 48 bytes
    const badVp8Lossy = Buffer.alloc(20 + 22 + 8 + 10);
    badVp8Lossy.write('RIFF', 0, 'ascii');
    badVp8Lossy.writeUInt32LE(badVp8Lossy.length - 8, 4);
    badVp8Lossy.write('WEBP', 8, 'ascii');
    badVp8Lossy.write('VP8 ', 12, 'ascii');
    badVp8Lossy.writeUInt32LE(truncatedVp8Payload.length, 16);
    truncatedVp8Payload.copy(badVp8Lossy, 20);
    badVp8Lossy.write('JUNK', 42, 'ascii');
    badVp8Lossy.writeUInt32LE(10, 46);
    expect(inspectWebpBytes(badVp8Lossy)).toBe('corrupt');

    // 4. Container-valid `VP8X + ALPH + VP8 ` where ALPH compressed/raw payload is truncated (2 bytes for 2x2 alpha)
    const badAlphWebp = Buffer.from(validVp8xAlph);
    // ALPH chunk header starts at offset 30: 'ALPH' (30..33), size=5 (34..37), header=0x00, 4 raw alpha bytes + 1 pad
    // Shrink ALPH size from 5 to 2 (header + only 1 alpha byte instead of 4) and absorb remaining 4 bytes as JUNK?
    // Even simpler: set ALPH compression method bits (byte 38 & 0x03) to 1 (lossless VP8L alpha) so the 4 raw bytes `[0x80,0x80,0x80,0x80]` fail VP8L decode!
    badAlphWebp[38] = 0x01;
    expect(inspectWebpBytes(badAlphWebp)).toBe('corrupt');

    // 5. GIF89a 1x1 image whose LZW sub-block decodes the 1 pixel (`clear=4, code=0`) and ends WITHOUT `eoiCode=5`:
    // minCodeSize=2 => clearCode=4 (0b100), eoiCode=5 (0b101). Single byte `0x04` = bits `00000100`:
    // first 3-bit code = `4` (clear), next 3-bit code = `0` (pixel 0), remaining 2 bits exhausted without EOI!
    const missingEoiGif = Buffer.concat([
      Buffer.from('47494638396101000100800000000000ffffff', 'hex'), // Header + LSD + 2-color GCT (19B)
      Buffer.from([0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]), // 1x1 Image Descriptor (10B)
      Buffer.from([0x02, 0x01, 0x04, 0x00]), // minCodeSize=2, 1-byte subblock `[0x04]` (clear + pixel 0, NO EOI!), terminator
      Buffer.from([0x21, 0xfe, 0x08]), // Comment extension padding so total size >= 43B
      Buffer.alloc(8, 0x78),
      Buffer.from([0x00, 0x3b]),
    ]);
    expect(inspectGifBytes(missingEoiGif)).toBe('corrupt');
    expect(isValidGifBytes(missingEoiGif)).toBe(false);

    for (const [mime, payload] of [
      ['image/webp', r9CounterexampleWebp],
      ['image/webp', badVp8Lossy],
      ['image/webp', badAlphWebp],
      ['image/gif', missingEoiGif],
    ] as const) {
      const step = makeUserInputMediaStepPayload(mime, payload);
      const res = sanitizeCorruptedMediaStepPayload(step);
      expect(res.repairedMedia).toHaveLength(1);
      expect(res.repairedMedia[0].replacement.length).toBe(payload.length);
      if (mime === 'image/webp') expect(isValidWebpBytes(res.repairedMedia[0].replacement)).toBe(true);
      if (mime === 'image/gif') expect(isValidGifBytes(res.repairedMedia[0].replacement)).toBe(true);
    }
  });

  it('scans deeply concatenated multi-picture JPEGs iteratively without RangeError and repairs adjacent corrupt media (R9-P2-2)', () => {
    const unitJpeg = buildExactSizeValidJpeg(160)!;
    const copies = 15_000; // 2.4 MB / 15,000 concatenated SOI..EOI frames (previously blew V8 call stack)
    const deepConcatJpeg = Buffer.allocUnsafe(unitJpeg.length * copies);
    for (let i = 0; i < copies; i++) {
      unitJpeg.copy(deepConcatJpeg, i * unitJpeg.length);
    }

    expect(inspectJpegBytes(deepConcatJpeg)).toBe('unsupported');

    // Verify full conversation DB repair preserves the unsupported 15,000-image blob untouched
    // AND completes repair of an adjacent corrupt JPEG in the same conversation without aborting!
    const tmpHome = mkdtempSync(join(os.tmpdir(), 'agy-r9-p2-2-'));
    try {
      const convId = '11111111-2222-3333-4444-555555555555';
      const convDir = join(tmpHome, 'conversations');
      mkdirSync(convDir, { recursive: true });
      const dbPath = join(convDir, `${convId}.db`);
      const { DatabaseSync } = requireFromHere('node:sqlite');
      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB);');

      const stepUnsupported = makeUserInputMediaStepPayload('image/jpeg', deepConcatJpeg);
      const badJpeg = Buffer.from(unitJpeg);
      const sosIdx = badJpeg.indexOf(Buffer.from([0xff, 0xda, 0x00, 0x08]));
      badJpeg[sosIdx + 10] = 0xdd;
      expect(inspectJpegBytes(badJpeg)).toBe('corrupt');
      const stepCorrupt = makeUserInputMediaStepPayload('image/jpeg', badJpeg);

      const ins = db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, 19, ?)');
      ins.run(1, stepUnsupported);
      ins.run(2, stepCorrupt);
      db.close();

      const repairRes = repairCorruptedAgyConversationMedia(convId, { agyHomeDir: tmpHome });
      expect(repairRes.repairedCount).toBe(1);
      expect(repairRes.repairedSteps).toEqual([2]);

      const dbCheck = new DatabaseSync(dbPath);
      const row1 = Buffer.from(dbCheck.prepare('SELECT step_payload FROM steps WHERE idx = 1').get().step_payload);
      const row2 = Buffer.from(dbCheck.prepare('SELECT step_payload FROM steps WHERE idx = 2').get().step_payload);
      dbCheck.close();

      expect(row1.equals(stepUnsupported)).toBe(true);
      expect(sanitizeCorruptedMediaStepPayload(row2).repairedMedia).toHaveLength(0);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
