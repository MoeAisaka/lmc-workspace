import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeAttachmentParts } from './attachmentParts';
import { formatInboxNote, reserveInboxPath, saveAttachmentsToInbox } from './attachmentInbox';
import { isLargeFileEvent, receiveLargeFileEvent } from './largeFileEvent';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'lmc-parts-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const exists = (path: string) => stat(path).then(() => true, () => false);
const pieces: Record<string, Uint8Array> = { a: new Uint8Array([1, 2, 3]), b: new Uint8Array([4, 5]), c: new Uint8Array([6]) };

describe('files sent in pieces', () => {
    it('writes pieces in order and retries a piece that fails once', async () => {
        const path = join(dir, 'whole.bin');
        const fetchPiece = vi.fn(async (ref: string) => pieces[ref]);
        fetchPiece.mockRejectedValueOnce(new Error('network'));
        await expect(writeAttachmentParts(['a', 'b', 'c'], path, 6, fetchPiece, 0)).resolves.toBe(6);
        expect([...await readFile(path)]).toEqual([1, 2, 3, 4, 5, 6]);
        expect(fetchPiece).toHaveBeenCalledTimes(4);
    });

    it.each([
        ['a missing piece', ['a', 'b'], 6, async (ref: string) => pieces[ref]],
        ['more than announced', ['a', 'b', 'c'], 4, async (ref: string) => pieces[ref]],
        ['a piece that does not decrypt', ['a', 'b'], 5, async (ref: string) => ref === 'b' ? null : pieces[ref]],
        ['a piece that never arrives', ['a', 'b'], 5, async (ref: string) => { if (ref === 'b') throw new Error('gone'); return pieces[ref]; }],
    ])('leaves no partial file after %s', async (_name, parts, size, fetchPiece) => {
        const path = join(dir, 'partial.bin');
        await expect(writeAttachmentParts(parts, path, size, fetchPiece, 0)).rejects.toThrow();
        expect(await exists(path)).toBe(false);
    });

    const event = (parts?: string[]) => ({ content: { data: { ev: { t: 'file', ref: 'a', name: '../录屏 1.mp4', size: 6, ...(parts ? { parts } : {}) } } } }) as any;

    it('lands a large file in the session inbox and hands the path on without loading it', async () => {
        const session = { sessionId: 's', sendSessionEvent: vi.fn(),
            downloadAttachmentPartsToFile: (parts: string[], path: string, size: number) => writeAttachmentParts(parts, path, size, async ref => pieces[ref], 0) };
        expect(isLargeFileEvent(event())).toBe(false);
        expect(isLargeFileEvent(event(['a', 'b', 'c']))).toBe(true);
        const received = await receiveLargeFileEvent(session, event(['a', 'b', 'c']), dir);
        expect(received).toMatchObject({ name: '../录屏 1.mp4', file: { size: 6 } });
        expect(received!.data.length).toBe(0);
        expect(received!.file!.path.startsWith(join(dir, '.lmc-inbox'))).toBe(true);
        expect(received!.file!.path.endsWith('-录屏 1.mp4')).toBe(true);
        const saved = await saveAttachmentsToInbox([received!], { projectPath: dir, sessionId: 's' });
        expect(saved).toEqual([{ name: '录屏 1.mp4', path: received!.file!.path, size: 6, isImage: false }]);
        expect(formatInboxNote(saved)).toContain(received!.file!.path);
        expect(session.sendSessionEvent).not.toHaveBeenCalled();
    });

    it('says so in the session when a large file does not arrive whole', async () => {
        const session = { sessionId: 's', sendSessionEvent: vi.fn(), downloadAttachmentPartsToFile: vi.fn(async () => { throw new Error('incomplete'); }) };
        await expect(receiveLargeFileEvent(session, event(['a']), dir)).resolves.toBeNull();
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: expect.stringContaining('没有完整收到') });
    });

    it('does not reuse the path of a file already in the inbox', async () => {
        const now = () => new Date(2026, 9, 1, 22, 33, 0);
        const first = await reserveInboxPath('a.mp4', { projectPath: dir, sessionId: 's', now });
        await writeAttachmentParts(['a'], first, 3, async ref => pieces[ref], 0);
        const second = await reserveInboxPath('a.mp4', { projectPath: dir, sessionId: 's', now });
        expect(second).not.toBe(first);
        expect(second.endsWith('-a-2.mp4')).toBe(true);
    });
});
