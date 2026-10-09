import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { NativeTerminalRelay } from './terminalRelay';
import type { EnhancedMode } from '../loop';
import { LMC_OPTIONS_SYSTEM_PROMPT } from 'lmc-wire';
const fixture = vi.hoisted(() => ({ options: null as any, process: null as any, scanner: null as any, refresh: null as any, activate: vi.fn(), diagnostic: { status: 'none', checkedAt: 1 } as any }));
vi.mock('@/modules/diagnostics/systemDiagnostics', async importOriginal => ({ ...await importOriginal<any>(), detectSystemPrompt: async () => fixture.diagnostic, observeToolProcesses: async () => ({ status: 'alive', liveCount: 1, checkedAt: Date.now() }) }));
vi.mock('./interactiveProcess', () => ({ startNativeInteractiveProcess: vi.fn(async (options: any) => { fixture.options = options; return fixture.process; }) }));
vi.mock('@/runtime/managedRuntime', () => ({ claudeExecutable: () => '/fixture/claude', engineCapabilities: () => ({ turnQueue: true }), runtimeVersion: async () => ({ version: '2.1.286' }) }));
vi.mock('../utils/sessionScanner', () => ({ createSessionScanner: vi.fn(async (options: any) => { fixture.scanner = options; return { cleanup: async () => {}, flush: async () => {}, onNewSession: fixture.activate }; }) }));
vi.mock('../utils/permissionHandler', () => ({ PermissionHandler: class { reset() {} async handleModeChange() {} hasPendingRequests() { return false; } } }));
vi.mock('@/modules/orchestration/workerConfig', () => ({ watchSessionConfiguration: () => () => {} }));
vi.mock('./refresh', () => ({ nativeRefresh: (_session: unknown, boundary: unknown) => { (fixture as any).boundary = boundary; return fixture.refresh; } }));
vi.mock('../utils/systemPrompt', () => ({ systemPrompt: 'fixture' }));
vi.mock('@/modules/common/attachmentInbox', async importOriginal => ({
    ...await importOriginal<any>(),
    saveAttachmentsToInbox: vi.fn(async (attachments: any[]) => attachments.map(a => ({ name: a.name, path: `/fixture/inbox/${a.name}`, size: a.data.length, isImage: true }))),
}));
import { formatInboxNote, saveAttachmentsToInbox } from '@/modules/common/attachmentInbox';
import { claudeNativeLauncher, supportsNativeSteering, nativeExitConfirmation } from './launcher';
import { startNativeInteractiveProcess } from './interactiveProcess';
const mode: EnhancedMode = { model: 'sonnet', effort: 'low', permissionMode: 'default' };
let finish: (result: { exitCode: number }) => void;
let running: Promise<unknown>;
beforeEach(() => { vi.useFakeTimers(); fixture.diagnostic = { status: 'none', checkedAt: 1 }; });
afterEach(async () => { finish?.({ exitCode: 0 }); await running; vi.useRealTimers(); vi.unstubAllEnvs(); });
async function setup(fresh = false) {
    fixture.activate.mockClear();
    fixture.refresh = { pending: false, blocksSteering: false, drain: async () => {}, cancel: async () => {} };
    let composer = false;
    let inputLine = '$';
    let screenLines: string[] | undefined;
    const write = vi.fn();
    const relay = new NativeTerminalRelay({ write, screen: () => ({ lines: screenLines ?? [inputLine], cursor: { x: 1, y: screenLines ? screenLines.length - 1 : 0 }, composer }) });
    fixture.process = { relay, write, pid: 99991, settled: async () => {}, exit: new Promise(resolve => { finish = resolve; }) };
    let state: any = {};
    const handlers = new Map<string, (request: any) => any>();
    const client = { getMetadata: () => ({}), sessionId: 'lmc-same', updateAgentState: vi.fn((update: (state: any) => any) => { state = update(state); }), updateMetadata: vi.fn(async (_update: (metadata: any) => any) => {}), sendSessionEvent: vi.fn(), sendClaudeSessionMessageFromLocalTranscript: vi.fn(async () => {}), closeClaudeSessionTurn: vi.fn(), rpcHandlerManager: { registerHandler: (name: string, handler: any) => handlers.set(name, handler), unregisterHandler: (name: string) => handlers.delete(name) } };
    const queue = new MessageQueue2<EnhancedMode>(m => JSON.stringify(m));
    const session = { sessionId: fresh ? null : 'provider-same', path: '/fixture', getNativeMode: () => mode, client, queue, mcpServers: { happy: {}, 'lmc-computer': {} }, onSessionFound: vi.fn(), onThinkingChange: vi.fn() };
    running = claudeNativeLauncher(session as any);
    await vi.advanceTimersByTimeAsync(0);
    const hook = (event: string) => fixture.options.onHook({ event, sessionId: 'provider-same' });
    const screen = (ready: boolean) => { composer = ready; relay.outputChanged(); fixture.options.onScreen(); };
    const rpc = (request: any) => handlers.get('native-computer')!(request);
    return { client, queue, session, write, hook, screen, rpc, relay, handlers, state: () => state,
        setLines: (lines?: string[]) => { screenLines = lines; }, setInput: (text: string) => { inputLine = text; } };
}
describe('native LMC lifecycle', () => {
    it('reports an unresponsive steer with system diagnostics, then clears protection on its late receipt', async () => {
        fixture.diagnostic = { status: 'detected', checkedAt: 10, owners: ['UserNotificationCenter'], windowCount: 1 };
        const f = await setup(); f.hook('SessionStart'); f.hook('UserPromptSubmit');
        f.queue.push('frozen guidance', mode, undefined, { key: 'freeze' });
        const result = f.handlers.get('steer')!({ key: 'freeze' });
        f.relay.inputChanged();
        await vi.advanceTimersByTimeAsync(6000);
        expect(await result).toEqual({ steered: false, reason: 'unresponsive' });
        expect(f.state().engineDiagnostics.delivery).toMatchObject({ reason: 'unresponsive', keys: ['freeze'], systemPrompt: { status: 'detected' } });
        expect(f.client.sendSessionEvent.mock.calls.some(c => c[0].message?.includes('终端缓冲') && c[0].message.includes('屏幕上'))).toBe(true);
        expect(f.queue.size()).toBe(0); expect(f.write).toHaveBeenCalledTimes(2);
        f.queue.push('later', mode, undefined, { key: 'later' });
        expect(await f.handlers.get('steer')!({ key: 'later' })).toEqual({ steered: false, reason: 'refused' });
        fixture.scanner.onQueuedMessage({ text: 'frozen guidance', timestamp: Date.now() });
        expect(f.state().engineDiagnostics.delivery).toBeUndefined();
        const later = f.handlers.get('steer')!({ key: 'later' }); await vi.advanceTimersByTimeAsync(200);
        fixture.scanner.onQueuedMessage({ text: 'later', timestamp: Date.now() }); expect(await later).toEqual({ steered: true });
        expect(f.client.sendSessionEvent.mock.calls.filter(c => c[0].type === 'queue-released' && c[0].keys.includes('freeze'))).toHaveLength(1);
    });
    it('keeps an echoed steer unconfirmed when only its receipt is absent', async () => {
        const f = await setup(); f.hook('SessionStart'); f.hook('UserPromptSubmit');
        f.queue.push('echoed', mode, undefined, { key: 'echo' });
        const result = f.handlers.get('steer')!({ key: 'echo' }); await vi.advanceTimersByTimeAsync(200);
        f.relay.outputChanged(); await vi.advanceTimersByTimeAsync(6000);
        expect(await result).toEqual({ steered: false, reason: 'unconfirmed' });
        expect(f.state().engineDiagnostics.delivery.reason).toBe('unconfirmed');
        expect(f.queue.size()).toBe(0); expect(f.write).toHaveBeenCalledTimes(2);
    });
    it.each([false, true])('does not resend ordinary native delivery after timeout (echo=%s)', async echo => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true);
        f.queue.push('ordinary', mode, undefined, { key: 'ordinary' }); await vi.advanceTimersByTimeAsync(500);
        if (echo) f.relay.outputChanged();
        await vi.advanceTimersByTimeAsync(6000);
        expect(f.state().engineDiagnostics.delivery).toMatchObject({ kind: 'message', reason: echo ? 'unconfirmed' : 'unresponsive', keys: ['ordinary'] });
        expect(f.queue.size()).toBe(0);
        await vi.advanceTimersByTimeAsync(10000); expect(f.write).toHaveBeenCalledTimes(2);
        fixture.scanner.onQueuedMessage({ text: 'ordinary', timestamp: Date.now() });
        expect(f.state().engineDiagnostics.delivery).toBeUndefined();
        f.hook('UserPromptSubmit');
        expect(f.client.sendSessionEvent.mock.calls.filter(c => c[0].type === 'queue-released')).toEqual([[{ type: 'queue-released', keys: ['ordinary'] }]]);
    });
    it('does not restore ordinary input after a possibly partial PTY write throws', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true);
        f.write.mockImplementationOnce(() => { throw Error('partial PTY write'); });
        f.queue.push('partial ordinary', mode, undefined, { key: 'partial-ordinary' }); await vi.advanceTimersByTimeAsync(500);
        expect(f.queue.size()).toBe(0); expect(f.state().engineDiagnostics.delivery.reason).toBe('unconfirmed');
        await vi.advanceTimersByTimeAsync(10000); expect(f.write).toHaveBeenCalledTimes(1);
    });
    it('publishes no progress once during a busy turn and clears on any real activity', async () => {
        vi.stubEnv('LMC_NO_PROGRESS_TIMEOUT_MS', '5000');
        const f = await setup(); f.hook('SessionStart'); f.hook('UserPromptSubmit');
        await vi.advanceTimersByTimeAsync(6000);
        expect(f.state().engineDiagnostics.noProgress).toMatchObject({ thresholdMs: 5000, toolProcesses: { status: 'alive' } });
        await vi.advanceTimersByTimeAsync(6000);
        // A quiet tool is shown in the session banner only; no chat line.
        const notices = () => f.client.sendSessionEvent.mock.calls.filter(c => c[0].message?.includes('无进展'));
        expect(notices()).toHaveLength(0);
        fixture.options.onOutput(); expect(f.state().engineDiagnostics.noProgress).toBeUndefined();
        const quiet = fixture.diagnostic;
        fixture.diagnostic = { status: 'detected', owners: ['UserNotificationCenter'], windowCount: 1, checkedAt: Date.now() } as any;
        await vi.advanceTimersByTimeAsync(6000); expect(f.state().engineDiagnostics.noProgress).toBeDefined();
        await vi.advanceTimersByTimeAsync(6000);
        expect(notices()).toHaveLength(1);
        fixture.diagnostic = quiet;
        fixture.scanner.onActivity(); expect(f.state().engineDiagnostics.noProgress).toBeUndefined();
        expect(f.write).not.toHaveBeenCalled();
    });
    it('advertises steering only for receipt-capable native versions and clears it on exit', async () => {
        for (const version of [undefined, '', 'unknown', '2.1.285', '2.0.999', '1.9.999', '2.1.286-beta']) expect(supportsNativeSteering(version)).toBe(false);
        for (const version of ['2.1.286', '2.1.287', '2.2.0', '3.0.0']) expect(supportsNativeSteering(version)).toBe(true);
        const f = await setup();
        expect(f.client.updateMetadata.mock.calls[0][0]({})).toMatchObject({ claudeNativeActive: true, sessionCapabilities: { turnSteer: true } });
        finish({ exitCode: 0 }); await running;
        expect(f.client.updateMetadata.mock.calls.at(-1)![0]({ sessionCapabilities: { turnSteer: true } })).toMatchObject({ claudeNativeActive: false, sessionCapabilities: { turnSteer: false } });
    });
    it('steers once through the native queue receipt without interrupting the active turn', async () => {
        const f = await setup(); f.hook('SessionStart'); f.hook('UserPromptSubmit');
        f.queue.push('additional guidance', mode, undefined, { key: 'steer-one' });
        const result = f.handlers.get('steer')!({ key: 'steer-one' });
        await vi.advanceTimersByTimeAsync(400);
        expect(f.write.mock.calls.map(c => c[0])).toEqual(['\x1b[200~additional guidance\x1b[201~', '\x1b[13;1u']);
        fixture.scanner.onQueuedMessage({ text: 'additional guidance', timestamp: Date.now() });
        await expect(result).resolves.toEqual({ steered: true });
        expect(f.client.sendSessionEvent.mock.calls.filter(c => c[0].type === 'queue-released')).toEqual([[{ type: 'queue-released', keys: ['steer-one'] }]]);
        await expect(f.handlers.get('steer')!({ key: 'steer-one' })).resolves.toEqual({ steered: false, reason: 'gone' });
        expect(f.client.closeClaudeSessionTurn).not.toHaveBeenCalled();
        expect(f.write).toHaveBeenCalledTimes(2);
    });
    it('recognises a multi-line message Claude recorded inside its paste tag, for chat and for guidance', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true);
        const wrap = (text: string) => `\n\n<pasted_content id="a7f4">\n${text}\n</pasted_content id="a7f4">\n`;
        f.queue.push('first line\n\nsecond line', mode, undefined, { key: 'chat' });
        await vi.advanceTimersByTimeAsync(600);
        f.hook('UserPromptSubmit');
        fixture.scanner.onMessage({ type: 'user', uuid: 'echo', message: { content: wrap('first line\n\nsecond line') } });
        fixture.scanner.onMessage({ type: 'user', uuid: 'manual', message: { content: wrap('typed in the native window') } });
        await vi.advanceTimersByTimeAsync(0);
        expect(f.client.sendClaudeSessionMessageFromLocalTranscript.mock.calls.map((c: any[]) => c[0].message.content)).toEqual(['typed in the native window']);
        f.screen(false);
        f.queue.push('guide\nmore', mode, undefined, { key: 'steer' });
        const result = f.handlers.get('steer')!({ key: 'steer' });
        await vi.advanceTimersByTimeAsync(400);
        fixture.scanner.onQueuedMessage({ text: wrap('guide\nmore'), timestamp: Date.now() });
        await expect(result).resolves.toEqual({ steered: true });
    });
    it('delivers a message pasted with CRLF instead of leaving it stuck in the queue', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true);
        f.queue.push('第一行\r\n第二行', mode, undefined, { key: 'crlf' });
        await vi.advanceTimersByTimeAsync(600);
        expect(f.write.mock.calls[0][0]).toBe('\x1b[200~第一行\n第二行\x1b[201~');
        expect(f.queue.snapshot()).toEqual([]);
        expect(f.client.sendSessionEvent.mock.calls.some(c => String(c[0].message).includes('无法交付'))).toBe(false);
    });
    it('drains a large mail backlog in bounded batches, retaining FIFO and one receipt per message', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true);
        for (let i = 0; i < 7; i++) f.queue.push(String(i).repeat(3000), mode, undefined, { key: `mail_${i}` });
        await vi.advanceTimersByTimeAsync(600);
        expect(f.write.mock.calls[0]?.[0]).toBe('\x1b[200~' + Array.from({ length: 5 }, (_, i) => String(i).repeat(3000)).join('\n\n') + '\x1b[201~');
        expect(f.queue.snapshot().map(i => i.key)).toEqual(['mail_5', 'mail_6']);
        f.hook('UserPromptSubmit'); f.hook('Stop'); f.screen(true);
        await vi.advanceTimersByTimeAsync(600);
        expect(f.write.mock.calls[2]?.[0]).toBe('\x1b[200~' + '5'.repeat(3000) + '\n\n' + '6'.repeat(3000) + '\x1b[201~');
        f.hook('UserPromptSubmit');
        expect(f.client.sendSessionEvent.mock.calls.filter(c => c[0].type === 'queue-released').flatMap(c => c[0].keys)).toEqual(Array.from({ length: 7 }, (_, i) => `mail_${i}`));
        expect(f.queue.size()).toBe(0);
        expect(f.write).toHaveBeenCalledTimes(4);
    });
    it('counts normalized text and separators against the native input limit', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true);
        f.queue.push('\r\n'.repeat(8191), mode, undefined, { key: 'newlines' });
        f.queue.push('b'.repeat(8191), mode, undefined, { key: 'boundary' });
        f.queue.push('c', mode, undefined, { key: 'next' });
        await vi.advanceTimersByTimeAsync(600);
        expect(f.write.mock.calls[0]?.[0]).toBe('\x1b[200~' + '\n'.repeat(8191) + '\n\n' + 'b'.repeat(8191) + '\x1b[201~');
        expect(f.queue.snapshot().map(i => i.key)).toEqual(['next']);
    });
    it('merges attached and plain queued prompts in one turn, preserving each attachment owner', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true);
        const attachment = (name: string) => ({ name, data: new Uint8Array([1]), mimeType: 'image/png' });
        const note = (name: string) => formatInboxNote([{ name, path: `/fixture/inbox/${name}`, size: 1, isImage: true }]);
        f.queue.push('first screenshot', mode, [attachment('first.png')], { key: 'first' });
        f.queue.push('related instruction', mode, undefined, { key: 'text' });
        f.queue.push('second screenshot', mode, [attachment('second.png')], { key: 'second' });
        await vi.advanceTimersByTimeAsync(600);
        expect(f.write.mock.calls.map(c => c[0])).toEqual([
            '\x1b[200~first screenshot' + note('first.png') + '\n\nrelated instruction\n\nsecond screenshot' + note('second.png') + '\x1b[201~', '\x1b[13;1u',
        ]);
        f.hook('UserPromptSubmit');
        expect(f.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'queue-released', keys: ['first', 'text', 'second'] });
        expect(f.queue.size()).toBe(0);
    });
    it('includes attachment notes in the paste limit and reuses saved files on the next batch', async () => {
        vi.mocked(saveAttachmentsToInbox).mockClear();
        const f = await setup(); f.hook('SessionStart'); f.screen(true);
        f.queue.push('a'.repeat(16_350), mode, undefined, { key: 'large' });
        f.queue.push('image', mode, [{ name: 'queued.png', data: new Uint8Array([1]), mimeType: 'image/png' }], { key: 'image' });
        f.queue.push('tail', mode, undefined, { key: 'tail' });
        await vi.advanceTimersByTimeAsync(600);
        expect(f.write.mock.calls[0][0]).toBe('\x1b[200~' + 'a'.repeat(16_350) + '\x1b[201~');
        expect(f.queue.snapshot().map(item => item.key)).toEqual(['image', 'tail']);
        f.hook('UserPromptSubmit'); f.hook('Stop'); f.screen(true);
        await vi.advanceTimersByTimeAsync(600);
        expect(f.write.mock.calls[2][0]).toContain('image' + formatInboxNote([{ name: 'queued.png', path: '/fixture/inbox/queued.png', size: 1, isImage: true }]) + '\n\ntail');
        expect(saveAttachmentsToInbox).toHaveBeenCalledTimes(1);
        f.hook('UserPromptSubmit');
        expect(f.client.sendSessionEvent.mock.calls.filter(c => c[0].type === 'queue-released').flatMap(c => c[0].keys)).toEqual(['large', 'image', 'tail']);
    });
    it('drops an empty message instead of blocking, and recovers once an undeliverable one is withdrawn', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true);
        f.queue.push('', mode, undefined, { key: 'empty' });
        await vi.advanceTimersByTimeAsync(600);
        expect(f.write).not.toHaveBeenCalled();
        expect(f.queue.snapshot()).toEqual([]);
        expect(f.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'queue-released', keys: ['empty'] });
        f.queue.push('x'.repeat(16385), mode, undefined, { key: 'too_long' });
        f.queue.push('after', mode, undefined, { key: 'after' });
        await vi.advanceTimersByTimeAsync(1000);
        expect(f.write).not.toHaveBeenCalled();
        expect(f.queue.snapshot().map(item => item.key)).toEqual(['too_long', 'after']);
        await expect(f.handlers.get('dequeue')!({ key: 'too_long' })).resolves.toEqual({ removed: true });
        await vi.advanceTimersByTimeAsync(1000);
        expect(f.write.mock.calls[0][0]).toBe('\x1b[200~after\x1b[201~');
    });
    it.each(['draft', 'settings', 'command', 'attachments'])('keeps a refused native steer queued (%s)', async reason => {
        const f = await setup(); f.hook('SessionStart'); f.hook('UserPromptSubmit');
        if (reason === 'draft') f.setInput('$ unfinished manual draft');
        f.queue.push(reason === 'command' ? '! touch unsafe' : 'guidance', reason === 'settings' ? { ...mode, permissionMode: 'yolo' } : mode,
            reason === 'attachments' ? [{ data: new Uint8Array([1]), mimeType: 'application/pdf', name: 'document.pdf' }] : undefined, { key: 'refused' });
        const result = f.handlers.get('steer')!({ key: 'refused' });
        await vi.advanceTimersByTimeAsync(500);
        expect(await result).toEqual({ steered: false, reason: reason === 'draft' ? 'refused' : reason });
        expect(f.queue.snapshot().map(item => item.key)).toEqual(['refused']);
        expect(f.write).not.toHaveBeenCalled();
    });
    it.each([false, true])('steers changed model/effort once and keeps them for the next idle boundary (refresh=%s)', async refreshing => {
        const f = await setup(); f.hook('SessionStart'); f.hook('UserPromptSubmit');
        const selected = { ...mode, model: 'opus', effort: 'high' as const };
        f.session.getNativeMode = () => selected;
        fixture.refresh.pending = refreshing;
        f.queue.push('guidance after model change', selected, undefined, { key: 'model-change' });
        const result = f.handlers.get('steer')!({ key: 'model-change' });
        await vi.advanceTimersByTimeAsync(400);
        expect(f.write.mock.calls.map(c => c[0])).toEqual(['\x1b[200~guidance after model change\x1b[201~', '\x1b[13;1u']);
        fixture.scanner.onQueuedMessage({ text: 'guidance after model change', timestamp: Date.now() });
        expect(await result).toEqual({ steered: true });
        expect(f.queue.size()).toBe(0);
        expect(f.session.getNativeMode()).toEqual(selected);
        expect(f.client.sendSessionEvent.mock.calls.some(c => c[0].message?.includes('当前运行的模型'))).toBe(true);
        expect(f.client.closeClaudeSessionTurn).not.toHaveBeenCalled();
        f.hook('Stop'); f.screen(true); await vi.advanceTimersByTimeAsync(500);
        expect(f.write.mock.calls.slice(2).map(c => c[0])).toEqual(['\x1b[200~/exit\x1b[201~', '\x1b[13;1u']);
        finish({ exitCode: 0 }); expect(await running).toBe('restart');
    });
    it.each(['selected-policy', 'custom-prompt', 'role', 'handoff'])('preserves the queue when a real boundary change blocks steering (%s)', async reason => {
        const f = await setup(); f.hook('SessionStart'); f.hook('UserPromptSubmit');
        if (reason === 'selected-policy') f.session.getNativeMode = () => ({ ...mode, permissionMode: 'yolo' });
        if (reason === 'custom-prompt') f.session.getNativeMode = () => ({ ...mode, appendSystemPrompt: 'Only inspect files.' });
        if (reason === 'role') f.client.getMetadata = () => ({ orchestration: { role: 'hub' } } as any);
        if (reason === 'handoff') { fixture.refresh.pending = true; fixture.refresh.blocksSteering = true; }
        f.queue.push('keep queued', mode, undefined, { key: 'boundary' });
        expect(await f.handlers.get('steer')!({ key: 'boundary' })).toEqual({ steered: false, reason: reason === 'handoff' ? 'refreshing' : 'settings' });
        expect(f.queue.snapshot().map(i => i.key)).toEqual(['boundary']);
        expect(f.write).not.toHaveBeenCalled();
    });
    it('does not retry or restore a steer whose native receipt is missing', async () => {
        const f = await setup(); f.hook('SessionStart'); f.hook('UserPromptSubmit');
        f.queue.push('only once', mode, undefined, { key: 'uncertain' });
        const result = f.handlers.get('steer')!({ key: 'uncertain' });
        await vi.advanceTimersByTimeAsync(6000);
        await expect(result).resolves.toEqual({ steered: false, reason: 'unresponsive' });
        expect(f.queue.size()).toBe(0);
        await vi.advanceTimersByTimeAsync(10000);
        expect(f.write).toHaveBeenCalledTimes(2);
    });
    it('serializes two steers and blocks manual input and interrupt only during paste/Enter', async () => {
        const f = await setup(); f.hook('SessionStart'); f.hook('UserPromptSubmit');
        f.queue.push('first', mode, undefined, { key: 'one' });
        f.queue.push('second', mode, undefined, { key: 'two' });
        const first = f.handlers.get('steer')!({ key: 'one' });
        await vi.advanceTimersByTimeAsync(50);
        expect(await f.handlers.get('steer')!({ key: 'two' })).toEqual({ steered: false, reason: 'refused' });
        expect(f.queue.snapshot().map(i => i.key)).toEqual(['two']);
        await expect(f.handlers.get('abort')!({})).rejects.toThrow('正在交付');
        const lease = await f.rpc({ action: 'claim', clientId: 'client_fixture' });
        await expect(f.rpc({ action: 'input', clientId: 'client_fixture', epoch: lease.epoch, revision: lease.revision, requestId: 'manual', input: { type: 'text', text: 'draft' } })).rejects.toThrow('正在交付');
        await vi.advanceTimersByTimeAsync(200);
        fixture.scanner.onQueuedMessage({ text: 'first', timestamp: Date.now() });
        expect(await first).toEqual({ steered: true });
        expect(f.write).toHaveBeenCalledTimes(2);
        await expect(f.handlers.get('abort')!({})).resolves.toBeUndefined();
        expect(f.write).toHaveBeenLastCalledWith('\x1b');
    });
    it('rechecks settings after waiting for terminal output, before writing', async () => {
        const f = await setup(); f.hook('SessionStart'); f.hook('UserPromptSubmit');
        let ready!: () => void;
        fixture.process.settled = () => new Promise<void>(resolve => { ready = resolve; });
        f.queue.push('new policy', mode, undefined, { key: 'policy' });
        const result = f.handlers.get('steer')!({ key: 'policy' });
        f.session.getNativeMode = () => ({ ...mode, permissionMode: 'yolo' });
        ready();
        expect(await result).toEqual({ steered: false, reason: 'settings' });
        expect(f.write).not.toHaveBeenCalled(); expect(f.queue.size()).toBe(1);
    });
    it('leaves an uncertain draft recoverable when the turn ends between paste and Enter', async () => {
        const f = await setup(); f.hook('SessionStart'); f.hook('UserPromptSubmit');
        f.queue.push('guidance', mode, undefined, { key: 'race' });
        const result = f.handlers.get('steer')!({ key: 'race' });
        await vi.advanceTimersByTimeAsync(50);
        f.setInput('$ guidance'); f.hook('Stop'); f.screen(false);
        await vi.advanceTimersByTimeAsync(400);
        expect(await result).toEqual({ steered: false, reason: 'unconfirmed' });
        expect(f.write).toHaveBeenCalledTimes(1); expect(f.queue.size()).toBe(0);
        f.queue.push('next ordinary prompt', mode, undefined, { key: 'next' });
        await vi.advanceTimersByTimeAsync(6000);
        expect(f.write).toHaveBeenCalledTimes(1);
        // The user clears the draft in the native window. This must not leave
        // the entire session blocked, nor restore/resend the uncertain prompt.
        f.setInput('$'); f.screen(true); await vi.advanceTimersByTimeAsync(500);
        expect(f.write.mock.calls.map(c => c[0])).toEqual(['\x1b[200~guidance\x1b[201~', '\x1b[200~next ordinary prompt\x1b[201~', '\x1b[13;1u']);
    });
    it('ignores stale/unrelated receipts, accepts a late exact receipt without a duplicate release', async () => {
        const f = await setup(); f.hook('SessionStart'); f.hook('UserPromptSubmit');
        f.queue.push('exact guidance', mode, undefined, { key: 'late' });
        const started = Date.now();
        const result = f.handlers.get('steer')!({ key: 'late' });
        await vi.advanceTimersByTimeAsync(200);
        fixture.scanner.onQueuedMessage({ text: 'exact guidance', timestamp: started - 1 });
        fixture.scanner.onQueuedMessage({ text: 'unrelated', timestamp: Date.now() });
        await vi.advanceTimersByTimeAsync(6000);
        expect(await result).toEqual({ steered: false, reason: 'unresponsive' });
        fixture.scanner.onQueuedMessage({ text: 'exact guidance', timestamp: started + 200 });
        f.queue.push('another guidance', mode, undefined, { key: 'again' });
        const again = f.handlers.get('steer')!({ key: 'again' });
        await vi.advanceTimersByTimeAsync(200);
        fixture.scanner.onQueuedMessage({ text: 'another guidance', timestamp: Date.now() });
        expect(await again).toEqual({ steered: true });
        expect(f.client.sendSessionEvent.mock.calls.filter(c => c[0].type === 'queue-released')).toEqual([[{ type: 'queue-released', keys: ['late'] }], [{ type: 'queue-released', keys: ['again'] }]]);
    });
    it('never restores after a PTY write throws, which may have partially delivered', async () => {
        const f = await setup(); f.hook('SessionStart'); f.hook('UserPromptSubmit');
        f.write.mockImplementationOnce(() => { throw Error('partial write'); });
        f.queue.push('partial', mode, undefined, { key: 'partial' });
        expect(await f.handlers.get('steer')!({ key: 'partial' })).toEqual({ steered: false, reason: 'unconfirmed' });
        expect(f.queue.size()).toBe(0); expect(f.write).toHaveBeenCalledTimes(1);
    });
    it('settles an outstanding steer when its native process exits', async () => {
        const f = await setup(); f.hook('SessionStart'); f.hook('UserPromptSubmit');
        f.queue.push('pending at exit', mode, undefined, { key: 'exit' });
        const result = f.handlers.get('steer')!({ key: 'exit' });
        await vi.advanceTimersByTimeAsync(200);
        finish({ exitCode: 1 }); await running;
        expect(await result).toEqual({ steered: false, reason: 'unconfirmed' });
        expect(f.queue.size()).toBe(0); expect(f.write).toHaveBeenCalledTimes(2);
    });
    it.each([false, true])('delivers app reply-format metadata without restarting (background=%s)', async background => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true);
        expect(fixture.options.args[1]).toContain(LMC_OPTIONS_SYSTEM_PROMPT);
        if (background) fixture.scanner.onMessage({ type: 'user', toolUseResult: { backgroundTaskId: 'task-1' }, message: { content: [] } });
        f.queue.push('check progress', { ...mode, appendSystemPrompt: LMC_OPTIONS_SYSTEM_PROMPT }, undefined, { key: 'app-prompt' });
        await vi.advanceTimersByTimeAsync(500);
        expect(f.write.mock.calls.map(c => c[0])).toEqual(['\x1b[200~check progress\x1b[201~', '\x1b[13;1u']);
        f.hook('UserPromptSubmit'); f.hook('Stop'); f.screen(true);
        await vi.advanceTimersByTimeAsync(500);
        expect(f.write).toHaveBeenCalledTimes(2);
        expect(f.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'queue-released', keys: ['app-prompt'] });
    });
    it('keeps custom append instructions queued even when they start with the built-in prompt', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true);
        fixture.scanner.onMessage({ type: 'user', toolUseResult: { backgroundTaskId: 'task-1' }, message: { content: [] } });
        f.queue.push('new custom policy', { ...mode, appendSystemPrompt: LMC_OPTIONS_SYSTEM_PROMPT + '\nOnly inspect files.' });
        await vi.advanceTimersByTimeAsync(500);
        expect(f.write).not.toHaveBeenCalled(); expect(f.queue.size()).toBe(1);
    });
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
    it('clears the prompt Claude restores after an interrupt, then delivers the promoted message', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(false); f.hook('UserPromptSubmit');
        f.queue.push('use this instead', mode, undefined, { key: 'replacement' });
        await f.handlers.get('promote')!({ key: 'replacement' });
        expect(f.write.mock.calls.map(c => c[0])).toEqual(['\x1b']);
        // Claude ends the turn and puts the interrupted prompt back as a draft.
        f.setInput('$  the interrupted prompt'); f.screen(false);
        await vi.advanceTimersByTimeAsync(500);
        expect(f.write.mock.calls.map(c => c[0])).toEqual(['\x1b', '\x1b', '\x1b']);
        expect(f.queue.size()).toBe(1);
        f.setInput('$ '); f.screen(true);
        await vi.advanceTimersByTimeAsync(1200);
        expect(f.write.mock.calls.map(c => c[0]).slice(3)).toEqual(['\x1b[200~use this instead\x1b[201~', '\x1b[13;1u']);
        expect(f.client.closeClaudeSessionTurn).toHaveBeenCalledWith('completed');
    });
    it('stops trying to clear a draft that will not go away', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(false); f.hook('UserPromptSubmit');
        await f.handlers.get('abort')!({});
        f.setInput('$  stubborn draft');
        for (let i = 0; i < 6; i++) { f.screen(false); await vi.advanceTimersByTimeAsync(800); }
        expect(f.write.mock.calls.filter(c => c[0] === '\x1b')).toHaveLength(1 + 3 * 2);
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
    it('wakes the idle boundary after a successful TaskStop without a queue notification', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true);
        fixture.scanner.onMessage({ type: 'user', toolUseResult: { backgroundTaskId: 'task-1' }, message: { content: [{ type: 'tool_result', tool_use_id: 'start' }] } });
        f.session.getNativeMode = () => ({ ...mode, model: 'opus', effort: 'high' });
        await vi.advanceTimersByTimeAsync(500);
        expect(f.write).not.toHaveBeenCalled();
        fixture.scanner.onMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'stop', name: 'TaskStop', input: { task_id: 'task-1' } }] } });
        fixture.scanner.onMessage({ type: 'user', toolUseResult: { message: 'Successfully stopped task: task-1', task_id: 'task-1' }, message: { content: [{ type: 'tool_result', tool_use_id: 'stop' }] } });
        await vi.advanceTimersByTimeAsync(500);
        expect(f.write.mock.calls.map(c => c[0])).toEqual(['\x1b[200~/exit\x1b[201~', '\x1b[13;1u']);
        finish({ exitCode: 0 }); expect(await running).toBe('restart');
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
    it('never retries unresponsive delivery; explicit terminal input remains available after timeout', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true); f.queue.push('once', mode);
        await vi.advanceTimersByTimeAsync(6000);
        expect(f.write).toHaveBeenCalledTimes(2);
        expect(await f.rpc({ action: 'screen' })).toMatchObject({ phase: 'unresponsive' });
        await vi.advanceTimersByTimeAsync(15000); expect(f.write).toHaveBeenCalledTimes(2);
        const observed = await f.rpc({ action: 'claim', clientId: 'client_fixture' });
        await f.rpc({ action: 'input', clientId: 'client_fixture', epoch: observed.epoch, revision: observed.revision, requestId: 'manual_enter', input: { type: 'key', key: 'enter' } });
        expect(f.write).toHaveBeenCalledTimes(3);
    });
    it('restores invalid text before any PTY input and blocks unsafe leave while queued', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true); f.queue.push('x'.repeat(16385), mode, undefined, { key: 'invalid_text' }); // Control bytes are stripped now; over-long text still cannot be pasted.
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
    it.each([false, true])('acknowledges a Bash input receipt and waits for the real turn boundary (late=%s)', async late => {
        const f = await setup(true); f.hook('SessionStart'); f.screen(true);
        f.queue.push('! printf receipt', mode, undefined, { key: 'bash' });
        await vi.advanceTimersByTimeAsync(400);
        expect(fixture.activate).toHaveBeenCalledWith(fixture.options.sessionId);
        f.screen(false);
        if (late) await vi.advanceTimersByTimeAsync(6000);
        f.queue.push('next message', mode, undefined, { key: 'next' });
        fixture.scanner.onMessage({ type: 'user', timestamp: new Date().toISOString(), message: { content: '<bash-input> printf receipt</bash-input>' } });
        await vi.advanceTimersByTimeAsync(6000);
        expect(f.state().engineDiagnostics?.delivery).toBeUndefined();
        expect(f.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'queue-released', keys: ['bash'] });
        expect(f.client.sendClaudeSessionMessageFromLocalTranscript).not.toHaveBeenCalled();
        expect(f.session).toMatchObject({ nativeUnwritten: false });
        expect(await f.rpc({ action: 'screen' })).toMatchObject({ phase: 'busy' });
        expect(f.write).toHaveBeenCalledTimes(2);
        fixture.scanner.onMessage({ type: 'user', message: { content: '<bash-stdout>receipt</bash-stdout><bash-stderr></bash-stderr>' } });
        f.hook('Stop'); f.screen(true); await vi.advanceTimersByTimeAsync(500);
        expect(f.write.mock.calls[2][0]).toBe('\x1b[200~next message\x1b[201~');
        expect(f.client.sendClaudeSessionMessageFromLocalTranscript).toHaveBeenCalledTimes(1);
    });
    it.each(['stale', 'different', 'missing-time', 'malformed'])('does not acknowledge an unrelated Bash record (%s)', async kind => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true);
        const before = Date.now();
        f.queue.push('! printf receipt', mode, undefined, { key: 'bash' });
        await vi.advanceTimersByTimeAsync(500);
        fixture.scanner.onMessage({ type: 'user', timestamp: kind === 'missing-time' ? undefined : new Date(kind === 'stale' ? before : Date.now()).toISOString(),
            message: { content: kind === 'different' ? '<bash-input> printf other</bash-input>' : kind === 'malformed' ? 'quoted <bash-input> printf receipt</bash-input>' : '<bash-input> printf receipt</bash-input>' } });
        await vi.advanceTimersByTimeAsync(6000);
        expect(f.state().engineDiagnostics.delivery.keys).toEqual(['bash']);
        expect(f.client.sendSessionEvent.mock.calls.some(c => c[0].type === 'queue-released')).toBe(false);
        expect(f.write).toHaveBeenCalledTimes(2);
    });
    it.each([false, true])('preserves a Stop boundary that arrived before the Bash receipt (idle=%s)', async idle => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true);
        f.queue.push('! false', mode, undefined, { key: 'bash' });
        await vi.advanceTimersByTimeAsync(500);
        f.hook('Stop');
        expect(fixture.activate).toHaveBeenCalledTimes(2);
        if (idle) await vi.advanceTimersByTimeAsync(500);
        fixture.scanner.onMessage({ type: 'user', timestamp: new Date().toISOString(), message: { content: '<bash-input> false</bash-input>' } });
        await vi.advanceTimersByTimeAsync(500);
        expect(await f.rpc({ action: 'screen' })).toMatchObject({ phase: 'idle' });
        expect(f.state().engineDiagnostics?.delivery).toBeUndefined();
        expect(f.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'queue-released', keys: ['bash'] });
    });
    it.each([['! printf receipt', 'normal text'], ['normal text', '! printf receipt']])('keeps Bash commands separate from adjacent chat (%s)', async (first, second) => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true);
        f.queue.push(first, mode, undefined, { key: 'first' });
        f.queue.push(second, mode, undefined, { key: 'second' });
        await vi.advanceTimersByTimeAsync(500);
        expect(f.write.mock.calls[0][0]).toBe(`\x1b[200~${first}\x1b[201~`);
        expect(f.queue.snapshot().map(item => item.key)).toEqual(['second']);
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
    it('cancels a late exit confirmation and resumes queued mail only after the composer returns', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true);
        f.queue.push('worker report', { ...mode, effort: 'high' }, undefined, { key: 'report' });
        await vi.advanceTimersByTimeAsync(6000);
        f.setLines(['Background work is running', 'The following will stop when you exit:', '1. Exit and stop tasks', '2. Move to background and exit', '3. Stay', 'Select with numbers [1-3]. Then Enter to submit:']);
        f.screen(false); await vi.advanceTimersByTimeAsync(600);
        expect(f.write.mock.calls.map(c => c[0])).toEqual(['\x1b[200~/exit\x1b[201~', '\x1b[13;1u', '3\r']);
        expect(f.queue.snapshot().map(i => i.key)).toEqual(['report']);
        await vi.advanceTimersByTimeAsync(1500);
        expect(f.write).toHaveBeenCalledTimes(3);
        f.setLines(undefined); f.screen(true); await vi.advanceTimersByTimeAsync(600);
        expect(f.write.mock.calls[3][0]).toBe('\x1b[200~worker report\x1b[201~');
        f.hook('UserPromptSubmit');
        expect(f.client.sendSessionEvent.mock.calls.filter(c => c[0].type === 'queue-released')).toEqual([[{ type: 'queue-released', keys: ['report'] }]]);
        expect(f.state().engineDiagnostics?.nativeExit).toBeUndefined();
    });
    it('keeps version-checked manual cancel usable after an exit timeout, without replaying mail', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true);
        f.queue.push('retained mail', { ...mode, effort: 'high' }, undefined, { key: 'mail' });
        await vi.advanceTimersByTimeAsync(31_000);
        expect(f.state().engineDiagnostics.nativeExit.since).toBeTypeOf('number');
        const claim = await f.rpc({ action: 'claim', clientId: 'exit-recovery' });
        await expect(f.rpc({ action: 'input', clientId: 'exit-recovery', epoch: claim.epoch, revision: claim.revision,
            requestId: 'cancel-exit', input: { type: 'key', key: 'escape' } })).resolves.toMatchObject({ repeated: false });
        expect(f.queue.snapshot().map(i => i.key)).toEqual(['mail']);
        f.screen(true); await vi.advanceTimersByTimeAsync(600);
        f.hook('UserPromptSubmit');
        expect(f.state().engineDiagnostics.nativeExit).toBeUndefined();
        expect(f.write.mock.calls.filter(c => c[0] === '\x1b[200~retained mail\x1b[201~')).toHaveLength(1);
    });
    it('names the work Claude kept, lifts the hold only for an explicit stop, and then answers "Exit and stop"', async () => {
        const f = await setup(); f.hook('SessionStart'); f.screen(true); await vi.advanceTimersByTimeAsync(200);
        const boundary = (fixture as any).boundary;
        const menu = ['you: /exit', 'Background work is running', 'The following will stop when you exit:', 'scheduled task  · Runs once in 1h · reminder',
            '1. Exit and stop tasks', '2. Move to background and exit', '3. Stay', 'Select with numbers [1-3]. Then Enter to submit:'];
        const refused = boundary.exit(undefined).then(() => 'left', (error: Error) => error.message);
        await vi.advanceTimersByTimeAsync(600);
        f.setLines(menu); f.screen(false); await vi.advanceTimersByTimeAsync(600);
        expect(f.write.mock.calls.map(c => c[0])).toEqual(['\x1b[200~/exit\x1b[201~', '\x1b[13;1u', '3\r']);
        f.setLines(undefined); f.screen(true); await vi.advanceTimersByTimeAsync(600);
        expect(await refused).toContain('scheduled task · Runs once in 1h · reminder');
        // The hold names the work; a wait is not given up on; only a stop lifts it.
        expect(boundary.blocker()).toContain('reminder');
        expect(boundary.blocker('wait')).toContain('reminder');
        expect(boundary.blocker('stop')).toBeNull();
        expect(boundary.blockedWork()).toEqual(['scheduled task · Runs once in 1h · reminder']);
        expect(boundary.standing()).toBe(true); expect(boundary.standing('wait')).toBe(false);
        const stopping = boundary.exit('stop');
        await vi.advanceTimersByTimeAsync(600);
        f.setLines(menu); f.screen(false); await vi.advanceTimersByTimeAsync(600);
        expect(f.write.mock.calls.map(c => c[0]).slice(3)).toEqual(['\x1b[200~/exit\x1b[201~', '\x1b[13;1u', '1\r']);
        finish({ exitCode: 0 }); await stopping;
        await expect(running).resolves.toBe('refresh');
    });
    it('recognises Claude asking before an exit that would stop its own work, and picks Stay', () => {
        const dialog = ['you: /exit', 'Background work is running', 'The following will stop when you exit:', 'scheduled task  · Runs once in 1h · reminder',
            '1. Exit and stop tasks', '2. Move to background and exit', '3. Stay', 'Select with numbers [1-3]. Then Enter to submit:'];
        expect(nativeExitConfirmation(dialog)).toBe(3);
        expect(nativeExitConfirmation(['Background work is running', '1. Stay', '2. Exit and stop tasks'])).toBe(1);
        // Ordinary chat that happens to list the same words is not the question.
        expect(nativeExitConfirmation(['claude: options are', '1. Exit', '3. Stay'])).toBeNull();
        expect(nativeExitConfirmation(['Background work is running', '1. Exit and stop tasks'])).toBeNull();
        expect(nativeExitConfirmation([])).toBeNull();
    });
});
