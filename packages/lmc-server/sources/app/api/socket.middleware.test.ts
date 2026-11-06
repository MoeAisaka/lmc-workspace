import { beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ middleware: null as any, session: vi.fn(), machine: vi.fn(), verify: vi.fn() }));
vi.mock('socket.io', () => ({ Server: class {
    use(callback: any) { mock.middleware = callback; }
    on() {}
} }));
vi.mock('@/storage/db', () => ({ db: { session: { findFirst: mock.session }, machine: { findFirst: mock.machine } } }));
vi.mock('@/app/auth/auth', () => ({ auth: { verifyToken: mock.verify } }));
vi.mock('@/lmc/auth', () => ({ authRevocations: {} }));
vi.mock('@/app/events/eventRouter', () => ({ eventRouter: { init: vi.fn() } }));
vi.mock('@/lmc/access/sessionNotifications', () => ({ initSessionNotifications: vi.fn() }));
vi.mock('@/lmc/access/execution', () => ({ initSharedExecution: vi.fn() }));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));
vi.mock('./socket/usageHandler', () => ({ usageHandler: vi.fn() }));
vi.mock('./usageAnalytics', () => ({ usageAnalyticsHandler: vi.fn() }));
vi.mock('./socket/rpcHandler', () => ({ rpcHandler: vi.fn() }));
vi.mock('./socket/pingHandler', () => ({ pingHandler: vi.fn() }));
vi.mock('./socket/sessionUpdateHandler', () => ({ sessionUpdateHandler: vi.fn() }));
vi.mock('./socket/machineUpdateHandler', () => ({ machineUpdateHandler: vi.fn() }));
vi.mock('./socket/artifactUpdateHandler', () => ({ artifactUpdateHandler: vi.fn() }));
vi.mock('./socket/accessKeyHandler', () => ({ accessKeyHandler: vi.fn() }));

import { startSocket } from './socket';

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('REDIS_URL', '');
    mock.verify.mockResolvedValue({ userId: 'owner', kind: 'device' });
    mock.session.mockResolvedValue({ id: 'session' });
    mock.machine.mockResolvedValue({ id: 'machine' });
    startSocket({ server: {}, addHook: vi.fn() } as any);
});

it.each(['session', 'machine'] as const)('contains %s ownership lookup timeouts, then admits a verified retry', async kind => {
    mock[kind].mockRejectedValueOnce(Object.assign(new Error('Connection pool timed out'), { code: 'P2024' }));
    const makeSocket = () => ({ handshake: { headers: {}, auth: { token: 'synthetic', clientType: `${kind}-scoped`,
        sessionId: 'session', machineId: 'machine' } }, data: {} as Record<string, unknown> });
    const failed = makeSocket(), denied = vi.fn();
    await expect(mock.middleware(failed, denied)).resolves.toBeUndefined();
    expect(denied).toHaveBeenCalledExactlyOnceWith(new Error('Scope verification unavailable'));
    expect(failed.data.userId).toBeUndefined();
    const retry = makeSocket(), accepted = vi.fn();
    await expect(mock.middleware(retry, accepted)).resolves.toBeUndefined();
    expect(accepted).toHaveBeenCalledExactlyOnceWith();
    expect(retry.data.userId).toBe('owner');
});

it('still rejects an ownership mismatch without admitting the socket', async () => {
    mock.session.mockResolvedValue(null);
    const socket = { handshake: { headers: {}, auth: { token: 'synthetic', clientType: 'session-scoped', sessionId: 'other' } }, data: {} };
    const next = vi.fn();
    await mock.middleware(socket, next);
    expect(next).toHaveBeenCalledExactlyOnceWith(new Error('Session scope rejected'));
    expect(socket.data).not.toHaveProperty('userId');
});
