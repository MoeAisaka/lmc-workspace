import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const requireFromHere = createRequire(import.meta.url);

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Minimal spec-compliant 1x1 grayscale JPEG (SOI + APP0 + DQT + SOF0 + DHT + SOS + 1px scan + EOI).
const MINIMAL_1X1_JPEG = Buffer.from(
  'ffd8ffe000104a46494600010101004800480000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffda0008010100003f00fbfca28a00ffd9',
  'hex',
);

// Minimal spec-compliant 1x1 GIF89a (35 bytes, ends with 0x3b).
const MINIMAL_1X1_GIF = Buffer.from(
  '47494638396101000100800000f4f4f50000002c00000000010001000002024401003b',
  'hex',
);

// Minimal spec-compliant 1x1 lossless VP8L WebP (30 bytes).
const MINIMAL_1X1_WEBP_VP8L_DATA = Buffer.from('2f000000000710fdff0f0000', 'hex');

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32Bytes(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function readU32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] << 24) |
      (buf[offset + 1] << 16) |
      (buf[offset + 2] << 8) |
      buf[offset + 3]) >>>
    0
  );
}

function readU32LE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset] |
      (buf[offset + 1] << 8) |
      (buf[offset + 2] << 16) |
      (buf[offset + 3] << 24)) >>>
    0
  );
}

function makePngChunk(typeAscii: string, data: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(typeAscii, 4, 4, 'ascii');
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(out, 8);
  const crc = crc32Bytes(out.subarray(4, 8 + data.length));
  out.writeUInt32BE(crc, 8 + data.length);
  return out;
}

export function isValidPngBytes(data: Uint8Array): boolean {
  if (data.length < 45) return false;
  for (let i = 0; i < 8; i++) {
    if (data[i] !== PNG_SIG[i]) return false;
  }
  let pos = 8;
  let sawIhdr = false;
  let sawIend = false;
  const idatParts: Buffer[] = [];
  while (pos + 8 <= data.length) {
    const chunkLen = readU32BE(data, pos);
    if (pos + 12 + chunkLen > data.length) return false;
    const type0 = data[pos + 4];
    const type1 = data[pos + 5];
    const type2 = data[pos + 6];
    const type3 = data[pos + 7];
    const expectedCrc = readU32BE(data, pos + 8 + chunkLen);
    const actualCrc = crc32Bytes(data.subarray(pos + 4, pos + 8 + chunkLen));
    if (expectedCrc !== actualCrc) return false;
    const isIhdr = type0 === 0x49 && type1 === 0x48 && type2 === 0x44 && type3 === 0x52;
    const isIdat = type0 === 0x49 && type1 === 0x44 && type2 === 0x41 && type3 === 0x54;
    const isIend = type0 === 0x49 && type1 === 0x45 && type2 === 0x4e && type3 === 0x44;
    if (pos === 8 && !isIhdr) return false;
    if (isIhdr) {
      if (chunkLen !== 13) return false;
      sawIhdr = true;
    } else if (isIdat) {
      idatParts.push(Buffer.from(data.buffer, data.byteOffset + pos + 8, chunkLen));
    } else if (isIend) {
      sawIend = true;
      break;
    }
    pos += 12 + chunkLen;
  }
  if (!sawIhdr || !sawIend || idatParts.length === 0) return false;
  try {
    inflateSync(Buffer.concat(idatParts));
    return true;
  } catch {
    return false;
  }
}

export function isValidJpegBytes(data: Uint8Array): boolean {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return false;
  let pos = 2;
  while (pos < data.length) {
    if (data[pos] !== 0xff) return false;
    while (pos < data.length && data[pos] === 0xff) pos++;
    if (pos >= data.length) return false;
    const marker = data[pos++];
    if (marker === 0xd9) return true;
    if (marker === 0x00) return false;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (pos + 2 > data.length) return false;
    const segLen = (data[pos] << 8) | data[pos + 1];
    if (segLen < 2 || pos + segLen > data.length) return false;
    pos += segLen;
    if (marker === 0xda) {
      // Entropy-coded scan data follows SOS until an unescaped FF D9 EOI marker.
      for (let i = data.length - 2; i >= pos; i--) {
        if (data[i] === 0xff && data[i + 1] === 0xd9) return true;
      }
      return false;
    }
  }
  return false;
}

export function isValidGifBytes(data: Uint8Array): boolean {
  if (data.length < 14) return false;
  const hdr = Buffer.from(data.buffer, data.byteOffset, 6).toString('ascii');
  if (hdr !== 'GIF87a' && hdr !== 'GIF89a') return false;
  return data[data.length - 1] === 0x3b;
}

export function isValidWebpBytes(data: Uint8Array): boolean {
  if (data.length < 16) return false;
  const riff = Buffer.from(data.buffer, data.byteOffset, 4).toString('ascii');
  const webp = Buffer.from(data.buffer, data.byteOffset + 8, 4).toString('ascii');
  if (riff !== 'RIFF' || webp !== 'WEBP') return false;
  const riffSize = readU32LE(data, 4);
  return riffSize + 8 <= data.length;
}

export function buildExactSizeValidPng(targetSize: number): Buffer | null {
  const ihdrData = Buffer.allocUnsafe(13);
  ihdrData.writeUInt32BE(1, 0);
  ihdrData.writeUInt32BE(1, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // RGB
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = makePngChunk('IHDR', ihdrData);
  const idat = makePngChunk('IDAT', deflateSync(Buffer.from([0x00, 0xf4, 0xf4, 0xf5]), { level: 9 }));
  const iend = makePngChunk('IEND', Buffer.alloc(0));
  const baseLen = PNG_SIG.length + ihdr.length + idat.length + iend.length;
  const rem = targetSize - baseLen;
  if (rem === 0) {
    return Buffer.concat([PNG_SIG, ihdr, idat, iend]);
  }
  if (rem < 14) return null;
  const textPayloadLen = rem - 12;
  const prefix = textPayloadLen >= 8 ? Buffer.from('Comment\x00', 'ascii') : Buffer.from('k\x00', 'ascii');
  const textData = Buffer.alloc(textPayloadLen, 0x78); // 'x'
  prefix.copy(textData, 0);
  const textChunk = makePngChunk('tEXt', textData);
  const out = Buffer.concat([PNG_SIG, ihdr, textChunk, idat, iend]);
  return out.length === targetSize ? out : null;
}

export function buildExactSizeValidJpeg(targetSize: number): Buffer | null {
  const rem0 = targetSize - MINIMAL_1X1_JPEG.length;
  if (rem0 < 0) return null;
  if (rem0 === 0) return Buffer.from(MINIMAL_1X1_JPEG);
  const bodyBeforeEoi = MINIMAL_1X1_JPEG.subarray(0, MINIMAL_1X1_JPEG.length - 2);
  const eoi = MINIMAL_1X1_JPEG.subarray(MINIMAL_1X1_JPEG.length - 2);
  const extraParts: Buffer[] = [];
  let rem = rem0;
  while (rem >= 4) {
    // JPEG COM segment: FF FE <u16 length including length bytes> <payload>
    const totalSegBytes = Math.min(60002, rem);
    const segLen = totalSegBytes - 2;
    const seg = Buffer.alloc(totalSegBytes, 0x78);
    seg[0] = 0xff;
    seg[1] = 0xfe;
    seg.writeUInt16BE(segLen, 2);
    extraParts.push(seg);
    rem -= totalSegBytes;
  }
  if (rem > 0) {
    // ITU-T T.81 B.1.1.2: any number of 0xFF fill bytes may precede a marker (FF D9).
    extraParts.push(Buffer.alloc(rem, 0xff));
  }
  const out = Buffer.concat([bodyBeforeEoi, ...extraParts, eoi]);
  return out.length === targetSize ? out : null;
}

export function buildExactSizeValidGif(targetSize: number): Buffer | null {
  const rem = targetSize - MINIMAL_1X1_GIF.length;
  if (rem === 0) return Buffer.from(MINIMAL_1X1_GIF);
  if (rem < 5) return null;
  const prefix = MINIMAL_1X1_GIF.subarray(0, MINIMAL_1X1_GIF.length - 1);
  const parts: Buffer[] = [prefix, Buffer.from([0x21, 0xfe])];
  let subRem = rem - 3; // minus 0x21 0xfe header and 0x00 block terminator
  while (subRem > 0) {
    let blockTotal = Math.min(256, subRem);
    if (subRem - blockTotal === 1) {
      blockTotal -= 1; // avoid leaving 1 byte (minimum sub-block is 1 len + 1 data = 2 bytes)
    }
    const dataLen = blockTotal - 1;
    const block = Buffer.alloc(blockTotal, 0x78);
    block[0] = dataLen;
    parts.push(block);
    subRem -= blockTotal;
  }
  parts.push(Buffer.from([0x00, 0x3b]));
  const out = Buffer.concat(parts);
  return out.length === targetSize ? out : null;
}

export function buildExactSizeValidWebp(targetSize: number): Buffer | null {
  const vp8lChunk = Buffer.allocUnsafe(8 + MINIMAL_1X1_WEBP_VP8L_DATA.length);
  vp8lChunk.write('VP8L', 0, 4, 'ascii');
  vp8lChunk.writeUInt32LE(MINIMAL_1X1_WEBP_VP8L_DATA.length, 4);
  MINIMAL_1X1_WEBP_VP8L_DATA.copy(vp8lChunk, 8);
  const baseLen = 12 + vp8lChunk.length; // 'RIFF' + size + 'WEBP' + VP8L
  const rem = targetSize - baseLen;
  if (rem === 0) {
    const out = Buffer.allocUnsafe(baseLen);
    out.write('RIFF', 0, 4, 'ascii');
    out.writeUInt32LE(baseLen - 8, 4);
    out.write('WEBP', 8, 4, 'ascii');
    vp8lChunk.copy(out, 12);
    return out;
  }
  if (rem < 8) return null;
  const trailingOddByte = rem % 2;
  const junkTotal = rem - trailingOddByte;
  const junkDataLen = junkTotal - 8;
  const junkChunk = Buffer.alloc(junkTotal, 0);
  junkChunk.write('JUNK', 0, 4, 'ascii');
  junkChunk.writeUInt32LE(junkDataLen, 4);
  const riffPayloadLen = 4 + vp8lChunk.length + junkChunk.length;
  const header = Buffer.allocUnsafe(12);
  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(riffPayloadLen, 4);
  header.write('WEBP', 8, 4, 'ascii');
  const parts = [header, vp8lChunk, junkChunk];
  if (trailingOddByte === 1) parts.push(Buffer.from([0x00]));
  const out = Buffer.concat(parts);
  return out.length === targetSize ? out : null;
}

type SupportedImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

const SUPPORTED_MIMES: readonly {
  mime: SupportedImageMime;
  ext: string;
  needle: Buffer;
  validate: (data: Uint8Array) => boolean;
  buildReplacement: (size: number) => Buffer | null;
}[] = [
  {
    mime: 'image/png',
    ext: 'png',
    needle: Buffer.from('\x0a\x09image/png\x12', 'binary'),
    validate: isValidPngBytes,
    buildReplacement: buildExactSizeValidPng,
  },
  {
    mime: 'image/jpeg',
    ext: 'jpg',
    needle: Buffer.from('\x0a\x0aimage/jpeg\x12', 'binary'),
    validate: isValidJpegBytes,
    buildReplacement: buildExactSizeValidJpeg,
  },
  {
    mime: 'image/gif',
    ext: 'gif',
    needle: Buffer.from('\x0a\x09image/gif\x12', 'binary'),
    validate: isValidGifBytes,
    buildReplacement: buildExactSizeValidGif,
  },
  {
    mime: 'image/webp',
    ext: 'webp',
    needle: Buffer.from('\x0a\x0aimage/webp\x12', 'binary'),
    validate: isValidWebpBytes,
    buildReplacement: buildExactSizeValidWebp,
  },
];

function readProtobufVarint(buf: Uint8Array, startPos: number): { value: number; nextPos: number } | null {
  let result = 0;
  let shift = 0;
  let pos = startPos;
  while (pos < buf.length && shift < 35) {
    const b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) {
      return { value: result, nextPos: pos };
    }
    shift += 7;
  }
  return null;
}

export function sanitizeCorruptedMediaStepPayload(payload: Uint8Array): {
  updatedPayload: Buffer | null;
  repairedMedia: { mediaIndex: number; ext: string; replacement: Buffer }[];
} {
  let buf: Buffer | null = null;
  const source = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  const repairedMedia: { mediaIndex: number; ext: string; replacement: Buffer }[] = [];

  for (const spec of SUPPORTED_MIMES) {
    let searchFrom = 0;
    let mediaIndex = 0;
    while (searchFrom < source.length) {
      const hit = source.indexOf(spec.needle, searchFrom);
      if (hit < 0) break;
      const varintStart = hit + spec.needle.length;
      const parsed = readProtobufVarint(source, varintStart);
      if (!parsed || parsed.value <= 0 || parsed.nextPos + parsed.value > source.length) {
        searchFrom = varintStart;
        continue;
      }
      const dataStart = parsed.nextPos;
      const dataEnd = dataStart + parsed.value;
      const slice = source.subarray(dataStart, dataEnd);
      if (!spec.validate(slice)) {
        const replacement = spec.buildReplacement(parsed.value);
        if (replacement && replacement.length === parsed.value) {
          if (!buf) buf = Buffer.from(source);
          replacement.copy(buf, dataStart);
          repairedMedia.push({ mediaIndex, ext: spec.ext, replacement });
        }
      }
      mediaIndex++;
      searchFrom = dataEnd;
    }
  }

  return { updatedPayload: buf, repairedMedia };
}

export interface AgyConversationMediaRepairResult {
  repairedCount: number;
  repairedSteps: number[];
  backupPath?: string;
}

export interface RepairAgyConversationOptions {
  agyHomeDir?: string;
  log?: (msg: string) => void;
}

export function resolveDefaultAgyHomeDir(homeDir: string = os.homedir()): string {
  const override = process.env.AGY_HOME?.trim();
  if (override) return override;
  return join(homeDir, '.gemini', 'antigravity-cli');
}

export function repairCorruptedAgyConversationMedia(
  conversationId: string,
  opts: RepairAgyConversationOptions = {},
): AgyConversationMediaRepairResult {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(conversationId)) {
    return { repairedCount: 0, repairedSteps: [] };
  }
  const agyHomeDir = opts.agyHomeDir ?? resolveDefaultAgyHomeDir();
  const dbPath = join(agyHomeDir, 'conversations', `${conversationId}.db`);
  if (!existsSync(dbPath)) {
    return { repairedCount: 0, repairedSteps: [] };
  }

  let DatabaseSyncCtor: any;
  try {
    ({ DatabaseSync: DatabaseSyncCtor } = requireFromHere('node:sqlite'));
  } catch {
    opts.log?.('node:sqlite is unavailable; skipping Antigravity conversation media repair check');
    return { repairedCount: 0, repairedSteps: [] };
  }

  const pendingUpdates: {
    idx: number;
    updatedPayload: Buffer;
    repairedMedia: { mediaIndex: number; ext: string; replacement: Buffer }[];
  }[] = [];

  try {
    const roDb = new DatabaseSyncCtor(dbPath, { readOnly: true });
    try {
      const rows = roDb
        .prepare('SELECT idx, step_payload FROM steps WHERE step_payload IS NOT NULL')
        .all() as { idx: number; step_payload: Uint8Array }[];
      for (const row of rows) {
        if (!row.step_payload || row.step_payload.byteLength < 32) continue;
        const { updatedPayload, repairedMedia } = sanitizeCorruptedMediaStepPayload(row.step_payload);
        if (updatedPayload && repairedMedia.length > 0) {
          pendingUpdates.push({ idx: row.idx, updatedPayload, repairedMedia });
        }
      }
    } finally {
      roDb.close();
    }
  } catch (err) {
    opts.log?.(`Failed to inspect Antigravity conversation DB for corrupted media: ${err instanceof Error ? err.message : String(err)}`);
    return { repairedCount: 0, repairedSteps: [] };
  }

  if (pendingUpdates.length === 0) {
    return { repairedCount: 0, repairedSteps: [] };
  }

  let backupPath: string | undefined;
  try {
    const backupDir = join(agyHomeDir, 'cache', 'media-repair-backups');
    mkdirSync(backupDir, { recursive: true });
    backupPath = join(backupDir, `${conversationId}.${Date.now()}.db.bak`);
    copyFileSync(dbPath, backupPath);

    const rwDb = new DatabaseSyncCtor(dbPath);
    try {
      rwDb.exec('BEGIN IMMEDIATE');
      const updateStmt = rwDb.prepare('UPDATE steps SET step_payload = ? WHERE idx = ?');
      for (const item of pendingUpdates) {
        updateStmt.run(item.updatedPayload, item.idx);
      }
      rwDb.exec('COMMIT');
    } catch (writeErr) {
      try { rwDb.exec('ROLLBACK'); } catch {}
      throw writeErr;
    } finally {
      rwDb.close();
    }

    const mediaLogDir = join(agyHomeDir, 'brain', conversationId, '.system_generated', 'logs', 'media');
    if (existsSync(mediaLogDir)) {
      for (const item of pendingUpdates) {
        for (const m of item.repairedMedia) {
          const mediaPath = join(mediaLogDir, `step_${item.idx}_media_${m.mediaIndex}.${m.ext}`);
          if (existsSync(mediaPath)) {
            try { writeFileSync(mediaPath, m.replacement); } catch {}
          }
        }
      }
    }

    const repairedCount = pendingUpdates.reduce((acc, u) => acc + u.repairedMedia.length, 0);
    return {
      repairedCount,
      repairedSteps: pendingUpdates.map(u => u.idx),
      backupPath,
    };
  } catch (err) {
    opts.log?.(`Failed to repair corrupted media in Antigravity conversation DB: ${err instanceof Error ? err.message : String(err)}`);
    return { repairedCount: 0, repairedSteps: [] };
  }
}
