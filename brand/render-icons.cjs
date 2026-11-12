#!/usr/bin/env node
// Render the code-native Yulor mark. No credentials, network calls or runtime state.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const sharp = createRequire(path.join(root, 'packages/lmc-app/package.json'))('sharp');

async function main() {
  const source = await fs.readFile(path.join(__dirname, 'yulor-mark.svg'), 'utf8');
  const foreground = source.replace(/<rect\b[^>]*\/>/, '');
  const png = (size, svg = source) => sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
  const write = async (rel, bytes) => {
    const file = path.join(root, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  };
  const image = 'packages/lmc-app/sources/assets/images/';
  const pub = 'packages/lmc-app/public/';
  const desktop = 'packages/lmc-app/src-tauri/icons/yulor/';
  for (const [rel, size, svg] of [
    [image + 'yulor-logo.png', 256], [image + 'yulor-logo@2x.png', 512], [image + 'yulor-logo@3x.png', 768],
    [image + 'yulor-icon.png', 1024], [image + 'yulor-favicon.png', 48],
    [image + 'yulor-adaptive.png', 1024, foreground], [image + 'yulor-monochrome.png', 256, foreground.replace('#8df3dc', '#fff')],
    [image + 'yulor-splash.png', 512],
    [pub + 'yulor-icon-192.png', 192], [pub + 'yulor-icon-512.png', 512],
    [pub + 'yulor-apple-touch-icon.png', 180],
    [desktop + '32x32.png', 32], [desktop + '128x128.png', 128], [desktop + '128x128@2x.png', 256],
  ]) await write(rel, await png(size, svg));
  // Modern ICO entries may embed PNGs, preserving alpha at every size.
  const ico = async (svg) => {
    const sizes = [16, 32, 48, 64, 128, 256];
    const images = await Promise.all(sizes.map(size => png(size, svg)));
    const header = Buffer.alloc(6 + sizes.length * 16);
    header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
    let offset = header.length;
    images.forEach((bytes, i) => {
      const at = 6 + i * 16;
      header[at] = header[at + 1] = sizes[i] === 256 ? 0 : sizes[i];
      header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
      header.writeUInt32LE(bytes.length, at + 8); header.writeUInt32LE(offset, at + 12);
      offset += bytes.length;
    });
    return Buffer.concat([header, ...images]);
  };
  const normal = await ico(source);
  const active = source.replace('</svg>', '<circle cx="51" cy="13" r="8" fill="#fa5252" stroke="#fff" stroke-width="2"/></svg>');
  await write(pub + 'yulor-favicon.ico', normal);
  await write(pub + 'yulor-favicon-active.ico', await ico(active));
  await write(desktop + 'icon.ico', normal);
  const chunks = [];
  for (const [type, size] of [['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]]) {
    const bytes = await png(size), header = Buffer.alloc(8);
    header.write(type, 0, 'ascii'); header.writeUInt32BE(bytes.length + 8, 4);
    chunks.push(header, bytes);
  }
  const header = Buffer.alloc(8); header.write('icns', 0, 'ascii');
  header.writeUInt32BE(8 + chunks.reduce((sum, bytes) => sum + bytes.length, 0), 4);
  await write(desktop + 'icon.icns', Buffer.concat([header, ...chunks]));
  await write(pub + 'yulor-icon.svg', Buffer.from(source));
  console.log('Rendered Yulor application, browser, touch and desktop icons from brand/yulor-mark.svg');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
