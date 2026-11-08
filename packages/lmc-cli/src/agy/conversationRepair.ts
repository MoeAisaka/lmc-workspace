import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { deflateSync, inflateSync } from 'node:zlib';

const requireFromHere = createRequire(import.meta.url);

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Minimal spec-compliant 1x1 grayscale baseline JPEG (160 bytes: SOI + APP0 + DQT + SOF0 +
// DHT DC0 + DHT AC0 + SOS + 1px scan + EOI; verified with libjpeg-turbo / Go image/jpeg).
const MINIMAL_1X1_JPEG = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000ffdb0043000503040404030504040405050506070c08070707070f0b0b090c110f1212110f111113161c1713141a1511111821181a1d1d1f1f1f13172224221e241c1e1f1effc0000b080001000101011100ffc40014000100000000000000000000000000000008ffc40014100100000000000000000000000000000000ffda0008010100003f005d3fffd9',
  'hex',
);

// Minimal spec-compliant 1x1 GIF89a (35 bytes, ends with 0x3b).
const MINIMAL_1X1_GIF = Buffer.from(
  '47494638396101000100800000f4f4f50000002c00000000010001000002024401003b',
  'hex',
);

// Minimal spec-compliant 1x1 lossless VP8L WebP payload (17 bytes, padded to 18-byte even RIFF chunk; verified with libwebp).
const MINIMAL_1X1_WEBP_VP8L_DATA = Buffer.from('2f000000000750fad2b7beff8188e87f00', 'hex');

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

export type ImageValidationStatus = 'valid' | 'unsupported' | 'corrupt';

const MAX_PNG_INFLATED_BYTES = 64 * 1024 * 1024;
const ADAM7_X0 = [0, 4, 0, 2, 0, 1, 0] as const;
const ADAM7_DX = [8, 8, 4, 4, 2, 2, 1] as const;
const ADAM7_Y0 = [0, 0, 4, 0, 2, 0, 1] as const;
const ADAM7_DY = [8, 8, 8, 4, 4, 2, 2] as const;

function isPngChunkTypeByte(b: number): boolean {
  return (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
}

function getPngChannels(colorType: number, bitDepth: number): number {
  switch (colorType) {
    case 0:
      return bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8 || bitDepth === 16 ? 1 : 0;
    case 2:
      return bitDepth === 8 || bitDepth === 16 ? 3 : 0;
    case 3:
      return bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8 ? 1 : 0;
    case 4:
      return bitDepth === 8 || bitDepth === 16 ? 2 : 0;
    case 6:
      return bitDepth === 8 || bitDepth === 16 ? 4 : 0;
    default:
      return 0;
  }
}

export function inspectPngBytes(data: Uint8Array): ImageValidationStatus {
  if (data.length < 45) return 'corrupt';
  for (let i = 0; i < 8; i++) {
    if (data[i] !== PNG_SIG[i]) return 'corrupt';
  }
  let pos = 8;
  let sawIhdr = false;
  let sawPlte = false;
  let sawIdat = false;
  let idatClosed = false;
  let sawIend = false;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let channels = 0;
  let interlace = 0;
  const idatParts: Buffer[] = [];

  while (pos + 12 <= data.length) {
    const chunkLen = readU32BE(data, pos);
    if (chunkLen > 0x7fffffff || pos + 12 + chunkLen > data.length) return 'corrupt';
    const type0 = data[pos + 4];
    const type1 = data[pos + 5];
    const type2 = data[pos + 6];
    const type3 = data[pos + 7];
    if (
      !isPngChunkTypeByte(type0) ||
      !isPngChunkTypeByte(type1) ||
      !isPngChunkTypeByte(type2) ||
      !isPngChunkTypeByte(type3)
    ) {
      return 'corrupt';
    }
    const expectedCrc = readU32BE(data, pos + 8 + chunkLen);
    const actualCrc = crc32Bytes(data.subarray(pos + 4, pos + 8 + chunkLen));
    if (expectedCrc !== actualCrc) return 'corrupt';

    const isIhdr = type0 === 0x49 && type1 === 0x48 && type2 === 0x44 && type3 === 0x52;
    const isPlte = type0 === 0x50 && type1 === 0x4c && type2 === 0x54 && type3 === 0x45;
    const isIdat = type0 === 0x49 && type1 === 0x44 && type2 === 0x41 && type3 === 0x54;
    const isIend = type0 === 0x49 && type1 === 0x45 && type2 === 0x4e && type3 === 0x44;

    if (pos === 8 && !isIhdr) return 'corrupt';
    if (isIhdr) {
      if (sawIhdr || chunkLen !== 13) return 'corrupt';
      width = readU32BE(data, pos + 8);
      height = readU32BE(data, pos + 12);
      bitDepth = data[pos + 16];
      colorType = data[pos + 17];
      const compression = data[pos + 18];
      const filter = data[pos + 19];
      interlace = data[pos + 20];
      channels = getPngChannels(colorType, bitDepth);
      if (
        width === 0 ||
        width > 0x7fffffff ||
        height === 0 ||
        height > 0x7fffffff ||
        channels === 0 ||
        compression !== 0 ||
        filter !== 0 ||
        (interlace !== 0 && interlace !== 1)
      ) {
        return 'corrupt';
      }
      sawIhdr = true;
    } else if (isPlte) {
      if (!sawIhdr || sawPlte || sawIdat || colorType === 0 || colorType === 4) return 'corrupt';
      if (chunkLen < 3 || chunkLen > 768 || chunkLen % 3 !== 0) return 'corrupt';
      if (colorType === 3 && chunkLen / 3 > 1 << bitDepth) return 'corrupt';
      sawPlte = true;
    } else if (isIdat) {
      if (!sawIhdr || idatClosed) return 'corrupt';
      if (colorType === 3 && !sawPlte) return 'corrupt';
      sawIdat = true;
      idatParts.push(Buffer.from(data.buffer, data.byteOffset + pos + 8, chunkLen));
    } else if (isIend) {
      if (chunkLen !== 0 || pos + 12 !== data.length) return 'corrupt';
      sawIend = true;
      pos += 12;
      break;
    } else {
      if (sawIdat) idatClosed = true;
    }
    pos += 12 + chunkLen;
  }

  if (!sawIhdr || !sawIend || pos !== data.length || idatParts.length === 0) return 'corrupt';

  const bitsPerPixel = channels * bitDepth;
  const passLayouts: Array<{ rows: number; rowBytes: number }> = [];
  let expectedBytes = 0;
  if (interlace === 0) {
    const rowBytes = 1 + Math.ceil((width * bitsPerPixel) / 8);
    expectedBytes = height * rowBytes;
    passLayouts.push({ rows: height, rowBytes });
  } else {
    for (let p = 0; p < 7; p++) {
      if (width <= ADAM7_X0[p] || height <= ADAM7_Y0[p]) continue;
      const pw = Math.ceil((width - ADAM7_X0[p]) / ADAM7_DX[p]);
      const ph = Math.ceil((height - ADAM7_Y0[p]) / ADAM7_DY[p]);
      const rowBytes = 1 + Math.ceil((pw * bitsPerPixel) / 8);
      expectedBytes += ph * rowBytes;
      passLayouts.push({ rows: ph, rowBytes });
    }
  }

  if (!Number.isSafeInteger(expectedBytes) || expectedBytes > MAX_PNG_INFLATED_BYTES) {
    return 'unsupported';
  }

  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(idatParts), { maxOutputLength: expectedBytes + 1 });
  } catch {
    return 'corrupt';
  }
  if (inflated.length !== expectedBytes) return 'corrupt';

  let rowOffset = 0;
  for (const pass of passLayouts) {
    for (let r = 0; r < pass.rows; r++) {
      if (inflated[rowOffset] > 4) return 'corrupt';
      rowOffset += pass.rowBytes;
    }
  }
  return 'valid';
}

export function isValidPngBytes(data: Uint8Array): boolean {
  return inspectPngBytes(data) === 'valid';
}

const MAX_JPEG_MPF_IMAGES = 8;
const MAX_JPEG_BLOCKS = 4_000_000;
const MAX_JPEG_PROG_COMPONENT_BLOCKS = 524_288;

interface JpegHuffmanTable {
  maxCode: Int32Array;
  valOffset: Int32Array;
  symbols: Uint8Array;
}

interface JpegComponentScanState {
  h: number;
  v: number;
  tq: number;
  seqScanned: boolean;
  dcSeen: boolean;
  dcAl: number;
  acSeen: Uint8Array;
  acAl: Uint8Array;
  nzLo: Uint32Array | null;
  nzHi: Uint32Array | null;
}

function buildJpegHuffmanTable(counts: Uint8Array, symbols: Uint8Array): JpegHuffmanTable | null {
  const maxCode = new Int32Array(17).fill(-1);
  const valOffset = new Int32Array(17);
  let code = 0;
  let idx = 0;
  for (let bits = 1; bits <= 16; bits++) {
    const cnt = counts[bits - 1];
    if (cnt > 0) {
      valOffset[bits] = idx - code;
      code += cnt;
      if (code > 1 << bits) return null;
      maxCode[bits] = code - 1;
      idx += cnt;
    }
    code <<= 1;
  }
  if (idx !== symbols.length) return null;
  return { maxCode, valOffset, symbols };
}

function isAllowedPostScanJpegMarker(sm: number): boolean {
  return (
    sm === 0xc4 ||
    sm === 0xcc ||
    sm === 0xda ||
    sm === 0xdb ||
    sm === 0xdc ||
    sm === 0xdd ||
    (sm >= 0xe0 && sm <= 0xef) ||
    sm === 0xfe
  );
}

function delimitJpegEntropyScan(
  data: Uint8Array,
  segEnd: number,
): { scanEnd: number; nextMarker: number; afterNextMarkerPos: number } | null {
  let sp = segEnd;
  let hasScanBytes = false;
  while (sp < data.length) {
    if (data[sp] !== 0xff) {
      hasScanBytes = true;
      sp++;
      continue;
    }
    const markerStart = sp;
    while (sp < data.length && data[sp] === 0xff) sp++;
    if (sp >= data.length) return null;
    const sm = data[sp++];
    if (sm === 0x00) {
      if (sp - markerStart !== 2) return null;
      hasScanBytes = true;
      continue;
    }
    if (sm >= 0xd0 && sm <= 0xd7) {
      continue;
    }
    if (!hasScanBytes) return null;
    if (sm === 0xd9 || isAllowedPostScanJpegMarker(sm)) {
      return { scanEnd: markerStart, nextMarker: sm, afterNextMarkerPos: sp };
    }
    return null;
  }
  return null;
}

interface JpegSingleImageResult {
  status: ImageValidationStatus;
  nextOffset: number;
}

function scanSingleUnsupportedJpegToEoi(
  data: Uint8Array,
  startPos: number,
  alreadySawScan: boolean,
  requireDnl: boolean,
): JpegSingleImageResult {
  const corrupt: JpegSingleImageResult = { status: 'corrupt', nextOffset: data.length };
  let pos = startPos;
  let sawScan = alreadySawScan;
  let sawDnl = !requireDnl;
  while (pos < data.length) {
    if (data[pos] !== 0xff) return corrupt;
    while (pos < data.length && data[pos] === 0xff) pos++;
    if (pos >= data.length) return corrupt;
    const marker = data[pos++];
    if (marker === 0xd9) {
      if (!sawScan || !sawDnl) return corrupt;
      if (pos === data.length) return { status: 'unsupported', nextOffset: pos };
      if (pos + 4 <= data.length && data[pos] === 0xff && data[pos + 1] === 0xd8) {
        return { status: 'unsupported', nextOffset: pos };
      }
      return corrupt;
    }
    if (marker === 0x00 || marker === 0xd8) return corrupt;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (pos + 2 > data.length) return corrupt;
    const segLen = (data[pos] << 8) | data[pos + 1];
    if (segLen < 2 || pos + segLen > data.length) return corrupt;
    const segEnd = pos + segLen;
    if (marker === 0xdc) {
      if (segLen !== 4) return corrupt;
      const nl = (data[pos + 2] << 8) | data[pos + 3];
      if (nl === 0) return corrupt;
      sawDnl = true;
      pos = segEnd;
      continue;
    }
    if (marker === 0xda) {
      if (segLen < 6) return corrupt;
      const scanBounds = delimitJpegEntropyScan(data, segEnd);
      if (!scanBounds) return corrupt;
      sawScan = true;
      if (scanBounds.nextMarker === 0xd9) {
        if (!sawDnl) return corrupt;
        const endPos = scanBounds.afterNextMarkerPos;
        if (endPos === data.length) return { status: 'unsupported', nextOffset: endPos };
        if (endPos + 4 <= data.length && data[endPos] === 0xff && data[endPos + 1] === 0xd8) {
          return { status: 'unsupported', nextOffset: endPos };
        }
        return corrupt;
      }
      pos = scanBounds.scanEnd;
      continue;
    }
    pos = segEnd;
  }
  return corrupt;
}

function decodeJpegScanEntropy(
  data: Uint8Array,
  segEnd: number,
  scanEnd: number,
  sofMarker: number,
  samplePrecision: number,
  samplesX: number,
  linesY: number,
  maxH: number,
  maxV: number,
  restartInterval: number,
  scanComps: ReadonlyArray<{ comp: JpegComponentScanState; td: number; ta: number }>,
  dcTables: ReadonlyArray<JpegHuffmanTable | null>,
  acTables: ReadonlyArray<JpegHuffmanTable | null>,
  ss: number,
  se: number,
  ah: number,
): boolean {
  let bytePos = segEnd;
  let bitBuf = 0;
  let bitCount = 0;

  const readBit = (): number => {
    if (bitCount === 0) {
      if (bytePos >= scanEnd) return -1;
      const b = data[bytePos++];
      if (b === 0xff) {
        if (bytePos >= scanEnd || data[bytePos] !== 0x00) return -1;
        bytePos++;
      }
      bitBuf = b;
      bitCount = 8;
    }
    bitCount -= 1;
    return (bitBuf >>> bitCount) & 1;
  };

  const skipBits = (count: number): boolean => {
    for (let i = 0; i < count; i++) {
      if (readBit() < 0) return false;
    }
    return true;
  };

  const readBitsValue = (count: number): number => {
    let val = 0;
    for (let i = 0; i < count; i++) {
      const bit = readBit();
      if (bit < 0) return -1;
      val = (val << 1) | bit;
    }
    return val;
  };

  const decodeHuffman = (table: JpegHuffmanTable): number => {
    let code = 0;
    for (let bits = 1; bits <= 16; bits++) {
      const bit = readBit();
      if (bit < 0) return -1;
      code = (code << 1) | bit;
      const max = table.maxCode[bits];
      if (max >= 0 && code <= max) {
        return table.symbols[table.valOffset[bits] + code];
      }
    }
    return -1;
  };

  const consumeRestartMarker = (expectedRstIndex: number): boolean => {
    bitCount = 0;
    bitBuf = 0;
    if (bytePos + 2 > scanEnd || data[bytePos] !== 0xff) return false;
    while (bytePos < scanEnd && data[bytePos] === 0xff) bytePos++;
    if (bytePos >= scanEnd) return false;
    const rst = data[bytePos++];
    return rst === 0xd0 + (expectedRstIndex & 7);
  };

  const ns = scanComps.length;
  let totalMcus = 0;
  if (ns === 1) {
    const comp = scanComps[0].comp;
    const compW = Math.ceil((samplesX * comp.h) / maxH);
    const compH = Math.ceil((linesY * comp.v) / maxV);
    totalMcus = Math.ceil(compW / 8) * Math.ceil(compH / 8);
  } else {
    totalMcus = Math.ceil(samplesX / (8 * maxH)) * Math.ceil(linesY / (8 * maxV));
  }
  if (totalMcus <= 0) return false;

  const maxDcCategory = samplePrecision === 12 ? 15 : 11;
  const maxAcCategory = samplePrecision === 12 ? 14 : 10;
  let eobRun = 0;
  let rstCounter = 0;

  for (let mcu = 0; mcu < totalMcus; mcu++) {
    if (sofMarker === 0xc0 || sofMarker === 0xc1) {
      for (let c = 0; c < ns; c++) {
        const { comp, td, ta } = scanComps[c];
        const dcTable = dcTables[td]!;
        const acTable = acTables[ta]!;
        const blocksInMcu = ns === 1 ? 1 : comp.h * comp.v;
        for (let b = 0; b < blocksInMcu; b++) {
          const dcCat = decodeHuffman(dcTable);
          if (dcCat < 0 || dcCat > maxDcCategory) return false;
          if (dcCat > 0 && !skipBits(dcCat)) return false;
          let k = 1;
          while (k <= 63) {
            const sym = decodeHuffman(acTable);
            if (sym < 0) return false;
            const r = (sym >> 4) & 0x0f;
            const s = sym & 0x0f;
            if (s === 0) {
              if (r === 0) break;
              if (r !== 15) return false;
              k += 16;
              if (k > 64) return false;
            } else {
              if (s > maxAcCategory) return false;
              k += r;
              if (k > 63) return false;
              if (!skipBits(s)) return false;
              k += 1;
            }
          }
        }
      }
    } else if (ss === 0) {
      if (ah === 0) {
        for (let c = 0; c < ns; c++) {
          const { comp, td } = scanComps[c];
          const dcTable = dcTables[td]!;
          const blocksInMcu = ns === 1 ? 1 : comp.h * comp.v;
          for (let b = 0; b < blocksInMcu; b++) {
            const dcCat = decodeHuffman(dcTable);
            if (dcCat < 0 || dcCat > maxDcCategory) return false;
            if (dcCat > 0 && !skipBits(dcCat)) return false;
          }
        }
      } else {
        for (let c = 0; c < ns; c++) {
          const { comp } = scanComps[c];
          const blocksInMcu = ns === 1 ? 1 : comp.h * comp.v;
          if (!skipBits(blocksInMcu)) return false;
        }
      }
    } else {
      const { comp, ta } = scanComps[0];
      const acTable = acTables[ta]!;
      const nzLo = comp.nzLo!;
      const nzHi = comp.nzHi!;
      const isNz = (k: number): boolean =>
        k < 32 ? ((nzLo[mcu] >>> k) & 1) !== 0 : ((nzHi[mcu] >>> (k - 32)) & 1) !== 0;
      const setNz = (k: number): void => {
        if (k < 32) nzLo[mcu] |= 1 << k;
        else nzHi[mcu] |= 1 << (k - 32);
      };

      if (ah === 0) {
        if (eobRun > 0) {
          eobRun -= 1;
        } else {
          let k = ss;
          while (k <= se) {
            const sym = decodeHuffman(acTable);
            if (sym < 0) return false;
            const r = (sym >> 4) & 0x0f;
            const s = sym & 0x0f;
            if (s === 0) {
              if (r === 15) {
                k += 16;
                if (k > se + 1) return false;
              } else {
                let run = 1 << r;
                if (r > 0) {
                  const extra = readBitsValue(r);
                  if (extra < 0) return false;
                  run += extra;
                }
                eobRun = run - 1;
                break;
              }
            } else {
              if (s > maxAcCategory) return false;
              k += r;
              if (k > se) return false;
              if (!skipBits(s)) return false;
              setNz(k);
              k += 1;
            }
          }
        }
      } else {
        if (eobRun > 0) {
          for (let k = ss; k <= se; k++) {
            if (isNz(k) && readBit() < 0) return false;
          }
          eobRun -= 1;
        } else {
          let k = ss;
          while (k <= se) {
            const sym = decodeHuffman(acTable);
            if (sym < 0) return false;
            let r = (sym >> 4) & 0x0f;
            const s = sym & 0x0f;
            if (s === 1) {
              if (readBit() < 0) return false;
            } else if (s !== 0) {
              return false;
            }
            if (s === 0 && r < 15) {
              let run = 1 << r;
              if (r > 0) {
                const extra = readBitsValue(r);
                if (extra < 0) return false;
                run += extra;
              }
              for (; k <= se; k++) {
                if (isNz(k) && readBit() < 0) return false;
              }
              eobRun = run - 1;
              break;
            }
            while (k <= se) {
              if (isNz(k)) {
                if (readBit() < 0) return false;
                k += 1;
              } else {
                if (r === 0) break;
                r -= 1;
                k += 1;
              }
            }
            if (k > se) return false;
            if (s === 1) setNz(k);
            k += 1;
          }
        }
      }
    }

    if (restartInterval > 0 && mcu + 1 < totalMcus && (mcu + 1) % restartInterval === 0) {
      if (eobRun !== 0) return false;
      if (!consumeRestartMarker(rstCounter)) return false;
      rstCounter += 1;
    }
  }

  if (eobRun !== 0) return false;

  // Allow optional trailing RSTm if totalMcus is an exact multiple of restartInterval,
  // plus at most 4 byte-aligned flush bytes (`0x00` or stuffed `0xff 0x00`).
  if (
    restartInterval > 0 &&
    totalMcus % restartInterval === 0 &&
    bytePos + 2 <= scanEnd &&
    data[bytePos] === 0xff &&
    data[bytePos + 1] !== 0x00
  ) {
    if (!consumeRestartMarker(rstCounter)) return false;
  }

  let trailingPadBytes = 0;
  while (bytePos < scanEnd) {
    const b = data[bytePos++];
    if (b === 0x00) {
      trailingPadBytes += 1;
    } else if (b === 0xff && bytePos < scanEnd && data[bytePos] === 0x00) {
      bytePos += 1;
      trailingPadBytes += 1;
    } else {
      return false;
    }
    if (trailingPadBytes > 4) return false;
  }
  return true;
}

function inspectSingleJpegSlice(data: Uint8Array): JpegSingleImageResult | 'corrupt' {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return 'corrupt';

  let pos = 2;
  let dqtMask = 0;
  let dqt16Mask = 0;
  let sofMarker = 0;
  let samplePrecision = 0;
  let linesY = 0;
  let samplesX = 0;
  let maxH = 1;
  let maxV = 1;
  let yDefined = false;
  let restartInterval = 0;
  const frameComponents = new Map<number, JpegComponentScanState>();
  const dcTables: Array<JpegHuffmanTable | null> = [null, null, null, null];
  const acTables: Array<JpegHuffmanTable | null> = [null, null, null, null];
  let completedScanCount = 0;

  const isFrameComplete = (): boolean => {
    if (sofMarker === 0 || !yDefined || completedScanCount <= 0 || frameComponents.size === 0) {
      return false;
    }
    if (sofMarker === 0xc0 || sofMarker === 0xc1) {
      for (const comp of frameComponents.values()) {
        if (!comp.seqScanned) return false;
      }
      return true;
    }
    if (sofMarker === 0xc2) {
      // Progressive JPEG (ITU-T T.81 Annex G) may legitimately terminate at reduced spectral or
      // successive-approximation precision once every frame component's DC scan has been sent.
      for (const comp of frameComponents.values()) {
        if (!comp.dcSeen) return false;
      }
      return true;
    }
    return false;
  };

  while (pos < data.length) {
    if (data[pos] !== 0xff) return 'corrupt';
    while (pos < data.length && data[pos] === 0xff) pos++;
    if (pos >= data.length) return 'corrupt';
    const marker = data[pos++];
    if (marker === 0xd9) {
      if (!isFrameComplete()) return 'corrupt';
      if (pos === data.length) return { status: 'valid', nextOffset: pos };
      if (pos + 4 <= data.length && data[pos] === 0xff && data[pos + 1] === 0xd8) {
        return { status: 'valid', nextOffset: pos };
      }
      return 'corrupt';
    }
    if (marker === 0x00 || marker === 0xd8) return 'corrupt';
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (pos + 2 > data.length) return 'corrupt';
    const segLen = (data[pos] << 8) | data[pos + 1];
    if (segLen < 2 || pos + segLen > data.length) return 'corrupt';
    const payloadStart = pos + 2;
    const segEnd = pos + segLen;

    if (marker === 0xdb) {
      if (payloadStart >= segEnd) return 'corrupt';
      let qp = payloadStart;
      while (qp < segEnd) {
        const pqTq = data[qp++];
        const pq = (pqTq >> 4) & 0x0f;
        const tq = pqTq & 0x0f;
        if ((pq !== 0 && pq !== 1) || tq > 3) return 'corrupt';
        const qBytes = pq === 0 ? 64 : 128;
        if (qp + qBytes > segEnd) return 'corrupt';
        if (pq === 0) {
          for (let i = 0; i < 64; i++) {
            if (data[qp + i] === 0) return 'corrupt';
          }
        } else {
          for (let i = 0; i < 64; i++) {
            if (((data[qp + 2 * i] << 8) | data[qp + 2 * i + 1]) === 0) return 'corrupt';
          }
        }
        qp += qBytes;
        dqtMask |= 1 << tq;
        if (pq === 1) dqt16Mask |= 1 << tq;
        else dqt16Mask &= ~(1 << tq);
      }
    } else if (marker === 0xcc) {
      // Arithmetic conditioning marker (DAC) — valid only in non-Huffman arithmetic JPEGs.
      if (sofMarker === 0xc0 || sofMarker === 0xc1 || sofMarker === 0xc2) return 'corrupt';
      return scanSingleUnsupportedJpegToEoi(data, segEnd, completedScanCount > 0, false);
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4) {
      if (marker === 0xc8) return 'corrupt'; // JPG reserved marker
      if (sofMarker !== 0 || completedScanCount > 0 || segLen < 8) return 'corrupt';
      if (marker !== 0xc0 && marker !== 0xc1 && marker !== 0xc2) {
        // Non-baseline/lossless/differential/arithmetic frame markers: preserve as `unsupported`
        // if container framing through EOI is intact, rather than destructively replacing with 1x1.
        const nfUnsupported = data[payloadStart + 5];
        const samplesUnsupported = (data[payloadStart + 3] << 8) | data[payloadStart + 4];
        const linesUnsupported = (data[payloadStart + 1] << 8) | data[payloadStart + 2];
        if (samplesUnsupported === 0 || nfUnsupported < 1 || segLen !== 8 + 3 * nfUnsupported) {
          return 'corrupt';
        }
        return scanSingleUnsupportedJpegToEoi(
          data,
          segEnd,
          false,
          linesUnsupported === 0,
        );
      }
      const precision = data[payloadStart];
      if (marker === 0xc0 ? precision !== 8 : precision !== 8 && precision !== 12) {
        return 'corrupt';
      }
      linesY = (data[payloadStart + 1] << 8) | data[payloadStart + 2];
      samplesX = (data[payloadStart + 3] << 8) | data[payloadStart + 4];
      const nf = data[payloadStart + 5];
      if (samplesX === 0 || nf < 1 || (marker === 0xc2 && nf > 4)) return 'corrupt';
      if (segLen !== 8 + 3 * nf) return 'corrupt';
      maxH = 1;
      maxV = 1;
      const rawComps: Array<{ ci: number; h: number; v: number; tqi: number }> = [];
      for (let i = 0; i < nf; i++) {
        const ci = data[payloadStart + 6 + 3 * i];
        const hv = data[payloadStart + 7 + 3 * i];
        const tqi = data[payloadStart + 8 + 3 * i];
        const h = (hv >> 4) & 0x0f;
        const v = hv & 0x0f;
        if (h < 1 || h > 4 || v < 1 || v > 4 || tqi > 3) return 'corrupt';
        if (frameComponents.has(ci) || rawComps.some((rc) => rc.ci === ci)) return 'corrupt';
        if (h > maxH) maxH = h;
        if (v > maxV) maxV = v;
        rawComps.push({ ci, h, v, tqi });
      }
      if (linesY === 0) {
        // DNL-deferred height (ITU-T T.81 B.2.5): preserve intact containers as `unsupported`.
        return scanSingleUnsupportedJpegToEoi(data, segEnd, false, true);
      }
      let totalImageBlocks = 0;
      for (const rc of rawComps) {
        const compW = Math.ceil((samplesX * rc.h) / maxH);
        const compH = Math.ceil((linesY * rc.v) / maxV);
        const compBlocks = Math.ceil(compW / 8) * Math.ceil(compH / 8);
        totalImageBlocks += compBlocks;
        if (
          totalImageBlocks > MAX_JPEG_BLOCKS ||
          (marker === 0xc2 && compBlocks > MAX_JPEG_PROG_COMPONENT_BLOCKS)
        ) {
          return scanSingleUnsupportedJpegToEoi(data, segEnd, false, false);
        }
      }
      for (const rc of rawComps) {
        const compW = Math.ceil((samplesX * rc.h) / maxH);
        const compH = Math.ceil((linesY * rc.v) / maxV);
        const compBlocks = Math.ceil(compW / 8) * Math.ceil(compH / 8);
        frameComponents.set(rc.ci, {
          h: rc.h,
          v: rc.v,
          tq: rc.tqi,
          seqScanned: false,
          dcSeen: false,
          dcAl: 0,
          acSeen: new Uint8Array(64),
          acAl: new Uint8Array(64),
          nzLo: marker === 0xc2 ? new Uint32Array(compBlocks) : null,
          nzHi: marker === 0xc2 ? new Uint32Array(compBlocks) : null,
        });
      }
      sofMarker = marker;
      samplePrecision = precision;
      yDefined = true;
    } else if (marker === 0xc4) {
      if (payloadStart >= segEnd) return 'corrupt';
      let hp = payloadStart;
      while (hp < segEnd) {
        const tcTh = data[hp++];
        const tc = (tcTh >> 4) & 0x0f;
        const th = tcTh & 0x0f;
        if ((tc !== 0 && tc !== 1) || th > 3 || hp + 16 > segEnd) return 'corrupt';
        const counts = data.subarray(hp, hp + 16);
        let symCount = 0;
        for (let i = 0; i < 16; i++) symCount += counts[i];
        hp += 16;
        if (symCount > 256 || hp + symCount > segEnd) return 'corrupt';
        const symbols = Uint8Array.from(data.subarray(hp, hp + symCount));
        hp += symCount;
        if (tc === 0) {
          for (let i = 0; i < symbols.length; i++) {
            if (symbols[i] > 15) return 'corrupt';
          }
        }
        const table = buildJpegHuffmanTable(counts, symbols);
        if (!table) return 'corrupt';
        if (tc === 0) dcTables[th] = table;
        else acTables[th] = table;
      }
    } else if (marker === 0xdc) {
      if (segLen !== 4 || completedScanCount !== 1) return 'corrupt';
      const nl = (data[payloadStart] << 8) | data[payloadStart + 1];
      if (nl === 0 || (yDefined && nl !== linesY)) return 'corrupt';
      linesY = nl;
      yDefined = true;
    } else if (marker === 0xdd) {
      if (segLen !== 4) return 'corrupt';
      restartInterval = (data[payloadStart] << 8) | data[payloadStart + 1];
    } else if (marker === 0xda) {
      if (dqtMask === 0 || sofMarker === 0 || frameComponents.size === 0) return 'corrupt';
      if (payloadStart >= segEnd) return 'corrupt';
      const ns = data[payloadStart];
      if (ns < 1 || ns > 4 || ns > frameComponents.size || segLen !== 6 + 2 * ns) return 'corrupt';

      const scanComps: Array<{ comp: JpegComponentScanState; td: number; ta: number }> = [];
      const seenInScan = new Set<number>();
      let mcuBlocks = 0;
      for (let c = 0; c < ns; c++) {
        const cs = data[payloadStart + 1 + c * 2];
        const tdTa = data[payloadStart + 2 + c * 2];
        const td = (tdTa >> 4) & 0x0f;
        const ta = tdTa & 0x0f;
        if (seenInScan.has(cs)) return 'corrupt';
        seenInScan.add(cs);
        const comp = frameComponents.get(cs);
        if (!comp) return 'corrupt';
        if ((dqtMask & (1 << comp.tq)) === 0) return 'corrupt';
        if (sofMarker === 0xc0 && (dqt16Mask & (1 << comp.tq)) !== 0) return 'corrupt';
        mcuBlocks += comp.h * comp.v;
        scanComps.push({ comp, td, ta });
      }
      if (ns > 1 && mcuBlocks > 10) return 'corrupt';

      const ss = data[payloadStart + 1 + 2 * ns];
      const se = data[payloadStart + 2 + 2 * ns];
      const ahal = data[payloadStart + 3 + 2 * ns];
      const ah = (ahal >> 4) & 0x0f;
      const al = ahal & 0x0f;
      const maxApproxBit = samplePrecision === 12 ? 15 : 13;
      if (ah > maxApproxBit || al > maxApproxBit) return 'corrupt';

      const maxDcCat = samplePrecision === 12 ? 15 : 11;
      const maxAcCat = samplePrecision === 12 ? 14 : 10;

      if (sofMarker === 0xc0 || sofMarker === 0xc1) {
        const maxTableId = sofMarker === 0xc0 ? 1 : 3;
        if (ss !== 0 || se !== 63 || ah !== 0 || al !== 0) return 'corrupt';
        for (const { comp, td, ta } of scanComps) {
          if (comp.seqScanned) return 'corrupt';
          if (td > maxTableId || ta > maxTableId) return 'corrupt';
          const dcTable = dcTables[td];
          const acTable = acTables[ta];
          if (!dcTable || !acTable) return 'corrupt';
          for (let i = 0; i < dcTable.symbols.length; i++) {
            if (dcTable.symbols[i] > maxDcCat) return 'corrupt';
          }
          for (let i = 0; i < acTable.symbols.length; i++) {
            const sym = acTable.symbols[i];
            const s = sym & 0x0f;
            if (s === 0 ? sym !== 0x00 && sym !== 0xf0 : s > maxAcCat) return 'corrupt';
          }
          comp.seqScanned = true;
        }
      } else if (sofMarker === 0xc2) {
        if (ss === 0) {
          if (se !== 0) return 'corrupt';
          if (ah === 0) {
            for (const { comp, td, ta } of scanComps) {
              if (comp.dcSeen || ta !== 0 || td > 3) return 'corrupt';
              const dcTable = dcTables[td];
              if (!dcTable) return 'corrupt';
              for (let i = 0; i < dcTable.symbols.length; i++) {
                if (dcTable.symbols[i] > maxDcCat) return 'corrupt';
              }
              comp.dcSeen = true;
              comp.dcAl = al;
            }
          } else {
            if (al !== ah - 1) return 'corrupt';
            for (const { comp, td, ta } of scanComps) {
              if (!comp.dcSeen || comp.dcAl !== ah || td > 3 || ta !== 0) {
                return 'corrupt';
              }
              comp.dcAl = al;
            }
          }
        } else if (ss >= 1 && ss <= 63) {
          if (se < ss || se > 63 || ns !== 1) return 'corrupt';
          const { comp, td, ta } = scanComps[0];
          if (td !== 0 || ta > 3) return 'corrupt';
          const acTable = acTables[ta];
          if (!acTable) return 'corrupt';
          for (let i = 0; i < acTable.symbols.length; i++) {
            const sym = acTable.symbols[i];
            const s = sym & 0x0f;
            if (s === 0 ? sym === 0xff : s > maxAcCat) return 'corrupt';
          }
          if (ah === 0) {
            for (let k = ss; k <= se; k++) {
              if (comp.acSeen[k] !== 0) return 'corrupt';
            }
            for (let k = ss; k <= se; k++) {
              comp.acSeen[k] = 1;
              comp.acAl[k] = al;
            }
          } else {
            if (al !== ah - 1) return 'corrupt';
            for (let k = ss; k <= se; k++) {
              if (comp.acSeen[k] !== 1 || comp.acAl[k] !== ah) return 'corrupt';
            }
            for (let k = ss; k <= se; k++) {
              comp.acAl[k] = al;
            }
          }
        } else {
          return 'corrupt';
        }
      } else {
        return 'corrupt';
      }

      const scanBounds = delimitJpegEntropyScan(data, segEnd);
      if (!scanBounds) return 'corrupt';
      if (
        !decodeJpegScanEntropy(
          data,
          segEnd,
          scanBounds.scanEnd,
          sofMarker,
          samplePrecision,
          samplesX,
          linesY,
          maxH,
          maxV,
          restartInterval,
          scanComps,
          dcTables,
          acTables,
          ss,
          se,
          ah,
        )
      ) {
        return 'corrupt';
      }

      completedScanCount += 1;
      if (scanBounds.nextMarker === 0xd9) {
        if (!isFrameComplete()) return 'corrupt';
        const endPos = scanBounds.afterNextMarkerPos;
        if (endPos === data.length) return { status: 'valid', nextOffset: endPos };
        if (endPos + 4 <= data.length && data[endPos] === 0xff && data[endPos + 1] === 0xd8) {
          return { status: 'valid', nextOffset: endPos };
        }
        return 'corrupt';
      }
      pos = scanBounds.scanEnd;
      continue;
    }

    pos = segEnd;
  }
  return 'corrupt';
}

export function inspectJpegBytes(data: Uint8Array): ImageValidationStatus {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return 'corrupt';
  let offset = 0;
  let imageIndex = 0;
  let sawUnsupported = false;
  while (offset < data.length) {
    if (offset + 4 > data.length || data[offset] !== 0xff || data[offset + 1] !== 0xd8) {
      return 'corrupt';
    }
    if (imageIndex >= MAX_JPEG_MPF_IMAGES) {
      const step = scanSingleUnsupportedJpegToEoi(data, offset + 2, false, false);
      if (step.status === 'corrupt' || step.nextOffset <= offset) return 'corrupt';
      sawUnsupported = true;
      offset = step.nextOffset;
    } else {
      const slice = offset === 0 ? data : data.subarray(offset);
      const step = inspectSingleJpegSlice(slice);
      if (step === 'corrupt' || step.status === 'corrupt' || step.nextOffset <= 0) {
        return 'corrupt';
      }
      if (step.status === 'unsupported') sawUnsupported = true;
      offset += step.nextOffset;
    }
    imageIndex += 1;
  }
  return sawUnsupported ? 'unsupported' : 'valid';
}

export function isValidJpegBytes(data: Uint8Array): boolean {
  return inspectJpegBytes(data) === 'valid';
}

const MAX_GIF_FRAME_PIXELS = 64_000_000;

function decodeGifLzwPixels(lzwBytes: Uint8Array, lzwMinCodeSize: number, expectedPixels: number): boolean {
  if (lzwBytes.length === 0 || expectedPixels <= 0) return false;
  const clearCode = 1 << lzwMinCodeSize;
  const eoiCode = clearCode + 1;
  const seqLen = new Uint32Array(4096);
  for (let i = 0; i < clearCode; i++) seqLen[i] = 1;

  let codeSize = lzwMinCodeSize + 1;
  let nextCode = eoiCode + 1;
  let prevCode = -1;
  let pixelsDecoded = 0;

  let byteIdx = 0;
  let bitBuf = 0;
  let bitCount = 0;

  const readCode = (): number => {
    while (bitCount < codeSize) {
      if (byteIdx >= lzwBytes.length) return -1;
      bitBuf |= lzwBytes[byteIdx++] << bitCount;
      bitCount += 8;
    }
    const code = bitBuf & ((1 << codeSize) - 1);
    bitBuf >>>= codeSize;
    bitCount -= codeSize;
    return code;
  };

  let sawEoi = false;
  while (true) {
    const code = readCode();
    if (code < 0) break;
    if (code === clearCode) {
      codeSize = lzwMinCodeSize + 1;
      nextCode = eoiCode + 1;
      prevCode = -1;
      continue;
    }
    if (code === eoiCode) {
      sawEoi = true;
      break;
    }
    if (pixelsDecoded >= expectedPixels) {
      return false;
    }
    let curLen = 0;
    if (code < nextCode) {
      if (code === clearCode || code === eoiCode) return false;
      curLen = seqLen[code];
      if (curLen === 0) return false;
    } else if (code === nextCode && prevCode >= 0) {
      curLen = seqLen[prevCode] + 1;
    } else {
      return false;
    }
    pixelsDecoded += curLen;
    if (pixelsDecoded > expectedPixels) return false;
    if (prevCode >= 0 && nextCode < 4096) {
      seqLen[nextCode] = seqLen[prevCode] + 1;
      nextCode += 1;
      if (nextCode === 1 << codeSize && codeSize < 12) {
        codeSize += 1;
      }
    }
    prevCode = code;
  }

  return sawEoi && pixelsDecoded === expectedPixels;
}

export function inspectGifBytes(data: Uint8Array): ImageValidationStatus {
  if (data.length < 14) return 'corrupt';
  const hdr = Buffer.from(data.buffer, data.byteOffset, 6).toString('ascii');
  if (hdr !== 'GIF87a' && hdr !== 'GIF89a') return 'corrupt';
  const screenW = data[6] | (data[7] << 8);
  const screenH = data[8] | (data[9] << 8);
  if (screenW === 0 || screenH === 0) return 'corrupt';

  const screenPacked = data[10];
  let pos = 13;
  if ((screenPacked & 0x80) !== 0) {
    pos += 3 * (1 << ((screenPacked & 0x07) + 1));
  }
  if (pos >= data.length) return 'corrupt';

  let imageCount = 0;
  let sawUnsupportedHugeFrame = false;

  while (pos < data.length) {
    const intro = data[pos++];
    if (intro === 0x3b) {
      if (pos !== data.length || imageCount < 1) return 'corrupt';
      return sawUnsupportedHugeFrame ? 'unsupported' : 'valid';
    }
    if (intro === 0x21) {
      if (pos >= data.length) return 'corrupt';
      pos += 1; // extension label
      while (true) {
        if (pos >= data.length) return 'corrupt';
        const subLen = data[pos++];
        if (subLen === 0) break;
        if (pos + subLen > data.length) return 'corrupt';
        pos += subLen;
      }
      continue;
    }
    if (intro === 0x2c) {
      if (pos + 9 > data.length) return 'corrupt';
      const iw = data[pos + 4] | (data[pos + 5] << 8);
      const ih = data[pos + 6] | (data[pos + 7] << 8);
      const imgPacked = data[pos + 8];
      pos += 9;
      if (iw === 0 || ih === 0) return 'corrupt';
      if ((imgPacked & 0x80) !== 0) {
        const lctBytes = 3 * (1 << ((imgPacked & 0x07) + 1));
        if (pos + lctBytes > data.length) return 'corrupt';
        pos += lctBytes;
      }
      if (pos >= data.length) return 'corrupt';
      const lzwMinCodeSize = data[pos++];
      if (lzwMinCodeSize < 2 || lzwMinCodeSize > 8) return 'corrupt';

      const subBlocks: Buffer[] = [];
      let totalSubBytes = 0;
      while (true) {
        if (pos >= data.length) return 'corrupt';
        const subLen = data[pos++];
        if (subLen === 0) break;
        if (pos + subLen > data.length) return 'corrupt';
        subBlocks.push(Buffer.from(data.buffer, data.byteOffset + pos, subLen));
        totalSubBytes += subLen;
        pos += subLen;
      }
      if (totalSubBytes === 0) return 'corrupt';

      const expectedPixels = iw * ih;
      if (expectedPixels > MAX_GIF_FRAME_PIXELS) {
        sawUnsupportedHugeFrame = true;
      } else {
        const lzwStream = subBlocks.length === 1 ? subBlocks[0] : Buffer.concat(subBlocks, totalSubBytes);
        if (!decodeGifLzwPixels(lzwStream, lzwMinCodeSize, expectedPixels)) {
          return 'corrupt';
        }
      }
      imageCount += 1;
      continue;
    }
    return 'corrupt';
  }
  return 'corrupt';
}

export function isValidGifBytes(data: Uint8Array): boolean {
  return inspectGifBytes(data) === 'valid';
}

function isWebpFourCcByte(b: number): boolean {
  return b >= 0x20 && b <= 0x7e;
}

const MAX_WEBP_PIXELS = 16_777_216;
const MAX_WEBP_HTREE_GROUPS = 2048;
const MAX_WEBP_ANMF_FRAMES = 64;

const VP8_COEFFS_UPDATE_PROBA = Buffer.from(
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffb0f6ffffffffffffffffffdff1fcfffffffffffffffff9fdfdfffffffffffffffffff4fcffffffffffffffffeafefefffffffffffffffffdfffffffffffffffffffffff6feffffffffffffffffeffdfefffffffffffffffffefffefffffffffffffffffff8fefffffffffffffffffbfffefffffffffffffffffffffffffffffffffffffffffdfefffffffffffffffffbfefefffffffffffffffffefffefffffffffffffffffffefdfffefffffffffffffafffefffefffffffffffffeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffd9ffffffffffffffffffffe1fcf1fdfffffeffffffffeafaf1fafdfffdfefffffffffeffffffffffffffffffdffefeffffffffffffffffeefdfefefffffffffffffffff8fefffffffffffffffff9fefffffffffffffffffffffffffffffffffffffffffffdfffffffffffffffffff7fefffffffffffffffffffffffffffffffffffffffffffdfefffffffffffffffffcfffffffffffffffffffffffffffffffffffffffffffffefefffffffffffffffffdfffffffffffffffffffffffffffffffffffffffffffffefdfffffffffffffffffafffffffffffffffffffffeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffbafbfaffffffffffffffffeafbf4fefffffffffffffffbfbf3fdfefffefffffffffffdfeffffffffffffffffecfdfefffffffffffffffffbfdfdfefefffffffffffffffefefffffffffffffffffefefefffffffffffffffffffffffffffffffffffffffffefffffffffffffffffffefefffffffffffffffffffefffffffffffffffffffffffffffffffffffffffffffefffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8fffffffffffffffffffffafefcfefffffffffffffff8fef9fdfffffffffffffffffdfdfffffffffffffffff6fdfdfffffffffffffffffcfefbfefefffffffffffffffefcfffffffffffffffff8fefdfffffffffffffffffdfffefefffffffffffffffffbfefffffffffffffffff5fbfefffffffffffffffffdfdfefffffffffffffffffffbfdfffffffffffffffffcfdfefffffffffffffffffffefffffffffffffffffffffcfffffffffffffffffff9fffefffffffffffffffffffffefffffffffffffffffffffdfffffffffffffffffafffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffffffffffffffffffffffffffffffffffffff',
  'hex',
);

const VP8_COEFFS_PROBA0 = Buffer.from(
  '808080808080808080808080808080808080808080808080808080808080808080fd88feffe4db8080808080bd81f2ffe3d5ffdb8080806a7ee3fcd6d1ffff8080800162f8ffece2ffff808080b585eefeddeaff9a8080804e86caf7c6b4ffdb80808001b9f9fff3ff8080808080b896f7ffece080808080804d6ed8ffece680808080800165fbfff1ff8080808080aa8bf1fcecd1ffff8080802574c4f3e4ffffff80808001ccfefff5ff8080808080cfa0faffee8080808080806667e7ffd3ab80808080800198fcfff0ff8080808080b187f3ffeae180808080805081d3ffc2e080808080800101ff8080808080808080f601ff8080808080808080ff80808080808080808080c623eddfc1bba2a0919b3e832dc6ddacb0dc9dfcdd01442f92d095a7dda2ffdf800195f1ffdde0ffff808080b88deafddedcffc78080805163b5f2b0bef9caffff800181e8fdd6c5f2c4ffff806379d2fac9c6ffca808080175ba3f2aabbf7d2ffff8001c8f6ffeaff80808080806db2f1ffe7f5ffff8080802c82c9fdcdc0ffff8080800184effbdbd1ffa58080805e88e1fbdabeffff8080801664aef5baa1ffc780808001b6f9ffe8eb80808080807c8ff1ffe3ea8080808080234db5fbc1d3ffcd808080019df7ffece7ffff808080798debffe1e3ffff8080802d63bcfbc3d9ffe08080800101fbffd5ff8080808080cb01f8ffff8080808080808901b1ffe0ff8080808080fd09f8fbcfd0ffc0808080af0de0f3c1b9f9c6ffff804911abdda1b3eca7ffea80015ff7fdd4b7ffff808080ef5af4fad3d1ffff8080809b4dc3f8bcc3ffff8080800118effbdadbffcd808080c933dbffc4ba8080808080452ebeefc9daffe480808001bffbffff808080808080dfa5f9ffd5ff80808080808d7cf8ffff8080808080800110f8ffff808080808080be24e6ffecff80808080809501ff808080808080808001e2ff8080808080808080f7c0ff8080808080808080f080ff80808080808080800186fcffff808080808080d53efaffff808080808080375dff8080808080808080808080808080808080808080808080808080808080808080808080808080808080ca18d5ebbabfdca0f0afff7e26b6e8a9b8e4aeffbb803d2e8adb97b2f0aaffd8800170e6fac7bff79fffff80a66de4fcd3d7ffae808080274da2e8acb4f5b2ffff800134dcf6c6c7f9dcffff807c4abff3b7c1faddffff80184782db9aaaf3b6ffff8001b6e1f9dbf0ffe08080809596e2fcd8cdffab8080801c6caaf2b7c2fedfffff800151e6fccccbffc08080807b66d1f7bcc4ffe9808080145f99f3a4adffcb80808001def8ffd8d58080808080a8aff6fcebcdffff8080802f74d7ffd3d4ffff8080800179ecfdd4d6ffff8080808d54d5fcc9caffdb8080802a50a0f0a2b9ffcd8080800101ff8080808080808080f401ff8080808080808080ee01ff8080808080808080',
  'hex',
);

const VP8_K_BMODES_PROBA = Buffer.from(
  'e7783059737178987098b3407eaa762e465faf458f505552489b67383a0aabdabd110d98721a11a32cc3150aad791850c31a3e2c405590470a26abd590221aaa2e371388a021ce473f14087272d00c09e251280b60b6541d102486b7598962656aa59448bb64829d6f204b504266a7634a3e28ea80293509b2f18d1a086b4a2b1a9249a631179d412669a033341f7380684f0c1bd9ff5711075744472c72330fba172f290e6eb6b71511c2422d1966c5bd171216585893962a2e2dc4cd2b61b775552623b33d2735c8571a152be8ab3822336872661d5d4d271c55ab3aa55a6240221674ce17222ba6496b36201a3301512b1f44196a1640ab24e1722213156684bc104c7c3e124e5f5539323033c165239fd76f592e6f3c941facdbe415126f70714d55b3ff267872282a01c4f5d10a196d582b1d8ca6d5252b9a3d3f1e9b432d4401d16450082b9a01331a478e4e4e10ff8022c5ab29280566d3b70401dd333211a8d1c01719528a1f24ab1ba6262ce543573aa952731a3bb33f3b5ab43ba65d499a282815748fd12227af2f0f10b722df312db72e1121b706620f20b7392e16188001361125412049731c801780cd2803097333c01206df572509733b4d40152f68372cda09363582e2405a46cd2829171a39363970b8052926a6d51e221a8598740a2086271335dd1a722049ff1f0941ea020f0176494b200c33c0ffa02b33581f2343665537ba553815176f3bcd2d25c03726467c49660122627d622a58685575af525f543559806471652d4b4f7b2f338051ab0139110547663935293126210d7939491a0155290a438a4d6e5a2f727315020a66ffa61706651d100a558065c41a39120a6666d522142b75140f24a38044011a663d472522351ff3c0453c472649771cde25442d8022012f0bf5ab3e1113469255373e46252b259a64a355a0013f095c881c4020c9554b0f090940ffb8771056061c0540ff19f8013808118489ff3774803a0f145287391a7928a4321f899a851923da33672c83837b1f069e5628408794e02db780161a1183f09a0e01d12d10155b40de0701c53815279b3c8a1766d5530c0d36c0ff442f1c551a555580802092ab120b073f90ab0404f6231b0a92aeab0c1a80be502363b4507e362d557e2f57b033291420654b808b769274805538290fb0ec5525093e471e117776ff11128a65263c8a37462b1a8e9224131eabff611b148a2d3d3edb0151bc4020291475978e1415a370130c3dc380300418',
  'hex',
);

const VP8_K_BANDS = new Uint8Array([0, 1, 2, 3, 6, 4, 5, 6, 6, 6, 6, 6, 6, 6, 6, 7, 0]);
const VP8_K_CAT3 = new Uint8Array([173, 148, 140, 0]);
const VP8_K_CAT4 = new Uint8Array([176, 155, 140, 135, 0]);
const VP8_K_CAT5 = new Uint8Array([180, 157, 141, 134, 130, 0]);
const VP8_K_CAT6 = new Uint8Array([254, 254, 243, 230, 196, 177, 153, 140, 133, 130, 129, 0]);
const VP8_K_CATS = [VP8_K_CAT3, VP8_K_CAT4, VP8_K_CAT5, VP8_K_CAT6] as const;
const VP8_YMODE_TO_BMODE = [0, 2, 3, 1] as const;

const VP8L_CODE_LENGTH_ORDER = new Uint8Array([
  17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
]);
const VP8L_CODE_TO_PLANE = Buffer.from(
  '1807171928062729161a262a38053739151b363a252b48044749141c353b464a242c58454b343c035759131d565a232d444c555b333d68026769121e666a222e545c434d656b323e78017779535d111f646c424e767a212f757b313f636d525e00747c414f1020626e30737d515f40727e616f50717f6070',
  'hex',
);

class Vp8BoolReader {
  private pos: number;
  private readonly end: number;
  private value = 0;
  private range = 254;
  private bits = -8;
  eof = false;

  constructor(
    private readonly buf: Uint8Array,
    start: number,
    length: number,
  ) {
    this.pos = start;
    this.end = start + length;
    this.loadFinalBytes();
  }

  private loadFinalBytes(): void {
    if (this.pos < this.end) {
      this.bits += 8;
      this.value = ((this.value << 8) | this.buf[this.pos++]) >>> 0;
    } else if (!this.eof) {
      this.value = (this.value << 8) >>> 0;
      this.bits += 8;
      this.eof = true;
    } else {
      this.bits = 0;
    }
  }

  getBit(prob: number): number {
    if (this.bits < 0) {
      this.loadFinalBytes();
    }
    const pos = this.bits;
    const split = (this.range * prob) >>> 8;
    const value = this.value >>> pos;
    let bit = 0;
    if (value > split) {
      this.range -= split + 1;
      this.value = (this.value - (((split + 1) << pos) >>> 0)) >>> 0;
      bit = 1;
    } else {
      this.range = split;
    }
    if (this.range <= 0x7e) {
      let r = this.range + 1;
      let shift = 0;
      while (r < 128) {
        r <<= 1;
        shift += 1;
      }
      this.range = r - 1;
      this.bits -= shift;
    }
    return bit;
  }

  getBits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = (v << 1) | this.getBit(128);
    }
    return v;
  }

  getSigned(n: number): number {
    const v = this.getBits(n);
    return this.getBit(128) ? -v : v;
  }
}

function readVp8KfBmode(br: Vp8BoolReader, off: number): number {
  if (br.getBit(VP8_K_BMODES_PROBA[off + 0]) === 0) return 0;
  if (br.getBit(VP8_K_BMODES_PROBA[off + 1]) === 0) return 1;
  if (br.getBit(VP8_K_BMODES_PROBA[off + 2]) === 0) return 2;
  if (br.getBit(VP8_K_BMODES_PROBA[off + 3]) === 0) {
    if (br.getBit(VP8_K_BMODES_PROBA[off + 4]) === 0) return 3;
    return br.getBit(VP8_K_BMODES_PROBA[off + 5]) === 0 ? 4 : 5;
  }
  if (br.getBit(VP8_K_BMODES_PROBA[off + 6]) === 0) return 6;
  if (br.getBit(VP8_K_BMODES_PROBA[off + 7]) === 0) return 7;
  return br.getBit(VP8_K_BMODES_PROBA[off + 8]) === 0 ? 8 : 9;
}

function readVp8KfYmode(br: Vp8BoolReader): number {
  if (br.getBit(145) === 0) return 4;
  if (br.getBit(156) === 0) return br.getBit(163) === 0 ? 0 : 1;
  return br.getBit(128) === 0 ? 2 : 3;
}

function readVp8KfUvMode(br: Vp8BoolReader): number {
  if (br.getBit(142) === 0) return 0;
  if (br.getBit(114) === 0) return 1;
  return br.getBit(183) === 0 ? 2 : 3;
}

function decodeVp8CoeffsBlock(
  br: Vp8BoolReader,
  coeffsProba: Uint8Array,
  planeType: number,
  initialCtx: number,
  firstCoeff: number,
): number {
  let ctx = initialCtx;
  let n = firstCoeff;
  const planeBase = planeType * (8 * 3 * 11);
  let checkEob = true;
  let hasNz = 0;
  while (n < 16) {
    const band = VP8_K_BANDS[n];
    const pOff = planeBase + (band * 3 + ctx) * 11;
    if (checkEob && br.getBit(coeffsProba[pOff + 0]) === 0) {
      return hasNz;
    }
    if (br.getBit(coeffsProba[pOff + 1]) === 0) {
      ctx = 0;
      checkEob = false;
      n += 1;
      if (n === 16) return hasNz;
      continue;
    }
    hasNz = 1;
    if (br.getBit(coeffsProba[pOff + 2]) === 0) {
      ctx = 1;
    } else {
      ctx = 2;
      if (br.getBit(coeffsProba[pOff + 3]) === 0) {
        if (br.getBit(coeffsProba[pOff + 4]) !== 0) {
          br.getBit(coeffsProba[pOff + 5]);
        }
      } else if (br.getBit(coeffsProba[pOff + 6]) === 0) {
        if (br.getBit(coeffsProba[pOff + 7]) === 0) {
          br.getBit(159);
        } else {
          br.getBit(165);
          br.getBit(145);
        }
      } else {
        const b1 = br.getBit(coeffsProba[pOff + 8]);
        const b0 = br.getBit(coeffsProba[pOff + 9 + b1]);
        const tab = VP8_K_CATS[(b1 << 1) + b0];
        let idx = 0;
        while (tab[idx] !== 0) {
          br.getBit(tab[idx]);
          idx += 1;
        }
      }
    }
    br.getBit(128);
    checkEob = true;
    n += 1;
  }
  return hasNz;
}

function inspectVp8Payload(
  payload: Uint8Array,
  decodeCompressed: boolean,
): { status: ImageValidationStatus; width: number; height: number } {
  if (payload.length < 10) return { status: 'corrupt', width: 0, height: 0 };
  const tag = payload[0] | (payload[1] << 8) | (payload[2] << 16);
  if ((tag & 1) !== 0) return { status: 'corrupt', width: 0, height: 0 };
  const version = (tag >>> 1) & 0x07;
  const showFrame = (tag >>> 4) & 0x01;
  if (version > 3 || showFrame === 0) return { status: 'corrupt', width: 0, height: 0 };
  const firstPartSize = (tag >>> 5) & 0x7ffff;
  if (firstPartSize < 1 || 10 + firstPartSize > payload.length) {
    return { status: 'corrupt', width: 0, height: 0 };
  }
  if (payload[3] !== 0x9d || payload[4] !== 0x01 || payload[5] !== 0x2a) {
    return { status: 'corrupt', width: 0, height: 0 };
  }
  const width = (payload[6] | (payload[7] << 8)) & 0x3fff;
  const height = (payload[8] | (payload[9] << 8)) & 0x3fff;
  if (width === 0 || height === 0) return { status: 'corrupt', width: 0, height: 0 };

  const br0 = new Vp8BoolReader(payload, 10, firstPartSize);
  const colorSpace = br0.getBit(128);
  br0.getBit(128); // clamping_type
  if (colorSpace !== 0) return { status: 'corrupt', width, height };

  const updateSeg = br0.getBit(128);
  let updateMbSegMap = 0;
  const segProbs = [255, 255, 255];
  if (updateSeg) {
    updateMbSegMap = br0.getBit(128);
    if (br0.getBit(128)) {
      br0.getBit(128);
      for (let i = 0; i < 4; i++) {
        if (br0.getBit(128)) br0.getSigned(7);
      }
      for (let i = 0; i < 4; i++) {
        if (br0.getBit(128)) br0.getSigned(6);
      }
    }
    if (updateMbSegMap) {
      for (let s = 0; s < 3; s++) {
        if (br0.getBit(128)) segProbs[s] = br0.getBits(8);
      }
    }
  }

  br0.getBit(128);
  br0.getBits(6);
  br0.getBits(3);
  if (br0.getBit(128) && br0.getBit(128)) {
    for (let i = 0; i < 8; i++) {
      if (br0.getBit(128)) br0.getSigned(6);
    }
  }
  if (br0.eof) return { status: 'corrupt', width, height };

  const log2Parts = br0.getBits(2);
  const numParts = 1 << log2Parts;
  const restStart = 10 + firstPartSize;
  const sizeTableBytes = 3 * (numParts - 1);
  if (restStart + sizeTableBytes > payload.length) {
    return { status: 'corrupt', width, height };
  }

  const partReaders: Vp8BoolReader[] = [];
  let curOff = restStart + sizeTableBytes;
  for (let p = 0; p < numParts - 1; p++) {
    const so = restStart + 3 * p;
    const psize = payload[so] | (payload[so + 1] << 8) | (payload[so + 2] << 16);
    if (curOff + psize > payload.length) {
      return { status: 'corrupt', width, height };
    }
    if (decodeCompressed && width * height <= MAX_WEBP_PIXELS) {
      partReaders.push(new Vp8BoolReader(payload, curOff, psize));
    }
    curOff += psize;
  }
  if (!decodeCompressed || width * height > MAX_WEBP_PIXELS) {
    return { status: 'unsupported', width, height };
  }
  partReaders.push(new Vp8BoolReader(payload, curOff, payload.length - curOff));

  br0.getBits(7);
  for (let i = 0; i < 5; i++) {
    if (br0.getBit(128)) br0.getSigned(4);
  }
  br0.getBit(128);

  const coeffsProba = Uint8Array.from(VP8_COEFFS_PROBA0);
  for (let i = 0; i < 1056; i++) {
    if (br0.getBit(VP8_COEFFS_UPDATE_PROBA[i])) {
      coeffsProba[i] = br0.getBits(8);
    }
  }

  const mbNoSkipCoeff = br0.getBit(128);
  const probSkipFalse = mbNoSkipCoeff ? br0.getBits(8) : 0;
  if (br0.eof) return { status: 'corrupt', width, height };

  const mbW = (width + 15) >> 4;
  const mbH = (height + 15) >> 4;
  const topBmodes = new Uint8Array(mbW * 4);
  const topNz = new Uint8Array(mbW * 9);
  const subModes = new Uint8Array(16);
  const leftBmodes = new Uint8Array(4);
  const leftNz = new Uint8Array(9);

  for (let mbY = 0; mbY < mbH; mbY++) {
    leftBmodes.fill(0);
    leftNz.fill(0);
    const tokenBr = partReaders[mbY & (numParts - 1)];

    for (let mbX = 0; mbX < mbW; mbX++) {
      if (updateSeg && updateMbSegMap) {
        if (br0.getBit(segProbs[0]) === 0) br0.getBit(segProbs[1]);
        else br0.getBit(segProbs[2]);
      }
      const skip = mbNoSkipCoeff ? br0.getBit(probSkipFalse) : 0;
      const ymode = readVp8KfYmode(br0);
      const isI4x4 = ymode === 4;
      if (isI4x4) {
        for (let by = 0; by < 4; by++) {
          for (let bx = 0; bx < 4; bx++) {
            const above = by === 0 ? topBmodes[mbX * 4 + bx] : subModes[(by - 1) * 4 + bx];
            const left = bx === 0 ? leftBmodes[by] : subModes[by * 4 + (bx - 1)];
            subModes[by * 4 + bx] = readVp8KfBmode(br0, (above * 10 + left) * 9);
          }
        }
        for (let bx = 0; bx < 4; bx++) topBmodes[mbX * 4 + bx] = subModes[12 + bx];
        for (let by = 0; by < 4; by++) leftBmodes[by] = subModes[by * 4 + 3];
      } else {
        const fillBm = VP8_YMODE_TO_BMODE[ymode];
        for (let i = 0; i < 4; i++) {
          topBmodes[mbX * 4 + i] = fillBm;
          leftBmodes[i] = fillBm;
        }
      }
      readVp8KfUvMode(br0);
      if (br0.eof) return { status: 'corrupt', width, height };

      const topBase = mbX * 9;
      if (skip) {
        for (let k = 0; k < 8; k++) {
          topNz[topBase + k] = 0;
          leftNz[k] = 0;
        }
        if (!isI4x4) {
          topNz[topBase + 8] = 0;
          leftNz[8] = 0;
        }
        if (tokenBr.eof) return { status: 'corrupt', width, height };
        continue;
      }

      let yPlaneType = 3;
      let yFirst = 0;
      if (!isI4x4) {
        const nzY2 = decodeVp8CoeffsBlock(tokenBr, coeffsProba, 1, topNz[topBase + 8] + leftNz[8], 0);
        topNz[topBase + 8] = nzY2;
        leftNz[8] = nzY2;
        yPlaneType = 0;
        yFirst = 1;
      }

      for (let by = 0; by < 4; by++) {
        for (let bx = 0; bx < 4; bx++) {
          const nz = decodeVp8CoeffsBlock(
            tokenBr,
            coeffsProba,
            yPlaneType,
            topNz[topBase + bx] + leftNz[by],
            yFirst,
          );
          topNz[topBase + bx] = nz;
          leftNz[by] = nz;
        }
      }

      for (let by = 0; by < 2; by++) {
        for (let bx = 0; bx < 2; bx++) {
          const nz = decodeVp8CoeffsBlock(
            tokenBr,
            coeffsProba,
            2,
            topNz[topBase + 4 + bx] + leftNz[4 + by],
            0,
          );
          topNz[topBase + 4 + bx] = nz;
          leftNz[4 + by] = nz;
        }
      }

      for (let by = 0; by < 2; by++) {
        for (let bx = 0; bx < 2; bx++) {
          const nz = decodeVp8CoeffsBlock(
            tokenBr,
            coeffsProba,
            2,
            topNz[topBase + 6 + bx] + leftNz[6 + by],
            0,
          );
          topNz[topBase + 6 + bx] = nz;
          leftNz[6 + by] = nz;
        }
      }

      if (tokenBr.eof) return { status: 'corrupt', width, height };
    }
  }

  return { status: 'valid', width, height };
}

class Vp8lBitReader {
  private bitPos: number;
  private readonly maxBits: number;

  constructor(
    private readonly buf: Uint8Array,
    startByte: number,
  ) {
    this.bitPos = startByte * 8;
    this.maxBits = buf.length * 8;
  }

  readBits(n: number): number {
    if (n === 0) return 0;
    if (this.bitPos + n > this.maxBits) return -1;
    let val = 0;
    let shift = 0;
    let rem = n;
    let bp = this.bitPos;
    while (rem > 0) {
      const byteIdx = bp >>> 3;
      const bitOff = bp & 7;
      const take = Math.min(rem, 8 - bitOff);
      const mask = (1 << take) - 1;
      val |= ((this.buf[byteIdx] >>> bitOff) & mask) << shift;
      bp += take;
      shift += take;
      rem -= take;
    }
    this.bitPos = bp;
    return val >>> 0;
  }
}

interface Vp8lHuffmanTree {
  singleSym: number;
  left: Int32Array | null;
  right: Int32Array | null;
}

function buildVp8lHuffmanTree(codeLengths: Int32Array, alphabetSize: number): Vp8lHuffmanTree | null {
  const counts = new Int32Array(16);
  let nzCount = 0;
  let onlySym = 0;
  for (let sym = 0; sym < alphabetSize; sym++) {
    const cl = codeLengths[sym];
    if (cl < 0 || cl > 15) return null;
    if (cl > 0) {
      counts[cl] += 1;
      nzCount += 1;
      onlySym = sym;
    }
  }
  if (nzCount === 0) return null;
  if (nzCount === 1) {
    return { singleSym: onlySym, left: null, right: null };
  }

  let kraft = 0;
  for (let cl = 1; cl <= 15; cl++) {
    kraft += counts[cl] << (15 - cl);
  }
  if (kraft !== 1 << 15) return null;

  const nextCode = new Int32Array(16);
  let code = 0;
  for (let bits = 1; bits <= 15; bits++) {
    code = (code + counts[bits - 1]) << 1;
    nextCode[bits] = code;
  }

  const maxNodes = nzCount * 15 + 1;
  const left = new Int32Array(maxNodes).fill(-1);
  const right = new Int32Array(maxNodes).fill(-1);
  let nodeCount = 1;

  for (let sym = 0; sym < alphabetSize; sym++) {
    const cl = codeLengths[sym];
    if (cl === 0) continue;
    const c = nextCode[cl]++;
    let node = 0;
    for (let bitPos = cl - 1; bitPos >= 0; bitPos--) {
      const bit = (c >>> bitPos) & 1;
      const arr = bit ? right : left;
      let nxt = arr[node];
      if (bitPos === 0) {
        if (nxt !== -1) return null;
        arr[node] = -2 - sym;
      } else {
        if (nxt < -1) return null;
        if (nxt === -1) {
          if (nodeCount >= maxNodes) return null;
          nxt = nodeCount++;
          arr[node] = nxt;
        }
        node = nxt;
      }
    }
  }

  return {
    singleSym: -1,
    left: left.subarray(0, nodeCount),
    right: right.subarray(0, nodeCount),
  };
}

function readVp8lSymbol(br: Vp8lBitReader, tree: Vp8lHuffmanTree): number {
  if (tree.singleSym >= 0) return tree.singleSym;
  const left = tree.left!;
  const right = tree.right!;
  let node = 0;
  while (true) {
    const b = br.readBits(1);
    if (b < 0) return -1;
    const nxt = b ? right[node] : left[node];
    if (nxt === -1) return -1;
    if (nxt <= -2) return -2 - nxt;
    node = nxt;
  }
}

function readVp8lHuffmanCode(br: Vp8lBitReader, alphabetSize: number): Vp8lHuffmanTree | null {
  const simple = br.readBits(1);
  if (simple < 0) return null;
  if (simple === 1) {
    const numSyms = br.readBits(1);
    const isFirst8Bits = br.readBits(1);
    if (numSyms < 0 || isFirst8Bits < 0) return null;
    const s0 = br.readBits(isFirst8Bits ? 8 : 1);
    if (s0 < 0 || s0 >= alphabetSize) return null;
    if (numSyms === 0) return { singleSym: s0, left: null, right: null };
    const s1 = br.readBits(8);
    if (s1 < 0 || s1 >= alphabetSize || s1 === s0) return null;
    return {
      singleSym: -1,
      left: Int32Array.from([-2 - s0]),
      right: Int32Array.from([-2 - s1]),
    };
  }

  const numClRaw = br.readBits(4);
  if (numClRaw < 0) return null;
  const numCl = numClRaw + 4;
  if (numCl > 19) return null;
  const clCodeLengths = new Int32Array(19);
  for (let i = 0; i < numCl; i++) {
    const v = br.readBits(3);
    if (v < 0) return null;
    clCodeLengths[VP8L_CODE_LENGTH_ORDER[i]] = v;
  }
  const clTree = buildVp8lHuffmanTree(clCodeLengths, 19);
  if (!clTree) return null;

  const useMaxSym = br.readBits(1);
  if (useMaxSym < 0) return null;
  let maxSym = alphabetSize;
  if (useMaxSym === 1) {
    const lenNbitsRaw = br.readBits(3);
    if (lenNbitsRaw < 0) return null;
    const lenNbits = 2 + 2 * lenNbitsRaw;
    const maxSymRaw = br.readBits(lenNbits);
    if (maxSymRaw < 0) return null;
    maxSym = maxSymRaw + 2;
    if (maxSym > alphabetSize) return null;
  }

  const codeLengths = new Int32Array(alphabetSize);
  let prevNz = 8;
  let sym = 0;
  let rem = maxSym;
  while (sym < alphabetSize && rem > 0) {
    rem -= 1;
    const codeLen = readVp8lSymbol(br, clTree);
    if (codeLen < 0) return null;
    if (codeLen < 16) {
      codeLengths[sym++] = codeLen;
      if (codeLen !== 0) prevNz = codeLen;
    } else {
      let repeat = 0;
      let repVal = 0;
      if (codeLen === 16) {
        const extra = br.readBits(2);
        if (extra < 0) return null;
        repeat = extra + 3;
        repVal = prevNz;
      } else if (codeLen === 17) {
        const extra = br.readBits(3);
        if (extra < 0) return null;
        repeat = extra + 3;
      } else {
        const extra = br.readBits(7);
        if (extra < 0) return null;
        repeat = extra + 11;
      }
      if (sym + repeat > alphabetSize) return null;
      for (let r = 0; r < repeat; r++) codeLengths[sym++] = repVal;
    }
  }

  return buildVp8lHuffmanTree(codeLengths, alphabetSize);
}

function decodeVp8lPrefixVal(sym: number, br: Vp8lBitReader): number {
  if (sym < 4) return sym + 1;
  const extraBits = (sym - 2) >> 1;
  const offset = (2 + (sym & 1)) << extraBits;
  const eb = br.readBits(extraBits);
  if (eb < 0) return -1;
  return offset + eb + 1;
}

function vp8lSubsampleSize(size: number, bits: number): number {
  return (size + (1 << bits) - 1) >>> bits;
}

function decodeVp8lImageStream(
  br: Vp8lBitReader,
  width: number,
  height: number,
  isLevel0: boolean,
): { status: ImageValidationStatus; pixels: Uint32Array | null } {
  let seenTransforms = 0;
  let curW = width;
  if (isLevel0) {
    while (true) {
      const hasTr = br.readBits(1);
      if (hasTr < 0) return { status: 'corrupt', pixels: null };
      if (hasTr === 0) break;
      const trType = br.readBits(2);
      if (trType < 0 || (seenTransforms & (1 << trType)) !== 0) {
        return { status: 'corrupt', pixels: null };
      }
      seenTransforms |= 1 << trType;
      if (trType === 0 || trType === 1) {
        const sb = br.readBits(3);
        if (sb < 0) return { status: 'corrupt', pixels: null };
        const sizeBits = sb + 2;
        const sub = decodeVp8lImageStream(
          br,
          vp8lSubsampleSize(curW, sizeBits),
          vp8lSubsampleSize(height, sizeBits),
          false,
        );
        if (sub.status !== 'valid') return { status: sub.status, pixels: null };
      } else if (trType === 3) {
        const palRaw = br.readBits(8);
        if (palRaw < 0) return { status: 'corrupt', pixels: null };
        const palSize = palRaw + 1;
        const sub = decodeVp8lImageStream(br, palSize, 1, false);
        if (sub.status !== 'valid') return { status: sub.status, pixels: null };
        const widthBits = palSize <= 2 ? 3 : palSize <= 4 ? 2 : palSize <= 16 ? 1 : 0;
        curW = vp8lSubsampleSize(curW, widthBits);
      }
    }
  }

  const useCc = br.readBits(1);
  if (useCc < 0) return { status: 'corrupt', pixels: null };
  let ccBits = 0;
  if (useCc === 1) {
    ccBits = br.readBits(4);
    if (ccBits < 1 || ccBits > 11) return { status: 'corrupt', pixels: null };
  }
  const ccSize = ccBits > 0 ? 1 << ccBits : 0;

  let numHtreeGroups = 1;
  let entropyImg: Uint32Array | null = null;
  let huffBits = 0;
  let huffXsize = 0;
  if (isLevel0) {
    const useMeta = br.readBits(1);
    if (useMeta < 0) return { status: 'corrupt', pixels: null };
    if (useMeta === 1) {
      const hb = br.readBits(3);
      if (hb < 0) return { status: 'corrupt', pixels: null };
      huffBits = hb + 2;
      huffXsize = vp8lSubsampleSize(curW, huffBits);
      const huffYsize = vp8lSubsampleSize(height, huffBits);
      const metaRes = decodeVp8lImageStream(br, huffXsize, huffYsize, false);
      if (metaRes.status !== 'valid' || !metaRes.pixels) {
        return { status: metaRes.status, pixels: null };
      }
      entropyImg = metaRes.pixels;
      let maxGrp = 0;
      for (let i = 0; i < entropyImg.length; i++) {
        const grp = (entropyImg[i] >>> 8) & 0xffff;
        if (grp > maxGrp) maxGrp = grp;
      }
      numHtreeGroups = maxGrp + 1;
      if (numHtreeGroups > MAX_WEBP_HTREE_GROUPS) {
        return { status: 'unsupported', pixels: null };
      }
    }
  }

  const greenAlphaSize = 256 + 24 + ccSize;
  const groups: Array<[Vp8lHuffmanTree, Vp8lHuffmanTree, Vp8lHuffmanTree, Vp8lHuffmanTree, Vp8lHuffmanTree]> = [];
  for (let g = 0; g < numHtreeGroups; g++) {
    const tGreen = readVp8lHuffmanCode(br, greenAlphaSize);
    if (!tGreen) return { status: 'corrupt', pixels: null };
    const tRed = readVp8lHuffmanCode(br, 256);
    if (!tRed) return { status: 'corrupt', pixels: null };
    const tBlue = readVp8lHuffmanCode(br, 256);
    if (!tBlue) return { status: 'corrupt', pixels: null };
    const tAlpha = readVp8lHuffmanCode(br, 256);
    if (!tAlpha) return { status: 'corrupt', pixels: null };
    const tDist = readVp8lHuffmanCode(br, 40);
    if (!tDist) return { status: 'corrupt', pixels: null };
    groups.push([tGreen, tRed, tBlue, tAlpha, tDist]);
  }

  const totalPixels = curW * height;
  const needPixels = !isLevel0;
  const pixels = needPixels || ccSize > 0 ? new Uint32Array(totalPixels) : null;
  const colorCache = ccSize > 0 ? new Uint32Array(ccSize) : null;
  const hashShift = ccBits > 0 ? 32 - ccBits : 0;

  let pos = 0;
  let grp = groups[0];
  while (pos < totalPixels) {
    if (entropyImg) {
      const x = pos % curW;
      const y = (pos - x) / curW;
      const metaIdx = (y >>> huffBits) * huffXsize + (x >>> huffBits);
      grp = groups[(entropyImg[metaIdx] >>> 8) & 0xffff];
    }
    const code = readVp8lSymbol(br, grp[0]);
    if (code < 0) return { status: 'corrupt', pixels: null };
    if (code < 256) {
      const r = readVp8lSymbol(br, grp[1]);
      const b = readVp8lSymbol(br, grp[2]);
      const a = readVp8lSymbol(br, grp[3]);
      if (r < 0 || b < 0 || a < 0) return { status: 'corrupt', pixels: null };
      const argb = (((a << 24) | (r << 16) | (code << 8) | b) >>> 0);
      if (pixels) pixels[pos] = argb;
      if (colorCache) {
        colorCache[Math.imul(argb, 0x1e35a7bd) >>> hashShift] = argb;
      }
      pos += 1;
    } else if (code < 280) {
      const length = decodeVp8lPrefixVal(code - 256, br);
      if (length < 0) return { status: 'corrupt', pixels: null };
      const distSym = readVp8lSymbol(br, grp[4]);
      if (distSym < 0) return { status: 'corrupt', pixels: null };
      const distCode = decodeVp8lPrefixVal(distSym, br);
      if (distCode < 0) return { status: 'corrupt', pixels: null };
      let dist = 0;
      if (distCode <= 120) {
        const pt = VP8L_CODE_TO_PLANE[distCode - 1];
        const yoff = pt >>> 4;
        const xoff = 8 - (pt & 0x0f);
        dist = yoff * curW + xoff;
        if (dist < 1) dist = 1;
      } else {
        dist = distCode - 120;
      }
      if (dist > pos || pos + length > totalPixels) {
        return { status: 'corrupt', pixels: null };
      }
      let src = pos - dist;
      for (let k = 0; k < length; k++) {
        if (pixels) {
          const argb = pixels[src];
          pixels[pos] = argb;
          if (colorCache) {
            colorCache[Math.imul(argb, 0x1e35a7bd) >>> hashShift] = argb;
          }
        }
        pos += 1;
        src += 1;
      }
    } else {
      const ccIdx = code - 280;
      if (!colorCache || ccIdx >= ccSize) return { status: 'corrupt', pixels: null };
      if (pixels) pixels[pos] = colorCache[ccIdx];
      pos += 1;
    }
  }

  return { status: 'valid', pixels: needPixels ? pixels : null };
}

function inspectVp8lPayload(
  payload: Uint8Array,
  decodeCompressed: boolean,
): { status: ImageValidationStatus; width: number; height: number } {
  if (payload.length < 6 || payload[0] !== 0x2f) {
    return { status: 'corrupt', width: 0, height: 0 };
  }
  const hdr = readU32LE(payload, 1);
  const version = (hdr >>> 29) & 0x07;
  if (version !== 0) return { status: 'corrupt', width: 0, height: 0 };
  const width = (hdr & 0x3fff) + 1;
  const height = ((hdr >>> 14) & 0x3fff) + 1;
  if (!decodeCompressed || width * height > MAX_WEBP_PIXELS) {
    return { status: 'unsupported', width, height };
  }
  const res = decodeVp8lImageStream(new Vp8lBitReader(payload, 5), width, height, true);
  return { status: res.status, width, height };
}

function inspectWebpAlphPayload(
  payload: Uint8Array,
  width: number,
  height: number,
  decodeCompressed: boolean,
): ImageValidationStatus {
  if (payload.length < 2 || width <= 0 || height <= 0) return 'corrupt';
  const hdr = payload[0];
  if ((hdr & 0xc0) !== 0) return 'corrupt';
  const comp = hdr & 0x03;
  const filt = (hdr >>> 2) & 0x03;
  const pre = (hdr >>> 4) & 0x03;
  if (comp > 1 || filt > 3 || pre > 1) return 'corrupt';
  if (comp === 0) {
    if (payload.length - 1 !== width * height) return 'corrupt';
    return !decodeCompressed || width * height > MAX_WEBP_PIXELS ? 'unsupported' : 'valid';
  }
  if (!decodeCompressed || width * height > MAX_WEBP_PIXELS) return 'unsupported';
  return decodeVp8lImageStream(new Vp8lBitReader(payload, 1), width, height, true).status;
}

function readU24LE(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16);
}

function inspectWebpAnmfPayload(
  payload: Uint8Array,
  canvasW: number,
  canvasH: number,
  decodeCompressed: boolean,
): ImageValidationStatus {
  if (payload.length < 24 || (payload[15] & 0xfc) !== 0) return 'corrupt';
  const frameX = readU24LE(payload, 0) * 2;
  const frameY = readU24LE(payload, 3) * 2;
  const fw = readU24LE(payload, 6) + 1;
  const fh = readU24LE(payload, 9) + 1;
  if (frameX + fw > canvasW || frameY + fh > canvasH) return 'corrupt';

  let pos = 16;
  let sawFrameBitstream = false;
  let pendingAlph: Uint8Array | null = null;
  let sawUnsupported = !decodeCompressed;

  while (pos < payload.length) {
    if (pos + 8 > payload.length) return 'corrupt';
    if (
      !isWebpFourCcByte(payload[pos]) ||
      !isWebpFourCcByte(payload[pos + 1]) ||
      !isWebpFourCcByte(payload[pos + 2]) ||
      !isWebpFourCcByte(payload[pos + 3])
    ) {
      return 'corrupt';
    }
    const fourCc = Buffer.from(payload.buffer, payload.byteOffset + pos, 4).toString('ascii');
    const subLen = readU32LE(payload, pos + 4);
    if (pos + 8 + subLen > payload.length) return 'corrupt';
    const subPayload = payload.subarray(pos + 8, pos + 8 + subLen);
    if (fourCc === 'ALPH') {
      if (sawFrameBitstream || pendingAlph !== null) return 'corrupt';
      pendingAlph = subPayload;
    } else if (fourCc === 'VP8 ') {
      if (sawFrameBitstream) return 'corrupt';
      const vp8Res = inspectVp8Payload(subPayload, decodeCompressed);
      if (vp8Res.status === 'corrupt' || vp8Res.width !== fw || vp8Res.height !== fh) {
        return 'corrupt';
      }
      if (vp8Res.status === 'unsupported') sawUnsupported = true;
      if (pendingAlph !== null) {
        const alphStatus = inspectWebpAlphPayload(pendingAlph, fw, fh, decodeCompressed);
        if (alphStatus === 'corrupt') return 'corrupt';
        if (alphStatus === 'unsupported') sawUnsupported = true;
        pendingAlph = null;
      }
      sawFrameBitstream = true;
    } else if (fourCc === 'VP8L') {
      if (sawFrameBitstream || pendingAlph !== null) return 'corrupt';
      const vp8lRes = inspectVp8lPayload(subPayload, decodeCompressed);
      if (vp8lRes.status === 'corrupt' || vp8lRes.width !== fw || vp8lRes.height !== fh) {
        return 'corrupt';
      }
      if (vp8lRes.status === 'unsupported') sawUnsupported = true;
      sawFrameBitstream = true;
    }
    const pad = (subLen & 1) !== 0 && pos + 8 + subLen < payload.length ? 1 : 0;
    pos += 8 + subLen + pad;
  }

  if (!sawFrameBitstream || pendingAlph !== null || pos !== payload.length) return 'corrupt';
  return sawUnsupported ? 'unsupported' : 'valid';
}

export function inspectWebpBytes(data: Uint8Array): ImageValidationStatus {
  if (data.length < 20) return 'corrupt';
  const riff = Buffer.from(data.buffer, data.byteOffset, 4).toString('ascii');
  const webp = Buffer.from(data.buffer, data.byteOffset + 8, 4).toString('ascii');
  if (riff !== 'RIFF' || webp !== 'WEBP') return 'corrupt';
  const riffSize = readU32LE(data, 4);
  const riffEnd = 8 + riffSize;
  if (riffSize < 12 || riffEnd > data.length) return 'corrupt';
  if (riffEnd !== data.length && !(riffEnd + 1 === data.length && data[riffEnd] === 0x00)) {
    return 'corrupt';
  }

  let pos = 12;
  let validImageChunks = 0;
  let anmfFrames = 0;
  let sawVp8x = false;
  let vp8xAnim = false;
  let sawAnimHeader = false;
  let canvasW = 0;
  let canvasH = 0;
  let pendingAlph: Uint8Array | null = null;
  let sawUnsupported = false;

  while (pos < riffEnd) {
    if (pos + 8 > riffEnd) return 'corrupt';
    if (
      !isWebpFourCcByte(data[pos]) ||
      !isWebpFourCcByte(data[pos + 1]) ||
      !isWebpFourCcByte(data[pos + 2]) ||
      !isWebpFourCcByte(data[pos + 3])
    ) {
      return 'corrupt';
    }
    const fourCc = Buffer.from(data.buffer, data.byteOffset + pos, 4).toString('ascii');
    const chunkLen = readU32LE(data, pos + 4);
    if (pos + 8 + chunkLen > riffEnd) return 'corrupt';
    const payload = data.subarray(pos + 8, pos + 8 + chunkLen);
    if (fourCc === 'VP8X') {
      if (pos !== 12 || sawVp8x || chunkLen !== 10) return 'corrupt';
      if ((payload[0] & 0xc0) !== 0 || payload[1] !== 0 || payload[2] !== 0 || payload[3] !== 0) {
        return 'corrupt';
      }
      sawVp8x = true;
      vp8xAnim = (payload[0] & 0x02) !== 0;
      canvasW = readU24LE(payload, 4) + 1;
      canvasH = readU24LE(payload, 7) + 1;
    } else if (fourCc === 'ANIM') {
      if (!sawVp8x || !vp8xAnim || sawAnimHeader || anmfFrames > 0 || chunkLen !== 6) {
        return 'corrupt';
      }
      sawAnimHeader = true;
    } else if (fourCc === 'ALPH') {
      if (!sawVp8x || vp8xAnim || pendingAlph !== null || validImageChunks > 0) {
        return 'corrupt';
      }
      pendingAlph = payload;
    } else if (fourCc === 'VP8 ') {
      if (vp8xAnim || validImageChunks > 0) return 'corrupt';
      const vp8Res = inspectVp8Payload(payload, true);
      if (vp8Res.status === 'corrupt') return 'corrupt';
      if (sawVp8x && (vp8Res.width !== canvasW || vp8Res.height !== canvasH)) return 'corrupt';
      if (vp8Res.status === 'unsupported') sawUnsupported = true;
      if (pendingAlph !== null) {
        const alphStatus = inspectWebpAlphPayload(pendingAlph, vp8Res.width, vp8Res.height, true);
        if (alphStatus === 'corrupt') return 'corrupt';
        if (alphStatus === 'unsupported') sawUnsupported = true;
        pendingAlph = null;
      }
      validImageChunks += 1;
    } else if (fourCc === 'VP8L') {
      if (vp8xAnim || validImageChunks > 0 || pendingAlph !== null) return 'corrupt';
      const vp8lRes = inspectVp8lPayload(payload, true);
      if (vp8lRes.status === 'corrupt') return 'corrupt';
      if (sawVp8x && (vp8lRes.width !== canvasW || vp8lRes.height !== canvasH)) return 'corrupt';
      if (vp8lRes.status === 'unsupported') sawUnsupported = true;
      validImageChunks += 1;
    } else if (fourCc === 'ANMF') {
      if (!sawVp8x || !vp8xAnim || !sawAnimHeader) return 'corrupt';
      const anmfStatus = inspectWebpAnmfPayload(
        payload,
        canvasW,
        canvasH,
        anmfFrames < MAX_WEBP_ANMF_FRAMES,
      );
      if (anmfStatus === 'corrupt') return 'corrupt';
      if (anmfStatus === 'unsupported') sawUnsupported = true;
      anmfFrames += 1;
      validImageChunks += 1;
    }
    const pad = (chunkLen & 1) !== 0 && pos + 8 + chunkLen < riffEnd ? 1 : 0;
    pos += 8 + chunkLen + pad;
  }
  if (pos !== riffEnd || validImageChunks < 1 || pendingAlph !== null) return 'corrupt';
  return sawUnsupported ? 'unsupported' : 'valid';
}

export function isValidWebpBytes(data: Uint8Array): boolean {
  return inspectWebpBytes(data) === 'valid';
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
  // Insert COM segments (FF FE) and any 1..3 0xFF marker-fill bytes immediately after SOI (FF D8)
  // and BEFORE APP0/SOS per ITU-T T.81 B.1.1.2 & B.2.3 (never inside entropy-coded scan data).
  const soi = MINIMAL_1X1_JPEG.subarray(0, 2);
  const afterSoi = MINIMAL_1X1_JPEG.subarray(2);
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
    // ITU-T T.81 B.1.1.2: any number of 0xFF fill bytes may precede the next marker (FF E0).
    extraParts.push(Buffer.alloc(rem, 0xff));
  }
  const out = Buffer.concat([soi, ...extraParts, afterSoi]);
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
  const vp8lPad = MINIMAL_1X1_WEBP_VP8L_DATA.length % 2;
  const vp8lChunk = Buffer.alloc(8 + MINIMAL_1X1_WEBP_VP8L_DATA.length + vp8lPad, 0);
  vp8lChunk.write('VP8L', 0, 4, 'ascii');
  vp8lChunk.writeUInt32LE(MINIMAL_1X1_WEBP_VP8L_DATA.length, 4);
  MINIMAL_1X1_WEBP_VP8L_DATA.copy(vp8lChunk, 8);
  const baseLen = 12 + vp8lChunk.length; // 'RIFF' + size + 'WEBP' + 2-byte-aligned VP8L chunk (38 bytes)
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

interface SupportedMimeSpec {
  mime: SupportedImageMime;
  ext: string;
  inspect: (data: Uint8Array) => ImageValidationStatus;
  buildReplacement: (size: number) => Buffer | null;
}

const SUPPORTED_MIMES_BY_NAME = new Map<string, SupportedMimeSpec>([
  [
    'image/png',
    {
      mime: 'image/png',
      ext: 'png',
      inspect: inspectPngBytes,
      buildReplacement: buildExactSizeValidPng,
    },
  ],
  [
    'image/jpeg',
    {
      mime: 'image/jpeg',
      ext: 'jpg',
      inspect: inspectJpegBytes,
      buildReplacement: buildExactSizeValidJpeg,
    },
  ],
  [
    'image/gif',
    {
      mime: 'image/gif',
      ext: 'gif',
      inspect: inspectGifBytes,
      buildReplacement: buildExactSizeValidGif,
    },
  ],
  [
    'image/webp',
    {
      mime: 'image/webp',
      ext: 'webp',
      inspect: inspectWebpBytes,
      buildReplacement: buildExactSizeValidWebp,
    },
  ],
]);

const UTF8_FATAL_DECODER = new TextDecoder('utf-8', { fatal: true });
const MAX_STEP_SCHEMA_DEPTH = 32;

// Exact backward- & forward-reachable protobuf schema transition graph from
// `.gemini_coder.Step` (`steps.step_payload`) to `.exa.codeium_common_pb.Media` ('MEDIA').
const STEP_MEDIA_SCHEMA_FSM: Record<string, Readonly<Record<number, string>>> = {
  '.exa.chat_pb.ChatMessagePrompt': { 6: '.exa.codeium_common_pb.ChatToolCall', 19: 'MEDIA' },
  '.exa.codeium_common_pb.ArtifactComment': {
    5: '.exa.codeium_common_pb.ArtifactFullFileTarget',
    6: '.exa.codeium_common_pb.ArtifactSelectionTarget',
  },
  '.exa.codeium_common_pb.ArtifactFullFileTarget': { 2: 'MEDIA' },
  '.exa.codeium_common_pb.ArtifactImageSelection': { 6: 'MEDIA' },
  '.exa.codeium_common_pb.ArtifactSelection': { 2: '.exa.codeium_common_pb.ArtifactImageSelection' },
  '.exa.codeium_common_pb.ArtifactSelectionTarget': { 1: '.exa.codeium_common_pb.ArtifactSelection' },
  '.exa.codeium_common_pb.ChatToolCall': { 10: 'MEDIA' },
  '.exa.codeium_common_pb.ContextScopeItem': { 26: '.exa.codeium_common_pb.McpPromptScopeItem' },
  '.exa.codeium_common_pb.FileComment': { 2: '.exa.codeium_common_pb.FileCommentInfo' },
  '.exa.codeium_common_pb.FileCommentInfo': { 3: '.exa.codeium_common_pb.ArtifactImageSelection' },
  '.exa.codeium_common_pb.KnowledgeBaseGroup': {
    2: '.exa.codeium_common_pb.KnowledgeBaseItemWithMetadata',
    3: '.exa.codeium_common_pb.KnowledgeBaseGroup',
  },
  '.exa.codeium_common_pb.KnowledgeBaseItem': { 10: 'MEDIA' },
  '.exa.codeium_common_pb.KnowledgeBaseItemWithMetadata': { 1: '.exa.codeium_common_pb.KnowledgeBaseItem' },
  '.exa.codeium_common_pb.McpPromptMessage': { 3: 'MEDIA', 4: '.exa.codeium_common_pb.McpResourceContent' },
  '.exa.codeium_common_pb.McpPromptScopeItem': { 6: '.exa.codeium_common_pb.McpPromptMessage' },
  '.exa.codeium_common_pb.McpResourceContent': { 4: 'MEDIA' },
  '.exa.codeium_common_pb.TextOrScopeItem': { 2: '.exa.codeium_common_pb.ContextScopeItem' },
  '.exa.cortex_pb.AgentConfig': {
    1: '.exa.cortex_pb.DeclarativeComponentConfig',
    3: '.exa.cortex_pb.CascadeConfig',
    4: '.exa.cortex_pb.CustomizationDiscoveryConfig',
  },
  '.exa.cortex_pb.AgentConfigResolution': { 1: '.exa.cortex_pb.CustomAgentSpec' },
  '.exa.cortex_pb.AgentDiscoveryConfig': { 3: '.exa.cortex_pb.AgentScriptItem' },
  '.exa.cortex_pb.AgentMessage': { 12: '.exa.cortex_pb.SourceMetadata' },
  '.exa.cortex_pb.AgentScriptItem': { 7: '.exa.cortex_pb.CustomAgentSpec', 11: '.exa.cortex_pb.CascadeConfig' },
  '.exa.cortex_pb.BuiltinAgentConfig': {
    3: '.exa.cortex_pb.CascadeConfig',
    4: '.exa.cortex_pb.CustomizationDiscoveryConfig',
  },
  '.exa.cortex_pb.CapturedUserRequest': { 2: 'MEDIA' },
  '.exa.cortex_pb.CascadeConfig': { 1: '.exa.cortex_pb.CascadePlannerConfig' },
  '.exa.cortex_pb.CascadePlannerConfig': {
    13: '.exa.cortex_pb.CascadeToolConfig',
    42: '.exa.cortex_pb.CustomizationConfig',
    46: '.exa.cortex_pb.DeclarativeComponentConfig',
    57: '.exa.cortex_pb.CustomizationDiscoveryConfig',
  },
  '.exa.cortex_pb.CascadeToolConfig': { 21: '.exa.cortex_pb.ReadKnowledgeBaseItemToolConfig' },
  '.exa.cortex_pb.ChatModelMetadata': { 2: '.exa.chat_pb.ChatMessagePrompt' },
  '.exa.cortex_pb.CortexStepBrowserDragPixelToPixel': { 8: 'MEDIA' },
  '.exa.cortex_pb.CortexStepBrowserSubagent': { 11: 'MEDIA' },
  '.exa.cortex_pb.CortexStepCaptureBrowserScreenshot': { 11: 'MEDIA' },
  '.exa.cortex_pb.CortexStepCheckpoint': {
    30: '.exa.cortex_pb.CapturedUserRequest',
    31: '.exa.cortex_pb.CapturedUserRequest',
  },
  '.exa.cortex_pb.CortexStepClickBrowserPixel': { 6: 'MEDIA' },
  '.exa.cortex_pb.CortexStepEphemeralMessage': { 2: 'MEDIA', 4: 'MEDIA' },
  '.exa.cortex_pb.CortexStepExecuteBrowserJavaScript': { 12: 'MEDIA' },
  '.exa.cortex_pb.CortexStepGenerateImage': { 6: 'MEDIA' },
  '.exa.cortex_pb.CortexStepGeneratorMetadata': {
    1: '.exa.cortex_pb.ChatModelMetadata',
    3: '.exa.cortex_pb.CascadePlannerConfig',
  },
  '.exa.cortex_pb.CortexStepGeneric': { 2: '.exa.cortex_pb.GenericStepResult' },
  '.exa.cortex_pb.CortexStepGitCommit': { 1: '.exa.cortex_pb.PlanInput' },
  '.exa.cortex_pb.CortexStepLookupKnowledgeBase': { 3: '.exa.codeium_common_pb.KnowledgeBaseItemWithMetadata' },
  '.exa.cortex_pb.CortexStepMcpTool': { 2: '.exa.codeium_common_pb.ChatToolCall', 6: 'MEDIA' },
  '.exa.cortex_pb.CortexStepMetadata': {
    4: '.exa.codeium_common_pb.ChatToolCall',
    16: '.exa.codeium_common_pb.ChatToolCall',
    29: '.exa.codeium_common_pb.ChatToolCall',
  },
  '.exa.cortex_pb.CortexStepMquery': { 1: '.exa.cortex_pb.PlanInput' },
  '.exa.cortex_pb.CortexStepOpenBrowserUrl': { 5: '.exa.codeium_common_pb.KnowledgeBaseItem', 10: 'MEDIA' },
  '.exa.cortex_pb.CortexStepPlanInput': { 1: '.exa.cortex_pb.PlanInput' },
  '.exa.cortex_pb.CortexStepPlannerResponse': {
    2: '.exa.codeium_common_pb.KnowledgeBaseItemWithMetadata',
    7: '.exa.codeium_common_pb.ChatToolCall',
    20: 'MEDIA',
  },
  '.exa.cortex_pb.CortexStepReadBrowserPage': { 2: '.exa.codeium_common_pb.KnowledgeBaseItem' },
  '.exa.cortex_pb.CortexStepReadResource': { 3: '.exa.codeium_common_pb.McpResourceContent' },
  '.exa.cortex_pb.CortexStepReadUrlContent': { 2: '.exa.codeium_common_pb.KnowledgeBaseItem' },
  '.exa.cortex_pb.CortexStepSearchKnowledgeBase': { 2: '.exa.codeium_common_pb.KnowledgeBaseGroup' },
  '.exa.cortex_pb.CortexStepSearchWeb': { 2: '.exa.codeium_common_pb.KnowledgeBaseItem' },
  '.exa.cortex_pb.CortexStepSystemMessage': { 4: '.exa.cortex_pb.AgentMessage', 6: 'MEDIA' },
  '.exa.cortex_pb.CortexStepToolCallChoice': { 1: '.exa.codeium_common_pb.ChatToolCall' },
  '.exa.cortex_pb.CortexStepToolCallProposal': { 1: '.exa.codeium_common_pb.ChatToolCall' },
  '.exa.cortex_pb.CortexStepUserInput': {
    3: '.exa.codeium_common_pb.TextOrScopeItem',
    7: '.exa.codeium_common_pb.ArtifactComment',
    9: 'MEDIA',
    11: '.exa.codeium_common_pb.FileComment',
    12: '.exa.cortex_pb.CascadeConfig',
    13: '.exa.cortex_pb.CascadeConfig',
    18: '.exa.cortex_pb.CustomAgentSpec',
  },
  '.exa.cortex_pb.CortexStepViewContentChunk': { 4: '.exa.codeium_common_pb.KnowledgeBaseItem' },
  '.exa.cortex_pb.CortexStepViewFile': { 15: 'MEDIA' },
  '.exa.cortex_pb.CortexTrajectoryMetadata': {
    4: '.exa.cortex_pb.AgentScriptItem',
    10: '.exa.cortex_pb.CustomAgentSpec',
    12: '.exa.cortex_pb.SourceMetadata',
  },
  '.exa.cortex_pb.CustomAgentSpec': {
    3: '.exa.cortex_pb.BuiltinAgentConfig',
    11: '.exa.cortex_pb.CascadeConfig',
    15: '.exa.cortex_pb.AgentDiscoveryConfig',
    17: '.exa.cortex_pb.CustomizationConfig',
    18: '.exa.cortex_pb.AgentConfig',
  },
  '.exa.cortex_pb.CustomizationConfig': { 15: '.exa.cortex_pb.CustomizationDiscoveryConfig' },
  '.exa.cortex_pb.CustomizationDiscoveryConfig': { 2: '.exa.cortex_pb.AgentDiscoveryConfig' },
  '.exa.cortex_pb.DeclarativeComponentConfig': { 12: '.exa.cortex_pb.ResolvedCustomizations' },
  '.exa.cortex_pb.ExecutorMetadata': {
    10: '.exa.cortex_pb.CascadeConfig',
    16: '.exa.cortex_pb.AgentConfigResolution',
    17: '.exa.cortex_pb.CascadeConfig',
  },
  '.exa.cortex_pb.GenericStepResult': { 4: 'MEDIA' },
  '.exa.cortex_pb.PlanInput': { 4: '.exa.codeium_common_pb.ContextScopeItem' },
  '.exa.cortex_pb.ReadKnowledgeBaseItemToolConfig': { 2: '.exa.codeium_common_pb.KnowledgeBaseItem' },
  '.exa.cortex_pb.ResolvedCustomizations': { 10: '.exa.cortex_pb.ResolvedSubagent' },
  '.exa.cortex_pb.ResolvedSubagent': { 3: '.exa.cortex_pb.AgentConfig' },
  '.exa.cortex_pb.SourceMetadata': { 1: '.exa.cortex_pb.ToolSourceMetadata' },
  '.exa.cortex_pb.ToolSourceMetadata': { 3: '.exa.codeium_common_pb.ChatToolCall' },
  '.gemini_coder.Step': {
    5: '.exa.cortex_pb.CortexStepMetadata',
    6: '.gemini_coder.Trajectory',
    8: '.exa.cortex_pb.CortexStepPlanInput',
    9: '.exa.cortex_pb.CortexStepMquery',
    11: '.exa.cortex_pb.CortexStepGitCommit',
    14: '.exa.cortex_pb.CortexStepViewFile',
    19: '.exa.cortex_pb.CortexStepUserInput',
    20: '.exa.cortex_pb.CortexStepPlannerResponse',
    30: '.exa.cortex_pb.CortexStepCheckpoint',
    35: '.exa.cortex_pb.CortexStepSearchKnowledgeBase',
    39: '.exa.cortex_pb.CortexStepLookupKnowledgeBase',
    40: '.exa.cortex_pb.CortexStepReadUrlContent',
    41: '.exa.cortex_pb.CortexStepViewContentChunk',
    42: '.exa.cortex_pb.CortexStepSearchWeb',
    47: '.exa.cortex_pb.CortexStepMcpTool',
    49: '.exa.cortex_pb.CortexStepToolCallProposal',
    50: '.exa.cortex_pb.CortexStepToolCallChoice',
    63: '.exa.cortex_pb.CortexStepReadResource',
    67: '.exa.cortex_pb.CortexStepOpenBrowserUrl',
    73: '.exa.cortex_pb.CortexStepExecuteBrowserJavaScript',
    75: '.exa.cortex_pb.CortexStepCaptureBrowserScreenshot',
    76: '.exa.cortex_pb.CortexStepClickBrowserPixel',
    79: '.exa.cortex_pb.CortexStepReadBrowserPage',
    97: '.exa.cortex_pb.CortexStepBrowserSubagent',
    103: '.exa.cortex_pb.CortexStepEphemeralMessage',
    104: '.exa.cortex_pb.CortexStepGenerateImage',
    110: '.exa.cortex_pb.CortexStepBrowserDragPixelToPixel',
    114: '.exa.cortex_pb.CortexStepSystemMessage',
    140: '.exa.cortex_pb.CortexStepGeneric',
    159: '.gemini_coder.Step',
  },
  '.gemini_coder.Trajectory': {
    2: '.gemini_coder.Step',
    3: '.exa.cortex_pb.CortexStepGeneratorMetadata',
    7: '.exa.cortex_pb.CortexTrajectoryMetadata',
    9: '.exa.cortex_pb.ExecutorMetadata',
  },
};

function readProtobufVarint53(
  buf: Uint8Array,
  startPos: number,
  endPos: number,
): { value: number; nextPos: number } | null {
  let result = 0;
  let shift = 0;
  let pos = startPos;
  while (pos < endPos && shift <= 49) {
    const b = buf[pos++];
    const low = b & 0x7f;
    if (shift === 49 && low > 0x0f) {
      return null;
    }
    result += low * 2 ** shift;
    if ((b & 0x80) === 0) {
      return Number.isSafeInteger(result) ? { value: result, nextPos: pos } : null;
    }
    shift += 7;
  }
  return null;
}

function skipProtobufVarint64(buf: Uint8Array, startPos: number, endPos: number): number | null {
  let pos = startPos;
  for (let i = 0; i < 10 && pos < endPos; i++) {
    const b = buf[pos++];
    if (i === 9 && b > 0x01) return null;
    if ((b & 0x80) === 0) return pos;
  }
  return null;
}

interface ParsedProtoFieldSpan {
  fieldNo: number;
  wire: number;
  dataStart: number;
  dataEnd: number;
}

function parseProtobufFieldsStrict(
  buf: Uint8Array,
  startPos: number,
  endPos: number,
): ParsedProtoFieldSpan[] | null {
  let pos = startPos;
  const fields: ParsedProtoFieldSpan[] = [];
  while (pos < endPos) {
    const tag = readProtobufVarint53(buf, pos, endPos);
    if (!tag || tag.value <= 0) return null;
    pos = tag.nextPos;
    const wire = tag.value & 0x07;
    const fieldNo = Math.floor(tag.value / 8);
    if (fieldNo <= 0 || fieldNo > 0x1fffffff) return null;
    if (wire === 0) {
      const next = skipProtobufVarint64(buf, pos, endPos);
      if (next === null) return null;
      fields.push({ fieldNo, wire, dataStart: pos, dataEnd: next });
      pos = next;
    } else if (wire === 1) {
      if (pos + 8 > endPos) return null;
      fields.push({ fieldNo, wire, dataStart: pos, dataEnd: pos + 8 });
      pos += 8;
    } else if (wire === 5) {
      if (pos + 4 > endPos) return null;
      fields.push({ fieldNo, wire, dataStart: pos, dataEnd: pos + 4 });
      pos += 4;
    } else if (wire === 2) {
      const len = readProtobufVarint53(buf, pos, endPos);
      if (!len || len.value < 0 || len.nextPos + len.value > endPos) return null;
      const dataStart = len.nextPos;
      const dataEnd = dataStart + len.value;
      fields.push({ fieldNo, wire, dataStart, dataEnd });
      pos = dataEnd;
    } else {
      return null;
    }
  }
  return pos === endPos ? fields : null;
}

function isCompatibleMediaFieldWire(fieldNo: number, wire: number): boolean {
  switch (fieldNo) {
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
    case 8:
    case 9:
    case 10:
    case 18:
    case 21:
      return wire === 2;
    case 7:
      return wire === 5;
    case 11:
    case 12:
    case 13:
    case 14:
    case 16:
    case 20:
      return wire === 0;
    case 15:
      return wire === 1;
    case 17:
    case 19:
    case 22:
      return wire === 0 || wire === 2;
    default:
      return wire === 0 || wire === 1 || wire === 2 || wire === 5;
  }
}

export function sanitizeCorruptedMediaStepPayload(payload: Uint8Array): {
  updatedPayload: Buffer | null;
  repairedMedia: { mediaIndex: number; ext: string; replacement: Buffer }[];
} {
  let buf: Buffer | null = null;
  const source = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  const repairedMedia: { mediaIndex: number; ext: string; replacement: Buffer }[] = [];
  let currentMediaIndex = 0;

  const inspectMediaMessage = (startPos: number, endPos: number): void => {
    const fields = parseProtobufFieldsStrict(source, startPos, endPos);
    if (!fields || fields.length === 0) return;

    let mimeSpan: { start: number; end: number } | null = null;
    let activeOneofPayload: { fieldNo: 2 | 3 | 18; start: number; end: number } | null = null;

    for (const f of fields) {
      if (!isCompatibleMediaFieldWire(f.fieldNo, f.wire)) {
        return;
      }
      if (f.fieldNo === 1) {
        mimeSpan = { start: f.dataStart, end: f.dataEnd };
      } else if (f.fieldNo === 2 || f.fieldNo === 3 || f.fieldNo === 18) {
        activeOneofPayload = { fieldNo: f.fieldNo, start: f.dataStart, end: f.dataEnd };
      }
    }

    if (!mimeSpan) return;
    let mimeText: string;
    try {
      mimeText = UTF8_FATAL_DECODER.decode(source.subarray(mimeSpan.start, mimeSpan.end));
    } catch {
      return;
    }

    const mediaIndex = currentMediaIndex++;
    const spec = SUPPORTED_MIMES_BY_NAME.get(mimeText);
    if (!spec || !activeOneofPayload || activeOneofPayload.fieldNo !== 2) {
      return;
    }

    const dataStart = activeOneofPayload.start;
    const dataEnd = activeOneofPayload.end;
    const dataLen = dataEnd - dataStart;
    if (dataLen <= 0) return;

    const slice = source.subarray(dataStart, dataEnd);
    if (spec.inspect(slice) === 'corrupt') {
      const replacement = spec.buildReplacement(dataLen);
      if (replacement && replacement.length === dataLen) {
        if (!buf) buf = Buffer.from(source);
        replacement.copy(buf, dataStart);
        repairedMedia.push({ mediaIndex, ext: spec.ext, replacement });
      }
    }
  };

  const traverseStepMessage = (
    msgType: string,
    startPos: number,
    endPos: number,
    depth: number,
  ): void => {
    if (depth > MAX_STEP_SCHEMA_DEPTH) return;
    const edges = STEP_MEDIA_SCHEMA_FSM[msgType];
    if (!edges) return;
    const fields = parseProtobufFieldsStrict(source, startPos, endPos);
    if (!fields) return;
    for (const f of fields) {
      if (f.wire !== 2) continue;
      const next = edges[f.fieldNo];
      if (!next) continue;
      if (next === 'MEDIA') {
        inspectMediaMessage(f.dataStart, f.dataEnd);
      } else {
        traverseStepMessage(next, f.dataStart, f.dataEnd, depth + 1);
      }
    }
  };

  if (source.length > 0) {
    traverseStepMessage('.gemini_coder.Step', 0, source.length, 0);
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
  /** Test hook invoked after backup verification and before opening the write transaction. */
  afterBackupVerifiedBeforeWrite?: () => void;
}

export function resolveDefaultAgyHomeDir(homeDir: string = os.homedir()): string {
  const override = process.env.AGY_HOME?.trim();
  if (override) return override;
  return join(homeDir, '.gemini', 'antigravity-cli');
}

function hashSqliteValueInto(hash: ReturnType<typeof createHash>, val: unknown): void {
  if (val === null || val === undefined) {
    hash.update('N;');
    return;
  }
  if (typeof val === 'bigint') {
    hash.update(`I:${val.toString()};`);
    return;
  }
  if (typeof val === 'number') {
    const fBuf = Buffer.allocUnsafe(8);
    fBuf.writeDoubleBE(val, 0);
    hash.update('R:');
    hash.update(fBuf);
    hash.update(';');
    return;
  }
  if (typeof val === 'string') {
    const sBuf = Buffer.from(val, 'utf8');
    hash.update(`T:${sBuf.byteLength}:`);
    hash.update(sBuf);
    hash.update(';');
    return;
  }
  if (val instanceof Uint8Array) {
    hash.update(`B:${val.byteLength}:`);
    hash.update(val);
    hash.update(';');
    return;
  }
  const other = Buffer.from(`${typeof val}:${String(val)}`, 'utf8');
  hash.update(`O:${other.byteLength}:`);
  hash.update(other);
  hash.update(';');
}

function computeSqliteDatabaseDigest(db: any): string {
  const rootHash = createHash('sha256');
  const schemaStmt = db.prepare(
    "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql_text FROM sqlite_master WHERE type IN ('table', 'index', 'trigger', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type ASC, name ASC",
  );
  schemaStmt.setReadBigInts?.(true);
  const schemaObjects = schemaStmt.all() as Array<{
    type: string;
    name: string;
    tbl_name: string;
    sql_text: string;
  }>;

  rootHash.update(`SCHEMA_COUNT:${schemaObjects.length}\n`);
  const tableNames: string[] = [];
  for (const obj of schemaObjects) {
    rootHash.update(`OBJ:${obj.type}:${obj.name}:${obj.tbl_name}:${obj.sql_text.length}:${obj.sql_text}\n`);
    if (obj.type === 'table') {
      tableNames.push(obj.name);
    }
  }

  for (const tbl of tableNames) {
    const escapedIdent = tbl.replace(/"/g, '""');
    const colInfoStmt = db.prepare(`PRAGMA table_info("${escapedIdent}")`);
    colInfoStmt.setReadBigInts?.(true);
    const cols = (colInfoStmt.all() as Array<{ name: string }>).map((c) => c.name);
    rootHash.update(`TABLE:${tbl}:COLS:${cols.length}:${cols.join(',')}\n`);

    const rowStmt = db.prepare(`SELECT * FROM "${escapedIdent}"`);
    rowStmt.setReadBigInts?.(true);
    const rows = rowStmt.all() as Array<Record<string, unknown>>;
    const rowDigests: string[] = [];
    for (const r of rows) {
      const rh = createHash('sha256');
      for (const col of cols) {
        const colNameBytes = Buffer.from(col, 'utf8');
        rh.update(`C:${colNameBytes.byteLength}:`);
        rh.update(colNameBytes);
        rh.update('=');
        hashSqliteValueInto(rh, r[col]);
      }
      rowDigests.push(rh.digest('hex'));
    }
    rowDigests.sort();
    rootHash.update(`ROWS:${rowDigests.length}\n`);
    for (const d of rowDigests) {
      rootHash.update(d);
      rootHash.update('\n');
    }
  }

  return rootHash.digest('hex');
}

function verifyTargetedOriginalPayloads(
  db: any,
  expectedOriginals: readonly { idx: number; originalPayload: Buffer }[],
  contextLabel: string,
): void {
  const payloadStmt = db.prepare('SELECT step_payload FROM steps WHERE idx = ?');
  for (const item of expectedOriginals) {
    const row = payloadStmt.get(item.idx) as { step_payload?: unknown } | undefined;
    if (!(row?.step_payload instanceof Uint8Array)) {
      throw new Error(`${contextLabel}: step ${item.idx} missing or non-blob step_payload`);
    }
    const actual = Buffer.from(
      row.step_payload.buffer,
      row.step_payload.byteOffset,
      row.step_payload.byteLength,
    );
    if (Buffer.compare(actual, item.originalPayload) !== 0) {
      throw new Error(`${contextLabel}: step ${item.idx} payload changed concurrently`);
    }
  }
}

function createVerifiedSqliteSnapshotBackup(
  DatabaseSyncCtor: any,
  dbPath: string,
  backupPath: string,
  expectedDbDigest: string,
  expectedOriginals: readonly { idx: number; originalPayload: Buffer }[],
): void {
  const escapedBackupPath = backupPath.replace(/'/g, "''");
  const snapDb = new DatabaseSyncCtor(dbPath, { readOnly: true });
  try {
    snapDb.exec(`VACUUM INTO '${escapedBackupPath}'`);
  } finally {
    snapDb.close();
  }

  const verifyDb = new DatabaseSyncCtor(backupPath, { readOnly: true });
  try {
    const backupDigest = computeSqliteDatabaseDigest(verifyDb);
    if (backupDigest !== expectedDbDigest) {
      throw new Error('SQLite backup digest mismatch: database changed between inspection and backup');
    }
    verifyTargetedOriginalPayloads(verifyDb, expectedOriginals, 'SQLite backup verification failed');
  } finally {
    verifyDb.close();
  }
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

  let inspectedDbDigest = '';
  const pendingUpdates: {
    idx: number;
    originalPayload: Buffer;
    updatedPayload: Buffer;
    repairedMedia: { mediaIndex: number; ext: string; replacement: Buffer }[];
  }[] = [];

  try {
    const roDb = new DatabaseSyncCtor(dbPath, { readOnly: true });
    try {
      inspectedDbDigest = computeSqliteDatabaseDigest(roDb);
      const rows = roDb
        .prepare('SELECT idx, step_payload FROM steps WHERE step_payload IS NOT NULL ORDER BY idx ASC')
        .all() as { idx: number; step_payload: Uint8Array }[];
      for (const row of rows) {
        if (!(row.step_payload instanceof Uint8Array) || row.step_payload.byteLength < 16) continue;
        const originalPayload = Buffer.from(
          row.step_payload.buffer,
          row.step_payload.byteOffset,
          row.step_payload.byteLength,
        );
        const { updatedPayload, repairedMedia } = sanitizeCorruptedMediaStepPayload(originalPayload);
        if (updatedPayload && repairedMedia.length > 0) {
          pendingUpdates.push({
            idx: row.idx,
            originalPayload,
            updatedPayload,
            repairedMedia,
          });
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
  let committed = false;
  try {
    const backupDir = join(agyHomeDir, 'cache', 'media-repair-backups');
    mkdirSync(backupDir, { recursive: true });
    const nonce = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    backupPath = join(backupDir, `${conversationId}.${nonce}.db.bak`);
    createVerifiedSqliteSnapshotBackup(
      DatabaseSyncCtor,
      dbPath,
      backupPath,
      inspectedDbDigest,
      pendingUpdates,
    );

    opts.afterBackupVerifiedBeforeWrite?.();

    const rwDb = new DatabaseSyncCtor(dbPath);
    try {
      rwDb.exec('PRAGMA busy_timeout = 5000');
      rwDb.exec('BEGIN IMMEDIATE');
      const liveDbDigest = computeSqliteDatabaseDigest(rwDb);
      if (liveDbDigest !== inspectedDbDigest) {
        throw new Error('Conversation DB changed concurrently before repair write transaction; aborting repair');
      }
      verifyTargetedOriginalPayloads(
        rwDb,
        pendingUpdates,
        'Concurrent step_payload modification detected inside write transaction',
      );
      const updateStmt = rwDb.prepare(
        'UPDATE steps SET step_payload = ? WHERE idx = ? AND step_payload = ?',
      );
      for (const item of pendingUpdates) {
        const res = updateStmt.run(item.updatedPayload, item.idx, item.originalPayload) as {
          changes?: number | bigint;
        };
        if (Number(res?.changes ?? 0) !== 1) {
          throw new Error(`Compare-and-swap failed for step ${item.idx}; aborting repair`);
        }
      }
      rwDb.exec('COMMIT');
      committed = true;
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
    if (!committed && backupPath && existsSync(backupPath)) {
      try { unlinkSync(backupPath); } catch {}
    }
    opts.log?.(`Failed to repair corrupted media in Antigravity conversation DB: ${err instanceof Error ? err.message : String(err)}`);
    return { repairedCount: 0, repairedSteps: [] };
  }
}
