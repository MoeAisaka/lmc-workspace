import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/utils/engineAuth', () => ({ checkEngineAuth: vi.fn(async () => 'ready') }));
vi.mock('./nativeEngineLogin', () => ({ startNativeEngineLogin: vi.fn() }));
import { registerEngineLogin } from './registerEngineLogin';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { Metadata } from '@/api/types';
import { startNativeEngineLogin } from './nativeEngineLogin';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); vi.clearAllMocks(); });

it('recovers only failed sessions in the same credential scope using safe refresh RPC', async () => {
    let handler!: (params: unknown) => Promise<any>;
    const machine = { registerDeviceHandler: (_name: string, fn: typeof handler) => { handler = fn; } } as ApiMachineClient;
    const records: Record<string, Metadata> = {};
    for (const id of ['source', 'affected', 'healthy', 'different-scope', 'old', 'codex']) records[id] = {
        flavor: id === 'codex' ? 'codex' : 'claude', hostPid: 7,
        engineAuth: { status: id === 'healthy' ? 'ready' : 'required', checkedAt: 1 },
        sessionCapabilities: { authenticationRecovery: id !== 'old', authentication: true, refresh: true, runtimeConfiguration: false },
    } as Metadata;
    const call = vi.fn(async (id: string, method: string, _params: unknown) => method === 'engine-login-context' ? { engine: 'claude', key: id === 'different-scope' ? 'other' : 'same', supported: true, homeDir: '/fake', configDir: '/fake/.claude', cwd: '/fake' } : { status: 'queued' });
    dispose = registerEngineLogin(machine, { ids: () => Object.keys(records), metadata: async id => records[id], call, alive: async () => true });
    await handler({ engine: 'claude', action: 'check', sessionId: 'source' });
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(call.mock.calls.filter(c => c[1] === 'configure-session')).toEqual([
        ['source', 'configure-session', { refreshCli: true }], ['affected', 'configure-session', { refreshCli: true }],
    ]);
    const status = await handler({ engine: 'claude', action: 'status' });
    expect(status.flow.sessions.map((s: any) => [s.sessionId, s.state])).toEqual([['source', 'waiting'], ['affected', 'waiting'], ['old', 'upgrade']]);
    expect(startNativeEngineLogin).not.toHaveBeenCalled();
    expect(await handler({ engine: 'gemini', action: 'start', sessionId: 'source' })).toEqual({ flow: null, error: 'unsupported' });
});
