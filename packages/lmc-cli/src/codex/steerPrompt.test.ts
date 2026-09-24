import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { steerCodexPrompt } from './steerPrompt';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { registerQueueControlHandlers, type QueueSessionClient } from '@/utils/sessionQueueControl';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const png = { name: 'image.png', mimeType: 'image/png', data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) };

async function setup(accept = true, claude = false) {
    const dir = await mkdtemp(join(tmpdir(), 'lmc-steer-images-'));
    dirs.push(dir);
    const queue = new MessageQueue2(() => 'same');
    const handlers = new Map<string, (data: any) => any>();
    const events: unknown[] = [];
    const session: QueueSessionClient = {
        updateAgentState: () => {}, updateMetadata: () => {},
        sendSessionEvent: event => { events.push(event); },
        rpcHandlerManager: { registerHandler: (name, handler) => { handlers.set(name, handler); } },
    };
    const client = { turnId: 'running-turn', hasPendingTurnCompletion: () => true, steerTurn: vi.fn().mockResolvedValue(accept) };
    registerQueueControlHandlers(session, queue, {
        isBusy: () => true, interrupt: async () => {},
        ...(!claude ? { steer: item => steerCodexPrompt(client, item.message, item.attachments, { sessionId: 'test', cacheRootDir: dir }) } : {}),
    });
    return { dir, queue, client, events, steer: () => handlers.get('steer')!({ key: 'photo' }) };
}

describe('image steering from the queue', () => {
    it.each(['look at this', ''])('delivers all image bytes and caption %j to the original turn', async text => {
        const f = await setup();
        f.queue.push(text, {}, [png, png], { key: 'photo' });
        expect(await f.steer()).toEqual({ steered: true });
        const [caption, opts] = f.client.steerTurn.mock.calls[0];
        expect(caption).toBe(text);
        expect(opts.expectedTurnId).toBe('running-turn');
        expect(opts.extraInputItems).toHaveLength(2);
        for (const item of opts.extraInputItems) {
            expect(item.type).toBe('localImage');
            expect(new Uint8Array(await readFile(item.path))).toEqual(png.data);
        }
        expect(f.queue.size()).toBe(0);
        expect(f.events).toEqual([{ type: 'queue-released', keys: ['photo'] }]);
    });

    it('restores the entire reply on definite rejection, with its original identity and attachments', async () => {
        const f = await setup(false);
        f.queue.push('caption', {}, [png], { key: 'photo' });
        const original = f.queue.queue[0];
        expect(await f.steer()).toEqual({ steered: false, reason: 'refused' });
        expect(f.queue.queue[0]).toMatchObject(original);
        expect(f.events).toEqual([]);
    });

    it('does not partially deliver an image mixed with an unsupported file', async () => {
        const f = await setup();
        f.queue.push('caption', {}, [png, { ...png, name: 'file.pdf', data: new TextEncoder().encode('%PDF-1.7') }], { key: 'photo' });
        expect(await f.steer()).toEqual({ steered: false, reason: 'attachments' });
        expect(f.client.steerTurn).not.toHaveBeenCalled();
        expect(f.queue.queue[0].attachments).toHaveLength(2);
    });

    it('keeps the complete reply queued if its image cache cannot be written', async () => {
        const f = await setup();
        await writeFile(join(f.dir, 'test'), 'blocks the cache directory');
        f.queue.push('caption', {}, [png], { key: 'photo' });
        expect(await f.steer()).toEqual({ steered: false, reason: 'attachments' });
        expect(f.client.steerTurn).not.toHaveBeenCalled();
        expect(f.queue.queue[0].attachments).toEqual([png]);
    });

    it('keeps Claude image replies queued and reports its unsupported capability', async () => {
        const f = await setup(true, true);
        f.queue.push('caption', {}, [png], { key: 'photo' });
        expect(await f.steer()).toEqual({ steered: false, reason: 'unsupported' });
        expect(f.queue.queue[0].attachments).toEqual([png]);
        expect(f.client.steerTurn).not.toHaveBeenCalled();
    });
});
