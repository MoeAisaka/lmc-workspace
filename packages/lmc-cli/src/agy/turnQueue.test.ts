import { describe, expect, it, vi } from 'vitest';
import { createAgyTurnQueue, resolveAgyTurnMode, type AgyTurnMode } from './turnQueue';
import { parseAgyModels } from './modelDiscovery';
import { attachQueuePublisher, registerQueueControlHandlers } from '@/utils/sessionQueueControl';
import { buildAgyArgs } from './cliArgs';

const catalog = { source: 'native' as const, runtimeVersion: '1.4.7', capturedAt: 1, models: parseAgyModels(
    'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)') };
const initial: AgyTurnMode = { model: 'claude-opus-5-5-medium', effort: 'medium', permissionMode: 'yolo' };
function setup() {
    let state: any = {};
    const handlers: Record<string, (r: any) => Promise<any>> = {};
    const session: any = { updateAgentState: (fn: any) => { state = fn(state); }, updateMetadata: vi.fn(), sendSessionEvent: vi.fn(),
        rpcHandlerManager: { registerHandler: (name: string, fn: any) => { handlers[name] = fn; } } };
    const queue = createAgyTurnQueue(), interrupt = vi.fn(async () => {});
    attachQueuePublisher(queue, session, 'batch');
    registerQueueControlHandlers(session, queue, { isBusy: () => true, interrupt });
    return { queue, session, handlers, interrupt, state: () => state };
}
describe('Antigravity queue', () => {
    it('uses each prompt’s captured native model and permission rather than the latest pick', async () => {
        const f = setup();
        const first = resolveAgyTurnMode(undefined, initial, catalog);
        f.queue.push('first', first, undefined, { key: 'a' });
        const later = resolveAgyTurnMode({ effort: 'high', permissionMode: 'plan' }, first, catalog);
        f.queue.push('second', later, undefined, { key: 'b' });
        for (const expected of [{ message: 'first', mode: initial }, { message: 'second', mode: later }]) {
            const turn = (await f.queue.waitForMessagesAndGetAsString())!;
            expect(turn).toMatchObject(expected);
            const argv = buildAgyArgs({ prompt: turn.message, ...turn.mode });
            expect(argv[argv.indexOf('--model') + 1]).toBe(expected.mode.model);
            expect(argv.includes('--dangerously-skip-permissions')).toBe(expected.mode.permissionMode === 'yolo');
        }
        expect(f.state().queue).toBeUndefined();
        expect(f.session.sendSessionEvent).toHaveBeenCalledWith({ type: 'queue-released', keys: ['b'] });
    });
    it('withdraws one prompt and promotes another without duplicating or discarding the rest', async () => {
        const f = setup();
        f.queue.setQueueMode('sequential');
        for (const key of ['a','b','c']) f.queue.push(key, initial, undefined, { key });
        expect(await f.handlers.dequeue({ key: 'b' })).toEqual({ removed: true });
        expect(await f.handlers.promote({ key: 'c' })).toEqual({ promoted: true, interrupted: true });
        expect(f.interrupt).toHaveBeenCalledOnce();
        expect((await f.queue.waitForMessagesAndGetAsString())?.message).toBe('c');
        expect((await f.queue.waitForMessagesAndGetAsString())?.message).toBe('a');
        expect(f.queue.size()).toBe(0);
    });
    it('keeps unsupported steering queued and joins same-mode prompts only in batch mode', async () => {
        const f = setup();
        for (const key of ['a','b']) f.queue.push(key, initial, undefined, { key });
        expect(await f.handlers.steer({ key: 'a' })).toEqual({ steered: false, reason: 'unsupported' });
        expect(f.queue.size()).toBe(2);
        expect((await f.queue.waitForMessagesAndGetAsString())?.message).toBe('a\nb');
        expect(f.session.sendSessionEvent).toHaveBeenCalledWith({ type: 'queue-released', keys: ['a','b'] });
    });
});
