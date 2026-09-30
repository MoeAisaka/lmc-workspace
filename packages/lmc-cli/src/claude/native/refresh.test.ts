import { describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ auth: vi.fn(async () => 'ready'), prepare: vi.fn(async () => ({})) }));
vi.mock('@/utils/engineAuth', () => ({ checkEngineAuth: f.auth }));
vi.mock('@/daemon/controlClient', () => ({ prepareDaemonSessionRefresh: f.prepare }));
vi.mock('../utils/claudeCheckSession', () => ({ claudeCheckSession: () => true }));
import { nativeRefresh } from './refresh';
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
