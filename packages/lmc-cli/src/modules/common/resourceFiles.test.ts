import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { resolveResourceFile, readResourceFile, registerResourceHandlers } from './resourceFiles';
const roots: string[] = [];
it('daemon serves bounded absolute reads and refuses relative paths and host actions', async () => {
 const dir = await setup(); const file = join(dir, 'preview.png'); await writeFile(file, 'fixture');
 let handler: any;
 registerResourceHandlers({ registerHandler: (_name: string, fn: any) => { handler = fn; } } as any, null);
 expect(await handler({ path: file, action: 'download' })).toMatchObject({ success: true, size: 7, content: 'Zml4dHVyZQ==', nextOffset: null });
 for (const data of [{ path: 'preview.png', action: 'download' }, { path: file, action: 'open-host' }, { path: dir, action: 'download' }]) {
  expect(await handler(data)).toMatchObject({ success: false });
 }
});
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup() { const dir = await mkdtemp(join(tmpdir(), 'lmc-resource-')); roots.push(dir); return dir; }
describe('scoped resource files', () => {
 it('returns binary contents without changing the file', async () => {
  const dir = await setup(); await writeFile(join(dir, 'a b.bin'), Buffer.from([0, 255, 10]));
  expect(await readResourceFile(dir, 'a b.bin')).toEqual({ name: 'a b.bin', content: 'AP8K', size: 3 });
 });
 it('reads files outside the project, directly and through a symlink', async () => {
  const dir = await setup(); const other = await setup(); await writeFile(join(other,'secret'), 'test');
  await symlink(join(other,'secret'), join(dir,'link'));
  const target = await realpath(join(other,'secret'));
  expect(await resolveResourceFile(dir, join(other,'secret'))).toBe(target);
  expect(await resolveResourceFile(dir, 'link')).toBe(target);
  expect(await resolveResourceFile(dir, join('..', basename(other), 'secret'))).toBe(target);
 });
 it('rejects directories, nonexistent files, URLs and oversized downloads', async () => {
  const dir = await setup(); await writeFile(join(dir,'large'), '12345');
  for (const path of ['.', 'missing', 'https://example.com']) await expect(resolveResourceFile(dir,path)).rejects.toThrow();
  await expect(readResourceFile(dir,'large',4)).rejects.toThrow('文件过大');
 });
});

it('reads bounded chunks and rejects a changed file between chunks', async()=>{
 const dir=await setup();await writeFile(join(dir,'file'),'abcdef');
 const {readResourceChunk}=await import('./resourceFiles');
 const first=await readResourceChunk(dir,'file',0,undefined,3);
 expect(first.content).toBe('YWJj');expect(first.nextOffset).toBe(3);
 await writeFile(join(dir,'file'),'changed length');
 await expect(readResourceChunk(dir,'file',3,first.revision,3)).rejects.toThrow('文件已变化');
});
