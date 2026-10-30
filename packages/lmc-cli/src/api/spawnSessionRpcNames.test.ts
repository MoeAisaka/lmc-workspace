import { describe, expect, it, vi } from 'vitest';
import { ApiMachineClient } from './apiMachine';
import type { Machine } from './types';
import { logger } from '@/ui/logger';

vi.mock('socket.io-client', () => ({ io: vi.fn() }));
vi.mock('@/configuration', () => ({
    configuration: { serverUrl: 'http://127.0.0.1:3005', currentCliVersion: 'test' }
}));
vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), debugLargeJson: vi.fn(), info: vi.fn(), warn: vi.fn() }
}));

const machine = (): Machine => ({
    id: 'machine-1',
    seq: 1,
    metadata: null,
    metadataVersion: 0,
    daemonState: null,
    daemonStateVersion: 0,
    encryptionKey: new Uint8Array(32),
    encryptionVariant: 'dataKey'
} as unknown as Machine);

/**
 * `spawn-happy-session` is the name every released daemon registers and every
 * released caller dials. Renaming it in one step would strand whichever side
 * upgraded first — and the failure would surface on the remote machine, far
 * from whoever made the change. So the daemon answers to both names until every
 * device is known to run a version that does.
 *
 * This test exists to make removing either registration a deliberate act: drop
 * one and the assertion names exactly what breaks.
 */
describe('spawn session RPC method names', () => {
    it('registers the new and the previous name against the same handler', () => {
        const client = new ApiMachineClient('fake-token', machine());
        const registered = new Map<string, unknown>();
        (client as any).rpcHandlerManager = {
            registerHandler: (method: string, handler: unknown) => registered.set(method, handler),
            unregisterHandler: () => {}
        };
        (client as any).syncResumeSessionRpcRegistration = () => {};

        client.setRPCHandlers({
            spawnSession: async () => ({ type: 'success', sessionId: 's' }),
            stopSession: async () => ({ message: 'stopped' }),
            requestShutdown: async () => ({ message: 'shutting down' })
        } as any);

        expect(registered.has('spawn-lmc-session')).toBe(true);
        expect(registered.has('spawn-happy-session')).toBe(true);
        expect(registered.get('spawn-lmc-session')).toBe(registered.get('spawn-happy-session'));
    });

    it('rejects unsupported credentials before the spawn callback and never logs their values', async () => {
        vi.clearAllMocks();
        const client = new ApiMachineClient('fake-token', machine());
        const handlers = new Map<string, (params: any) => Promise<any>>();
        (client as any).rpcHandlerManager = { registerHandler: (method: string, handler: any) => handlers.set(method, handler), unregisterHandler: () => {} };
        (client as any).syncResumeSessionRpcRegistration = () => {};
        const spawnSession = vi.fn(async (_options: unknown) => ({ type: 'success', sessionId: 'synthetic-session' }));
        client.setRPCHandlers({ spawnSession, stopSession: vi.fn(), requestShutdown: vi.fn() } as any);

        const spawn = handlers.get('spawn-lmc-session')!;
        await expect(spawn({ agent: 'agy', directory: '/test', token: 'NEVER-LOG-TOKEN', environmentVariables: { SECRET: 'NEVER-LOG-ENV' } })).rejects.toThrow('native login');
        await expect(spawn({ agent: 'codex', directory: '/test', token: '' })).rejects.toThrow('empty');
        expect(spawnSession).not.toHaveBeenCalled();
        expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain('NEVER-LOG');

        await spawn({ agent: 'codex', directory: '/test', token: 'NEVER-LOG-VALID-TOKEN' });
        expect(spawnSession).toHaveBeenCalledOnce();
        expect(spawnSession.mock.calls[0][0]).toMatchObject({ agent: 'codex', token: 'NEVER-LOG-VALID-TOKEN' });
        expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain('NEVER-LOG');
    });
});
