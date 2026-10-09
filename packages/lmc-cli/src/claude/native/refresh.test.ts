import { describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ auth: vi.fn(async () => 'ready'), prepare: vi.fn(async () => ({})) }));
vi.mock('@/utils/engineAuth', () => ({ checkEngineAuth: f.auth }));
vi.mock('@/daemon/controlClient', () => ({ prepareDaemonSessionRefresh: f.prepare }));
vi.mock('../utils/claudeCheckSession', () => ({ claudeCheckSession: () => true }));
import { nativeRefresh } from './refresh';
import { NativeExitRefusedError } from './exitGuard';

function harness(exit: (choice?: string) => Promise<void>, blocker: (choice?: string) => string | null = () => null) {
    const handlers = new Map(); let metadata: any = {};
    const client = { sessionId: 'lmc-id', pauseIncomingMessages: vi.fn(() => 17), waitForIncomingDelivery: async () => {}, resumeIncomingMessagesFrom: vi.fn(),
        markRelaunching: vi.fn(), updateMetadata: async (update: any) => { metadata = update(metadata); },
        rpcHandlerManager: { registerHandler: (name: string, fn: any) => handlers.set(name, fn) } };
    const session = { client, sessionId: 'provider-id', path: '/fixture', getRefreshSettings: () => ({ model: 'opus', effort: 'high' }), queue: {} } as any;
    const refresh = nativeRefresh(session, { blocker, flush: async () => {}, exit, blockedWork: () => ['scheduled task · reminder'] });
    return { refresh, client, meta: () => metadata, configure: (request: unknown) => handlers.get('configure-session')(request), cancel: () => handlers.get('cancel-session-refresh')() };
}

it('passes the stop choice to the exit and refuses any other extra key', async () => {
    f.auth.mockReset().mockResolvedValue('ready'); f.prepare.mockClear();
    const exit = vi.fn(async () => {});
    const h = harness(exit);
    await expect(h.configure({ refreshCli: true, backgroundWork: 'maybe' })).rejects.toThrow();
    await expect(h.configure({ refreshCli: true, model: 'x' })).rejects.toThrow();
    await h.configure({ refreshCli: true, backgroundWork: 'stop' });
    expect(exit).toHaveBeenCalledWith('stop');
});

it('keeps a wait-for-work refresh queued with the work named after Claude declines, and retries at the next boundary', async () => {
    f.auth.mockReset().mockResolvedValue('ready'); f.prepare.mockClear();
    let refusals = 0;
    const exit = vi.fn(async () => { if (refusals++ < 1) throw new NativeExitRefusedError(['scheduled task · reminder']); });
    const h = harness(exit);
    await h.configure({ refreshCli: true, backgroundWork: 'wait' });
    expect(exit).toHaveBeenCalledWith('wait');
    expect(h.meta().sessionConfigState).toBe('queued');
    expect(h.meta().sessionConfigError).toContain('scheduled task · reminder');
    expect(h.meta().sessionConfigBackgroundWork).toEqual(['scheduled task · reminder']);
    expect(h.client.resumeIncomingMessagesFrom).toHaveBeenCalledWith(17);
    expect(h.client.markRelaunching).toHaveBeenLastCalledWith(false);
    expect(h.refresh.pending).toBe(true);
    // A plain retry does not replace the wait; the boundary watch does the retrying.
    await expect(h.configure({ refreshCli: true })).resolves.toEqual({ status: 'queued' });
    await h.refresh.drain();
    expect(exit).toHaveBeenCalledTimes(2);
    expect(h.meta().sessionConfigState).toBe('refreshing');
    expect(h.refresh.pending).toBe(false);
});

it('a refusal without a wait choice fails the refresh but keeps the work list for the card', async () => {
    f.auth.mockReset().mockResolvedValue('ready'); f.prepare.mockClear();
    const h = harness(async () => { throw new NativeExitRefusedError(['scheduled task · reminder']); });
    await h.configure({ refreshCli: true });
    expect(h.meta().sessionConfigState).toBe('error');
    expect(h.meta().sessionConfigErrorKind).toBe('relaunch');
    expect(h.meta().sessionConfigBackgroundWork).toEqual(['scheduled task · reminder']);
    expect(h.refresh.pending).toBe(false);
    // Choosing to stop replaces the failed attempt with a new one that carries the choice.
    const exit = vi.fn(async () => {});
    const h2 = harness(exit, choice => choice === 'stop' ? null : 'scheduled task holds the exit');
    await h2.configure({ refreshCli: true, backgroundWork: 'wait' });
    expect(exit).not.toHaveBeenCalled(); expect(h2.meta().sessionConfigState).toBe('queued');
    await h2.configure({ refreshCli: true, backgroundWork: 'stop' });
    expect(exit).toHaveBeenCalledWith('stop');
});

it('native refresh holds the cursor and waits for its real boundary before preparing the same provider session', async () => {
    f.auth.mockClear(); f.prepare.mockClear();
    const handlers = new Map(); let blocker: string | null = 'background work'; let metadata: any = {};
    const client = { sessionId: 'lmc-id', pauseIncomingMessages: vi.fn(() => 17), waitForIncomingDelivery: async () => {}, resumeIncomingMessagesFrom: vi.fn(),
        markRelaunching: vi.fn(), updateMetadata: async (update: any) => { metadata = update(metadata); },
        rpcHandlerManager: { registerHandler: (name: string, fn: any) => handlers.set(name, fn) } };
    const session = { client, sessionId: 'provider-id', path: '/fixture', getRefreshSettings: () => ({ model: 'opus', effort: 'high' }), queue: {} } as any;
    const exit = vi.fn(async () => {});
    const refresh = nativeRefresh(session, { blocker: () => blocker, flush: async () => {}, exit });
    await handlers.get('configure-session')({ refreshCli: true });
    expect(f.prepare).not.toHaveBeenCalled(); expect(exit).not.toHaveBeenCalled();
    blocker = null; await refresh.drain();
    expect(f.prepare).toHaveBeenCalledWith('lmc-id', process.pid, { receiveSeq: 17, model: 'opus', effort: 'high' });
    expect(client.resumeIncomingMessagesFrom).not.toHaveBeenCalled(); expect(exit).toHaveBeenCalledOnce();
    expect(metadata.sessionConfigState).toBe('refreshing'); expect(session.sessionId).toBe('provider-id');
});

it('starts a new refresh timestamp before retry preflight and preserves input after another exit refusal', async () => {
    vi.useFakeTimers();
    const first = new Date('2026-10-04T03:38:43.215Z').getTime();
    const second = new Date('2026-10-04T04:28:40.111Z').getTime();
    try {
        f.auth.mockReset().mockResolvedValue('ready'); f.prepare.mockClear();
        vi.setSystemTime(first);
        const handlers = new Map(); let metadata: any = {};
        const client = { sessionId: 'lmc-id', pauseIncomingMessages: vi.fn(() => 17), waitForIncomingDelivery: async () => {},
            resumeIncomingMessagesFrom: vi.fn(), markRelaunching: vi.fn(),
            updateMetadata: async (update: any) => { metadata = update(metadata); },
            rpcHandlerManager: { registerHandler: (name: string, fn: any) => handlers.set(name, fn) } };
        const session = { client, sessionId: 'provider-id', path: '/fixture',
            getRefreshSettings: () => ({ model: 'fable', effort: 'medium' }), queue: {} } as any;
        const exit = vi.fn(async () => { throw new Error('scheduled work was preserved'); });
        nativeRefresh(session, { blocker: () => null, flush: async () => {}, exit });
        await handlers.get('configure-session')({ refreshCli: true });
        expect(metadata.sessionConfigRequestedAt).toBe(first);
        expect(metadata.sessionConfigState).toBe('error');

        vi.setSystemTime(second);
        let authenticate!: (status: string) => void;
        f.auth.mockImplementationOnce(() => new Promise(resolve => { authenticate = resolve; }));
        const retry = handlers.get('configure-session')({ refreshCli: true });
        await vi.waitFor(() => expect(authenticate).toBeDefined());
        try {
            expect(metadata.sessionConfigState).toBe('queued');
            expect(metadata.sessionConfigError).toBeUndefined();
            expect(metadata.sessionConfigRequestedAt).toBe(second);
        } finally {
            vi.setSystemTime(second + 8_000);
            authenticate('ready');
            await retry;
        }
        expect(metadata.sessionConfigState).toBe('error');
        expect(metadata.sessionConfigUpdatedAt - metadata.sessionConfigRequestedAt).toBe(8_000);
        expect(client.resumeIncomingMessagesFrom).toHaveBeenCalledTimes(2);
        expect(client.markRelaunching).toHaveBeenLastCalledWith(false);
        expect(session.sessionId).toBe('provider-id');
    } finally { vi.useRealTimers(); }
});
