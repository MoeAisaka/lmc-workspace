import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'lmc-inbox-home-'));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));
vi.mock('@/configuration', () => ({ configuration: { lmcHomeDir: home } }));
const { saveAttachmentsToInbox, formatInboxNote, safeAttachmentName, looksLikeImage } = await import('./attachmentInbox');

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const project = async () => { const dir = await mkdtemp(join(tmpdir(), 'lmc-inbox-project-')); dirs.push(dir); return dir; };
const now = () => new Date(2026, 8, 8, 13, 5, 9);

describe('attachment inbox', () => {
    it('saves files under the project .lmc-inbox with a gitignore and a readable name', async () => {
        const dir = await project();
        const saved = await saveAttachmentsToInbox([{ data: new TextEncoder().encode('hello'), mimeType: 'text/plain', name: 'notes.txt' }], { projectPath: dir, sessionId: 's1', now });
        expect(saved).toHaveLength(1);
        expect(saved[0].path).toBe(join(dir, '.lmc-inbox', '20260908-130509-notes.txt'));
        expect(saved[0].isImage).toBe(false);
        expect(await readFile(saved[0].path, 'utf8')).toBe('hello');
        expect(await readFile(join(dir, '.lmc-inbox', '.gitignore'), 'utf8')).toBe('*\n');
    });

    it('falls back to the agent home when the project directory is unusable', async () => {
        const saved = await saveAttachmentsToInbox([{ data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]), mimeType: 'image/png', name: '../../evil/pic.png' }], { projectPath: '/nonexistent/dir', sessionId: 'abc/def', now });
        expect(saved[0].path).toBe(join(home, 'inbox', 'def', '20260908-130509-pic.png'));
        expect(saved[0].isImage).toBe(true);
    });

    it('numbers several files from one message and formats the note', async () => {
        const dir = await project();
        const saved = await saveAttachmentsToInbox([
            { data: new Uint8Array(2048), mimeType: 'application/pdf', name: 'a.pdf' },
            { data: new Uint8Array(10), mimeType: 'text/csv', name: 'b.csv' },
        ], { projectPath: dir, sessionId: 's', now });
        expect((await readdir(join(dir, '.lmc-inbox'))).sort()).toEqual(['.gitignore', '20260908-130509-1-a.pdf', '20260908-130509-2-b.csv']);
        expect(formatInboxNote(saved)).toBe(`\n\n[用户随消息发来的文件已保存到本机，可直接读取]\n- ${saved[0].path} (2.0 KB)\n- ${saved[1].path} (10 B)`);
        expect(formatInboxNote([])).toBe('');
    });

    it('sanitises names and detects images by magic bytes', () => {
        expect(safeAttachmentName('..\\..\\x y.txt')).toBe('x y.txt');
        expect(safeAttachmentName('   ')).toBe('attachment');
        expect(looksLikeImage(new Uint8Array([0xff, 0xd8, 0xff, 0]))).toBe(true);
        expect(looksLikeImage(new TextEncoder().encode('%PDF'))).toBe(false);
    });
});
