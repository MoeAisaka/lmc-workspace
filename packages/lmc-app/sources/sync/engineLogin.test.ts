import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('./apiSocket', () => ({ apiSocket: { machineRPC: vi.fn() } }));
vi.mock('./storage', () => ({ storage: { getState: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { apiSocket } from './apiSocket';
import { storage } from './storage';
import { engineLoginError, engineLoginRequest, shouldAutoRecover } from './engineLogin';

let state: any;
beforeEach(() => {
    vi.clearAllMocks();
    state = { sessions: { s: { metadata: { flavor: 'claude', machineId: 'm', sessionCapabilities: { authenticationRecovery: true } } } }, machines: { m: { active: true, metadata: { engineLogin: { claude: true, codex: true } } } } };
    vi.mocked(storage.getState).mockReturnValue(state);
    vi.mocked(apiSocket.machineRPC).mockResolvedValue({ flow: null });
});
it('fails closed when either the daemon or session lacks the capability', async () => {
    state.sessions.s.metadata.sessionCapabilities = {};
    expect((await engineLoginRequest('s', 'start')).error).toBe('upgrade');
    state.sessions.s.metadata.sessionCapabilities.authenticationRecovery = true;
    state.machines.m.metadata.engineLogin = undefined;
    expect((await engineLoginRequest('s', 'start')).error).toBe('upgrade');
    expect(apiSocket.machineRPC).not.toHaveBeenCalled();
});
it('distinguishes offline from expired credentials and never sends another engine options', async () => {
    state.machines.m.active = false;
    expect((await engineLoginRequest('s', 'start')).error).toBe('offline');
    expect(apiSocket.machineRPC).not.toHaveBeenCalled();
    state.machines.m.active = true;
    state.sessions.s.metadata.flavor = 'codex';
    await engineLoginRequest('s', 'start');
    expect(apiSocket.machineRPC).toHaveBeenCalledWith('m', 'engine-login', { engine: 'codex', action: 'start', sessionId: 's' });
});
it('sends a code only through the encrypted machine RPC without storage mutations', async () => {
    const previous = JSON.stringify(state);
    await engineLoginRequest('s', 'submit', { id: 'attempt', code: 'synthetic_code' });
    expect(apiSocket.machineRPC).toHaveBeenCalledWith('m', 'engine-login', { engine: 'claude', action: 'submit', sessionId: 's', id: 'attempt', code: 'synthetic_code' });
    expect(JSON.stringify(state)).toBe(previous);
});
it('sanitizes transport exceptions', async () => {
    vi.mocked(apiSocket.machineRPC).mockRejectedValue(new Error('private raw transport data'));
    expect(await engineLoginRequest('s', 'check')).toEqual({ flow: null, error: 'offline' });
});
it('limits automatic recovery to once per observed auth failure', () => {
    expect(shouldAutoRecover('auto-s', 1)).toBe(true);
    expect(shouldAutoRecover('auto-s', 1)).toBe(false);
    expect(shouldAutoRecover('auto-s', 2)).toBe(true);
});
it('preserves distinct error explanations', () => {
    expect(engineLoginError('unknown')).not.toBe(engineLoginError('required'));
    expect(engineLoginError('upgrade')).not.toBe(engineLoginError('offline'));
});
