import { describe, it, expect, vi } from 'vitest';
import { MessageQueue2 } from './MessageQueue2';
import { applyQueueModeRequest, attachQueuePublisher, registerQueueControlHandlers, type QueueSessionClient } from './sessionQueueControl';

function fakeClient() {
    let state: any = { queue: [{ key: 'ghost', preview: 'from a dead process', createdAt: 1 }] };
    let metadata: any = {};
    const handlers = new Map<string, (data: unknown) => Promise<any> | any>();
    const client: QueueSessionClient = {
        updateAgentState: (h) => { state = h(state); },
        updateMetadata: (h) => { metadata = h(metadata); },
        sendSessionEvent: vi.fn(),
        rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler as (data: unknown) => any); } },
    };
    return { client, handlers, state: () => state, metadata: () => metadata };
}

describe('attachQueuePublisher', () => {
    it('clears a stale queue, adopts the persisted mode, and mirrors every change', async () => {
        const queue = new MessageQueue2<string>(m => m);
        const f = fakeClient();
        attachQueuePublisher(queue, f.client, 'sequential');
        expect(f.state().queue).toBeUndefined();
        expect(queue.getQueueMode()).toBe('sequential');
        queue.push('hello', 'm', undefined, { key: 'k1' });
        expect(f.state().queue).toEqual([expect.objectContaining({ key: 'k1', preview: 'hello' })]);
        await queue.waitForMessagesAndGetAsString();
        expect(f.state().queue).toBeUndefined();
    });

    it('ignores an unknown persisted mode', () => {
        const queue = new MessageQueue2<string>(m => m);
        attachQueuePublisher(queue, fakeClient().client, 'whatever');
        expect(queue.getQueueMode()).toBe('batch');
    });
});

describe('applyQueueModeRequest', () => {
    it('handles only the queueMode shape and persists it', () => {
        const queue = new MessageQueue2<string>(m => m);
        const f = fakeClient();
        expect(applyQueueModeRequest({ refreshCli: true }, queue, f.client)).toBe(false);
        expect(applyQueueModeRequest({ queueMode: 'sequential' }, queue, f.client)).toBe(true);
        expect(queue.getQueueMode()).toBe('sequential');
        expect(f.metadata().queueMode).toBe('sequential');
    });
});

describe('registerQueueControlHandlers', () => {
    it('dequeue reports whether anything was withdrawn', async () => {
        const queue = new MessageQueue2<string>(m => m);
        const f = fakeClient();
        registerQueueControlHandlers(f.client, queue, { isBusy: () => false, interrupt: async () => {} });
        queue.push('a', 'm', undefined, { key: 'ka' });
        expect(await f.handlers.get('dequeue')!({ key: 'ka' })).toEqual({ removed: true });
        expect(await f.handlers.get('dequeue')!({ key: 'ka' })).toEqual({ removed: false });
        expect(f.client.sendSessionEvent).toHaveBeenCalledExactlyOnceWith({ type: 'queue-withdrawn', key: 'ka' });
        await expect(f.handlers.get('dequeue')!({})).rejects.toThrow();
    });

    it('keeps the queued prompt if the withdrawal receipt cannot be enqueued', async () => {
        const queue = new MessageQueue2<string>(m => m);
        const f = fakeClient();
        vi.mocked(f.client.sendSessionEvent).mockImplementation(() => { throw new Error('receipt failed'); });
        registerQueueControlHandlers(f.client, queue, { isBusy: () => true, interrupt: async () => {} });
        queue.push('a', 'm', undefined, { key: 'ka' });
        await expect(f.handlers.get('dequeue')!({ key: 'ka' })).rejects.toThrow('receipt failed');
        expect(queue.snapshot().map(item => item.key)).toEqual(['ka']);
    });

    it('promote interrupts only when the engine is busy', async () => {
        const queue = new MessageQueue2<string>(m => m);
        const f = fakeClient();
        const interrupt = vi.fn(async () => {});
        let busy = false;
        registerQueueControlHandlers(f.client, queue, { isBusy: () => busy, interrupt });
        queue.push('a', 'm', undefined, { key: 'ka' });
        queue.push('b', 'm', undefined, { key: 'kb' });
        expect(await f.handlers.get('promote')!({ key: 'kb' })).toEqual({ promoted: true, interrupted: false });
        expect(queue.snapshot()[0].key).toBe('kb');
        expect(interrupt).not.toHaveBeenCalled();
        busy = true;
        expect(await f.handlers.get('promote')!({ key: 'ka' })).toEqual({ promoted: true, interrupted: true });
        expect(interrupt).toHaveBeenCalledTimes(1);
        expect(await f.handlers.get('promote')!({ key: 'gone' })).toEqual({ promoted: false, interrupted: false });
        expect(interrupt).toHaveBeenCalledTimes(1);
    });
});

describe('steer handler', () => {
    const busy = { isBusy: () => true, interrupt: async () => {} };

    it('says unsupported when the engine has no steer, without touching the queue', async () => {
        const queue = new MessageQueue2<string>(m => m);
        const f = fakeClient();
        registerQueueControlHandlers(f.client, queue, busy);
        queue.push('a', 'm', undefined, { key: 'ka' });
        expect(await f.handlers.get('steer')!({ key: 'ka' })).toEqual({ steered: false, reason: 'unsupported' });
        expect(queue.size()).toBe(1);
    });

    it('says idle when no turn is running', async () => {
        const queue = new MessageQueue2<string>(m => m);
        const f = fakeClient();
        registerQueueControlHandlers(f.client, queue, { isBusy: () => false, interrupt: async () => {}, steer: async () => ({ steered: true }) });
        queue.push('a', 'm', undefined, { key: 'ka' });
        expect(await f.handlers.get('steer')!({ key: 'ka' })).toEqual({ steered: false, reason: 'idle' });
        expect(queue.size()).toBe(1);
    });

    it('hands the item over and leaves it out of the queue on success', async () => {
        const queue = new MessageQueue2<string>(m => m);
        const f = fakeClient();
        const seen: string[] = [];
        registerQueueControlHandlers(f.client, queue, { ...busy, steer: async (item) => { seen.push(item.message); return { steered: true }; } });
        queue.push('a', 'm', undefined, { key: 'ka' });
        queue.push('b', 'm', undefined, { key: 'kb' });
        expect(await f.handlers.get('steer')!({ key: 'ka' })).toEqual({ steered: true });
        expect(seen).toEqual(['a']);
        expect(queue.snapshot().map(s => s.key)).toEqual(['kb']);
    });

    it('puts a refused item back in its place, and keeps an unconfirmed one out', async () => {
        const queue = new MessageQueue2<string>(m => m);
        const f = fakeClient();
        let outcome: any = { steered: false, reason: 'settings' };
        registerQueueControlHandlers(f.client, queue, { ...busy, steer: async () => outcome });
        queue.push('a', 'm', undefined, { key: 'ka' });
        queue.push('b', 'm', undefined, { key: 'kb' });
        expect(await f.handlers.get('steer')!({ key: 'ka' })).toEqual({ steered: false, reason: 'settings' });
        expect(queue.snapshot().map(s => s.key)).toEqual(['ka', 'kb']);
        outcome = { steered: false, reason: 'unconfirmed', restore: false };
        expect(await f.handlers.get('steer')!({ key: 'ka' })).toEqual({ steered: false, reason: 'unconfirmed' });
        expect(queue.snapshot().map(s => s.key)).toEqual(['kb']);
    });

    it('restores the item when the engine callback throws', async () => {
        const queue = new MessageQueue2<string>(m => m);
        const f = fakeClient();
        registerQueueControlHandlers(f.client, queue, { ...busy, steer: async () => { throw new Error('boom'); } });
        queue.push('a', 'm', undefined, { key: 'ka' });
        expect(await f.handlers.get('steer')!({ key: 'ka' })).toEqual({ steered: false, reason: 'refused' });
        expect(queue.size()).toBe(1);
    });

    it('says gone for a key the engine already took', async () => {
        const queue = new MessageQueue2<string>(m => m);
        const f = fakeClient();
        registerQueueControlHandlers(f.client, queue, { ...busy, steer: async () => ({ steered: true }) });
        expect(await f.handlers.get('steer')!({ key: 'ka' })).toEqual({ steered: false, reason: 'gone' });
        await expect(f.handlers.get('steer')!({})).rejects.toThrow();
    });
});
