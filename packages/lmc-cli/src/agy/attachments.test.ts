import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAgyAttachmentPrompt, registerAgyAttachments } from './attachments';
import type { ApiSessionClient } from '@/api/apiSession';
import type { FileEventMessage } from '@/api/types';
import type { PendingAttachment } from '@/utils/MessageQueue2';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

it('downloads files, binds them to one message and gives the native CLI readable paths, including file-only messages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agy-attachments-')); dirs.push(dir);
    let listener!: (event: FileEventMessage) => void;
    let pending: Promise<PendingAttachment | null>[] = [];
    const session = {
        sessionId: 'test-session', sendSessionEvent: vi.fn(),
        onFileEvent: (callback: typeof listener) => { listener = callback; },
        downloadAndDecryptAttachment: vi.fn(async () => Buffer.from('user document')),
        trackAttachmentDownload: (promise: Promise<PendingAttachment | null>) => { pending.push(promise); },
        drainAttachmentsForUserMessage: async () => { const owned = pending; pending = []; return (await Promise.all(owned)).filter(Boolean) as PendingAttachment[]; },
    } as unknown as ApiSessionClient;
    registerAgyAttachments(session, dir);
    listener({ content: { data: { ev: { name: '../notes.txt', ref: 'encrypted-ref', mimeType: 'text/plain', size: 13 } } } } as FileEventMessage);
    const prompt = await prepareAgyAttachmentPrompt(session, '', dir);
    const file = prompt.split('\n').find(line => line.startsWith('- '))!.slice(2).replace(/ \([^)]*\)$/, '');
    expect(file.startsWith(join(dir, '.lmc-inbox'))).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('user document');
    expect(await prepareAgyAttachmentPrompt(session, 'next message', dir)).toBe('next message');
});

it('reports a failed download instead of silently pretending the file arrived', async () => {
    let listener!: (event: FileEventMessage) => void;
    let task!: Promise<PendingAttachment | null>;
    const sendSessionEvent = vi.fn();
    const session = { onFileEvent: (cb: typeof listener) => { listener = cb; },
        downloadAndDecryptAttachment: vi.fn(async () => null), sendSessionEvent,
        trackAttachmentDownload: (p: typeof task) => { task = p; } } as unknown as ApiSessionClient;
    registerAgyAttachments(session, '/unused');
    listener({ content: { data: { ev: { name: 'missing.png', ref: 'bad' } } } } as FileEventMessage);
    expect(await task).toBeNull();
    expect(sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('missing.png') }));
});
