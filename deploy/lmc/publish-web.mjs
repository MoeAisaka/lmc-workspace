import { access, copyFile, cp, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const source = resolve(process.argv[2] || 'deploy/lmc/web-build');
const target = resolve(process.argv[3] || 'deploy/lmc/web');
if (source === target) throw new Error('Build and served directories must differ');
await access(join(source, '_expo'));
let html = await readFile(join(source, 'index.html'), 'utf8');
// SPA exports can omit +html.tsx; retain explicit browser/home-screen icons.
if (!html.includes('rel="icon"')) html = html.replace('</head>', '<link rel="icon" href="/favicon.ico?v=musubi1" /></head>');
if (!html.includes('rel="apple-touch-icon"')) html = html.replace('</head>', '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=musubi1" /></head>');
if (!html.toString().includes('<html')) throw new Error('Missing Web build HTML');
await mkdir(target, { recursive: true });
// Publish assets before HTML. Retain old hashes for tabs opened before this release.
for (const entry of await readdir(source)) {
    if (entry === 'index.html') continue;
    await cp(join(source, entry), join(target, entry), { recursive: true, force: ['favicon.ico', 'favicon-active.ico', 'apple-touch-icon.png', 'lmc-icon-192.png', 'lmc-icon-512.png'].includes(entry), errorOnExist: false });
}
try { await copyFile(join(target, 'index.html'), join(target, `index.previous-${Date.now()}.html`)); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const pending = join(target, `.index-${randomUUID()}.tmp`);
await writeFile(pending, html);
await rename(pending, join(target, 'index.html'));
console.log('Published Web assets and atomically switched HTML; older assets retained');
