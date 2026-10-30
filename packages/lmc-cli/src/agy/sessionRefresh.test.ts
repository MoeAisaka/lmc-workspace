import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), prepare: vi.fn() }));
vi.mock('@/utils/engineAuth', () => ({ checkEngineAuth: mocks.auth }));
vi.mock('@/daemon/controlClient', () => ({ prepareDaemonSessionRefresh: mocks.prepare }));
import { agySessionRefresh } from './sessionRefresh';
import { createAgyTurnQueue } from './turnQueue';
import { applyQueueModeRequest } from '@/utils/sessionQueueControl';

function fixture() {
    let idle = false, metadata: any = {};
    const handlers: Record<string, (value?: unknown) => Promise<any>> = {};
    const session: any = { sessionId: 'same-lmc-session',
        rpcHandlerManager: { registerHandler: (name: string, handler: any) => { handlers[name] = handler; } },
        pauseIncomingMessages: vi.fn(() => 42), waitForIncomingDelivery: vi.fn(async () => {}),
        resumeIncomingMessagesFrom: vi.fn(), markRelaunching: vi.fn(), sendSessionEvent: vi.fn(),
        updateMetadata: vi.fn(async fn => { metadata = fn(metadata); }),
        getMetadata: () => metadata,
    };
    const handoff: any = { arm: vi.fn(), disarm: vi.fn() };
    const queue = createAgyTurnQueue();
    const boundary = { idle: () => idle, settings: () => ({ model: 'flash', permissionMode: 'plan' }), exit: vi.fn(),
        configureQueue: (request: unknown) => applyQueueModeRequest(request, queue, session) };
    const refresh = agySessionRefresh(session, handoff, boundary);
    return { session, handoff, handlers, refresh, boundary, queue, setIdle: () => { idle = true; }, metadata: () => metadata };
}
beforeEach(() => { mocks.auth.mockReset().mockResolvedValue('ready'); mocks.prepare.mockReset().mockResolvedValue({}); });
it('applies queue mode while a refresh is waiting without starting a replacement', async () => {
    const f = fixture();
    await f.handlers['configure-session']({ refreshCli: true });
    await new Promise(resolve => setImmediate(resolve));
    expect(await f.handlers['configure-session']({ queueMode: 'sequential' })).toEqual({ status: 'applied' });
    expect(f.queue.getQueueMode()).toBe('sequential');
    expect(f.metadata().queueMode).toBe('sequential');
    expect(mocks.prepare).not.toHaveBeenCalled();
});
for (const target of ['claude', 'codex']) it(`hands Antigravity to ${target} only after the real turn and queue finish`, async () => {
    const f = fixture();
    expect(await f.handlers['configure-session']({ engine: target, model: 'target-model', permissionMode: 'plan', fallbackBriefing: 'goal and next step' })).toEqual({ status: 'queued' });
    await new Promise(resolve => setImmediate(resolve));
    expect(f.handoff.arm).toHaveBeenCalledWith('goal and next step', target);
    expect(mocks.prepare).not.toHaveBeenCalled();
    f.handoff.onSubmitted();
    expect(f.session.pauseIncomingMessages).toHaveBeenCalledTimes(1);
    f.setIdle(); await f.refresh.drain();
    expect(mocks.auth).toHaveBeenCalledWith(target, process.cwd());
    expect(mocks.prepare).toHaveBeenCalledWith('same-lmc-session', process.pid, { receiveSeq: 42, engine: target, model: 'target-model', permissionMode: 'plan' });
    expect(f.boundary.exit).toHaveBeenCalledOnce();
});
it('keeps the source alive and returns input when target auth fails', async () => {
    const f = fixture(); mocks.auth.mockResolvedValue('required'); f.setIdle();
    await f.handlers['configure-session']({ engine: 'codex', fallbackBriefing: 'goal' });
    await new Promise(resolve => setImmediate(resolve));
    expect(f.boundary.exit).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled();
    expect(f.session.resumeIncomingMessagesFrom).toHaveBeenCalledWith(42);
    expect(f.metadata()).toMatchObject({ sessionConfigState: 'error', sessionConfigErrorKind: 'auth' });
});
it('cancels a queued switch and leaves the native conversation running', async () => {
    const f = fixture(); await f.handlers['configure-session']({ engine: 'claude' });
    await new Promise(resolve => setImmediate(resolve));
    expect(await f.handlers['cancel-session-refresh']()).toEqual({ status: 'cancelled' });
    f.setIdle(); await f.refresh.drain();
    expect(f.boundary.exit).not.toHaveBeenCalled();
});
it('preserves a model selected before the next prompt across a runtime refresh', async () => {
    const f = fixture();
    await f.handlers['configure-session']({ refreshCli: true });
    await new Promise(resolve => setImmediate(resolve));
    await f.session.updateMetadata((m: any) => ({ ...m, modelMode: 'gemini-4-argon-medium', effortLevel: 'high', permissionMode: 'bypassPermissions' }));
    f.setIdle(); await f.refresh.drain();
    expect(mocks.prepare).toHaveBeenCalledWith('same-lmc-session', process.pid, {
        receiveSeq: 42, model: 'gemini-4-argon-medium', effort: 'high', permissionMode: 'bypassPermissions',
    });
    expect(f.boundary.exit).toHaveBeenCalledOnce();
});
