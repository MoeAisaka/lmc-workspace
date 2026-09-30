import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { NativeTerminalRelay } from './terminalRelay';
import type { EnhancedMode } from '../loop';
const fixture = vi.hoisted(() => ({ options: null as any, process: null as any, scanner: null as any, activate: vi.fn() }));
vi.mock('./interactiveProcess', () => ({ startNativeInteractiveProcess: vi.fn(async (options: any) => { fixture.options = options; return fixture.process; }) }));
vi.mock('@/runtime/managedRuntime', () => ({ claudeExecutable: () => '/fixture/claude', engineCapabilities: () => ({ turnQueue: true }), runtimeVersion: async () => ({ version: 'fixture' }) }));
vi.mock('../utils/sessionScanner', () => ({ createSessionScanner: vi.fn(async (options: any) => { fixture.scanner = options; return { cleanup: async () => {}, flush: async () => {}, onNewSession: fixture.activate }; }) }));
vi.mock('../utils/permissionHandler', () => ({ PermissionHandler: class { reset() {} async handleModeChange() {} hasPendingRequests() { return false; } } }));
vi.mock('@/modules/orchestration/workerConfig', () => ({ watchSessionConfiguration: () => () => {} }));
vi.mock('./refresh', () => ({ nativeRefresh: () => ({ pending: false, drain: async () => {}, cancel: async () => {} }) }));
vi.mock('../utils/systemPrompt', () => ({ systemPrompt: 'fixture' }));
import { claudeNativeLauncher } from './launcher';
import { startNativeInteractiveProcess } from './interactiveProcess';
const mode: EnhancedMode = { model: 'sonnet', effort: 'low', permissionMode: 'default' };
let finish: (result: { exitCode: number }) => void;
let running: Promise<unknown>;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => { finish?.({ exitCode: 0 }); await running; vi.useRealTimers(); });
async function setup(fresh = false) {
    fixture.activate.mockClear();
    let composer = false;
    const write = vi.fn();
    const relay = new NativeTerminalRelay({ write, screen: () => ({ lines: ['fixture'], cursor: { x: 1, y: 0 }, composer }) });
    fixture.process = { relay, write, settled: async () => {}, exit: new Promise(resolve => { finish = resolve; }) };
    const handlers = new Map<string, (request: any) => any>();
    const client = { getMetadata: () => ({}), sessionId: 'lmc-same', updateAgentState: vi.fn(), updateMetadata: vi.fn(async () => {}), sendSessionEvent: vi.fn(), sendClaudeSessionMessageFromLocalTranscript: vi.fn(async () => {}), closeClaudeSessionTurn: vi.fn(), rpcHandlerManager: { registerHandler: (name: string, handler: any) => handlers.set(name, handler), unregisterHandler: (name: string) => handlers.delete(name) } };
    const queue = new MessageQueue2<EnhancedMode>(m => JSON.stringify(m));
    const session = { sessionId: fresh ? null : 'provider-same', path: '/fixture', getNativeMode: () => mode, client, queue, mcpServers: { happy: {}, 'lmc-computer': {} }, onSessionFound: vi.fn(), onThinkingChange: vi.fn() };
    running = claudeNativeLauncher(session as any);
    await vi.advanceTimersByTimeAsync(0);
    const hook = (event: string) => fixture.options.onHook({ event, sessionId: 'provider-same' });
    const screen = (ready: boolean) => { composer = ready; relay.outputChanged(); fixture.options.onScreen(); };
    const rpc = (request: any) => handlers.get('native-computer')!(request);
    return { client, queue, session, write, hook, screen, rpc, relay, handlers };
}
describe('native LMC lifecycle', () => {
    it('releases a promoted message after Escape reaches a fresh idle composer even without a Stop hook', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(false); f.hook('UserPromptSubmit');
        f.queue.push('after interrupt', mode, undefined, { key: 'after-stop' });
        await f.handlers.get('promote')!({ key: 'after-stop' });
        await f.handlers.get('abort')!({});
        await vi.advanceTimersByTimeAsync(500);
        expect(f.write.mock.calls.map(c => c[0])).toEqual(['\x1b']);
        expect(f.queue.size()).toBe(1);
        f.screen(true); await vi.advanceTimersByTimeAsync(500);
        expect(f.write.mock.calls.map(c => c[0])).toEqual(['\x1b', '\x1b[200~after interrupt\x1b[201~', '\x1b[13;1u']);
        expect(f.client.closeClaudeSessionTurn).toHaveBeenCalledWith('completed');
    });
    it('marks a native failed turn as failed after its terminal is idle', async () => {
        const f = await setup(); f.hook('SessionStart'); f.hook('UserPromptSubmit'); f.hook('StopFailure'); f.screen(true);
        await vi.advanceTimersByTimeAsync(500);
        expect(f.client.closeClaudeSessionTurn).toHaveBeenCalledWith('failed');
    });
    it('returns to regular mode if the native child cannot spawn, without changing identity', async () => {
        vi.mocked(startNativeInteractiveProcess).mockRejectedValueOnce(new Error('spawn failed'));
        const f = await setup();
        await expect(running).resolves.toBe('switch');
        expect(f.session.sessionId).toBe('provider-same');
        expect(f.write).not.toHaveBeenCalled();
    });
    it('does not auto-exit after a tool reports background work', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true);
        fixture.scanner.onMessage({ type: 'user', uuid: 'bg', toolUseResult: { backgroundTaskId: 'fixture-task' }, message: { content: [] } });
        const observed = await f.rpc({ action: 'claim', clientId: 'client_fixture' });
        await expect(f.rpc({ action: 'leave', clientId: 'client_fixture', epoch: observed.epoch, revision: observed.revision })).rejects.toThrow('/tasks');
        expect(f.write).not.toHaveBeenCalled();
    });
    it('delivers changed-model chat once while background work keeps running, then applies settings after completion', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true);
        fixture.scanner.onMessage({ type: 'user', toolUseResult: { backgroundTaskId: 'task-1' }, message: { content: [] } });
        f.session.getNativeMode = () => ({ ...mode, model: 'opus', effort: 'high' });
        f.queue.push('keep working', f.session.getNativeMode(), undefined, { key: 'deferred' });
        await vi.advanceTimersByTimeAsync(500);
        expect(f.write.mock.calls.map(c => c[0])).toEqual(['\x1b[200~keep working\x1b[201~', '\x1b[13;1u']);
        f.hook('UserPromptSubmit'); f.hook('Stop'); f.screen(true);
        await vi.advanceTimersByTimeAsync(500);
        expect(f.write).toHaveBeenCalledTimes(2);
        expect(f.client.sendSessionEvent.mock.calls.filter(c => c[0].type === 'queue-released')).toEqual([[{ type: 'queue-released', keys: ['deferred'] }]]);
        fixture.scanner.onTaskNotification({ taskId: 'task-1' });
        await vi.advanceTimersByTimeAsync(500);
        expect(f.write.mock.calls.slice(2).map(c => c[0])).toEqual(['\x1b[200~/exit\x1b[201~', '\x1b[13;1u']);
        finish({ exitCode: 0 }); await expect(running).resolves.toBe('restart');
    });
    it('keeps changed permissions queued while background work remains', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true);
        // The production SDK queue hash ignores permission changes except plan.
        f.queue.modeHasher = m => JSON.stringify({ model: m.model, effort: m.effort });
        fixture.scanner.onMessage({ type: 'user', toolUseResult: { backgroundTaskId: 'task-1' }, message: { content: [] } });
        f.queue.push('requires new policy', { ...mode, permissionMode: 'yolo' });
        await vi.advanceTimersByTimeAsync(500);
        expect(f.write).not.toHaveBeenCalled(); expect(f.queue.size()).toBe(1);
    });
    it('wakes an idle native consumer when promoting a deliverable message ahead of a blocked one', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true);
        fixture.scanner.onMessage({ type: 'user', toolUseResult: { backgroundTaskId: 'task-1' }, message: { content: [] } });
        f.queue.push('blocked', { ...mode, permissionMode: 'yolo' });
        f.queue.push('insert now', mode, undefined, { key: 'promoted' });
        await vi.advanceTimersByTimeAsync(500); expect(f.write).not.toHaveBeenCalled();
        await f.handlers.get('promote')!({ key: 'promoted' });
        await vi.advanceTimersByTimeAsync(500);
        expect(f.write.mock.calls.map(c => c[0])).toEqual(['\x1b[200~insert now\x1b[201~', '\x1b[13;1u']);
    });
    it('does not lose a fresh transcript when the first prompt arrives after the scanner missing-file timeout', async () => {
        const f = await setup(true); f.hook('SessionStart'); f.screen(true);
        await vi.advanceTimersByTimeAsync(70000);
        expect(fixture.activate).not.toHaveBeenCalled();
        f.hook('UserPromptSubmit'); expect(fixture.activate).toHaveBeenCalledWith(fixture.options.sessionId);
    });
    it('holds chat during consent, acknowledges only submit, waits through Stop hooks, keeps provider identity', async () => {
        const f = await setup();
        f.queue.push('one', mode, undefined, { key: 'queue_one' });
        await vi.advanceTimersByTimeAsync(1000); expect(f.write).not.toHaveBeenCalled();
        f.hook('SessionStart'); f.screen(true);
        await vi.advanceTimersByTimeAsync(400);
        expect(f.write.mock.calls.map(c => c[0])).toEqual(['\x1b[200~one\x1b[201~', '\x1b[13;1u']);
        expect(f.client.sendSessionEvent).not.toHaveBeenCalled();
        f.hook('UserPromptSubmit'); f.screen(false);
        expect(f.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'queue-released', keys: ['queue_one'] });
        f.queue.push('two', mode); f.hook('Stop');
        await vi.advanceTimersByTimeAsync(1000); expect(f.write).toHaveBeenCalledTimes(2);
        f.screen(true); await vi.advanceTimersByTimeAsync(400);
        expect(f.client.closeClaudeSessionTurn).toHaveBeenCalledWith('completed');
        expect(f.write).toHaveBeenCalledTimes(4);
        expect(fixture.options).toMatchObject({ resume: true, sessionId: 'provider-same' });
        expect(fixture.options.args.join(' ')).not.toContain('lmc-computer');
    });
    it('never retries unconfirmed delivery; explicit terminal input remains available after timeout', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true); f.queue.push('once', mode);
        await vi.advanceTimersByTimeAsync(6000);
        expect(f.write).toHaveBeenCalledTimes(2);
        expect(await f.rpc({ action: 'screen' })).toMatchObject({ phase: 'unconfirmed' });
        await vi.advanceTimersByTimeAsync(15000); expect(f.write).toHaveBeenCalledTimes(2);
        const observed = await f.rpc({ action: 'claim', clientId: 'client_fixture' });
        await f.rpc({ action: 'input', clientId: 'client_fixture', epoch: observed.epoch, revision: observed.revision, requestId: 'manual_enter', input: { type: 'key', key: 'enter' } });
        expect(f.write).toHaveBeenCalledTimes(3);
    });
    it('restores invalid text before any PTY input and blocks unsafe leave while queued', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true); f.queue.push('x\x1b[201~', mode, undefined, { key: 'invalid_text' });
        await vi.advanceTimersByTimeAsync(1000);
        expect(f.write).not.toHaveBeenCalled(); expect(f.queue.snapshot()[0].key).toBe('invalid_text');
        const observed = await f.rpc({ action: 'claim', clientId: 'client_fixture' });
        await expect(f.rpc({ action: 'leave', clientId: 'client_fixture', epoch: observed.epoch, revision: observed.revision })).rejects.toThrow('排队消息');
    });
    it('acknowledges a local goal command from its exact transcript without retrying it', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true);
        f.queue.push('/goal clear', mode, undefined, { key: 'goal_clear' });
        await vi.advanceTimersByTimeAsync(400);
        fixture.scanner.onMessage({ type: 'user', message: { content: '<command-name>/goal</command-name><command-message>goal</command-message><command-args>clear</command-args>' } });
        await vi.advanceTimersByTimeAsync(6000);
        expect(f.write).toHaveBeenCalledTimes(2);
        expect(f.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'queue-released', keys: ['goal_clear'] });
        expect(await f.rpc({ action: 'screen' })).toMatchObject({ phase: 'idle' });
    });
    it('does not resume an unwritten fresh provider record after a settings restart', async () => {
        const f = await setup(true);
        expect(fixture.options.resume).toBe(false);
        f.hook('SessionStart');
        expect(f.session).toMatchObject({ nativeUnwritten: true });
        f.hook('UserPromptSubmit');
        expect(f.session).toMatchObject({ nativeUnwritten: false });
    });
    it('gracefully restarts changed settings without consuming or resending the queued message', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true); f.queue.push('keep', { ...mode, effort: 'high' });
        await vi.advanceTimersByTimeAsync(1000); expect(f.write.mock.calls.map(c => c[0])).toEqual(['\x1b[200~/exit\x1b[201~', '\x1b[13;1u']); expect(f.queue.size()).toBe(1);
        finish({ exitCode: 0 }); await expect(running).resolves.toBe('restart');
    });
});
