import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/persistence', () => ({ readDaemonState: async () => ({ pid: process.pid, httpPort: 1234 }), clearDaemonState: vi.fn() }));
import { assertSessionReconnectAvailable, notifyDaemonSessionStarted } from './controlClient';
import { startDaemonControlServer } from './controlServer';
import { assertSessionOwnerAvailable, SESSION_OWNERSHIP_CONFLICT } from './sessionOwnership';

afterEach(() => vi.unstubAllGlobals());
describe('session ownership at the daemon boundary', () => {
    it('rejects duplicate registration before the persistence callback can run', async () => {
        const persisted = vi.fn();
        const server = await startDaemonControlServer({ getChildren: () => [], stopSession: () => false,
            spawnSession: async () => ({ type: 'error', errorMessage: 'fixture' }), requestShutdown: () => {},
            onHappySessionWebhook: (id, metadata) => {
                assertSessionOwnerAvailable(id, metadata.hostPid!, [{ happySessionId: 'existing', pid: 10 }], () => true);
                persisted();
            } });
        try {
            const response = await fetch(`http://127.0.0.1:${server.port}/session-started`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: 'existing', metadata: { hostPid: 11 } }) });
            expect(response.status).toBe(409);
            expect((await response.json() as { code: string }).code).toBe(SESSION_OWNERSHIP_CONFLICT);
            expect(persisted).not.toHaveBeenCalled();
        } finally { await server.stop(); }
    });
    it('does not retry or ignore a duplicate registration refusal', async () => {
        const request = vi.fn(async () => new Response(JSON.stringify({ code: SESSION_OWNERSHIP_CONFLICT, error: 'already owned' }), { status: 409 }));
        vi.stubGlobal('fetch', request);
        await expect(notifyDaemonSessionStarted('existing', { hostPid: process.pid } as any)).rejects.toThrow(/already owned/);
        expect(request).toHaveBeenCalledTimes(1);
    });
    it('refuses reconnect if the daemon owner cannot be verified', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
        await expect(assertSessionReconnectAvailable('existing')).rejects.toThrow(/Cannot verify/);
    });
    it('refuses a reconnect while a different live runner owns the session', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ children: [{ happySessionId: 'existing', pid: process.ppid }] }))));
        await expect(assertSessionReconnectAvailable('existing')).rejects.toThrow(/already owned/);
    });
    it('allows an idle handoff after the old owner has exited', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ children: [] }))));
        await expect(assertSessionReconnectAvailable('existing')).resolves.toBeUndefined();
    });
});
