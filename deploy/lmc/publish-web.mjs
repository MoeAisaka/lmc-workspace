import { access, copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

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
// Publish every exported resource before HTML; retain old content hashes.
const files = [];
async function collect(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) throw new Error('Build must not contain symlinks');
        if (entry.isDirectory()) await collect(join(directory, entry.name), relative);
        else if (entry.isFile() && relative !== 'index.html') files.push(relative);
    }
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
await collect(source);
const manifest = [];
for (const relative of files) {
    const bytes = await readFile(join(source, relative));
    let previous;
    try { previous = await readFile(join(target, relative)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous && digest(previous) !== digest(bytes) && /^(assets|_expo)\//.test(relative)) {
        throw new Error(`Hashed asset content conflict: ${relative}`);
    }
    manifest.push({ relative, bytes, previous });
}
for (const { relative, bytes, previous } of manifest) {
    if (previous && digest(previous) === digest(bytes)) continue;
    const destination = join(target, relative);
    await mkdir(resolve(destination, '..'), { recursive: true });
    if (previous) await copyFile(destination, `${destination}.previous-${randomUUID()}`);
    const pendingAsset = `${destination}.${randomUUID()}.tmp`;
    await writeFile(pendingAsset, bytes);
    await rename(pendingAsset, destination);
}
for (const { relative, bytes } of manifest) {
    if (digest(await readFile(join(target, relative))) !== digest(bytes)) throw new Error(`Published asset mismatch: ${relative}`);
}
try { await copyFile(join(target, 'index.html'), join(target, `index.previous-${Date.now()}.html`)); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const pending = join(target, `.index-${randomUUID()}.tmp`);
await writeFile(pending, html);
await rename(pending, join(target, 'index.html'));
console.log('Published Web assets and atomically switched HTML; older assets retained');
