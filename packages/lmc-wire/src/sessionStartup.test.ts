import { expect, it } from 'vitest';
import { isSessionStartRpc, SESSION_REGISTRATION_TIMEOUT_MS, SESSION_START_RPC_TIMEOUT_MS, SESSION_START_ACK_TIMEOUT_MS } from './sessionStartup';
it('extends only the two authenticated creation RPC names', () => {
    expect(isSessionStartRpc('machine:spawn-happy-session')).toBe(true);
    expect(isSessionStartRpc('machine:spawn-lmc-session')).toBe(true);
    for (const name of ['bash', 'runtime-status', 'stop-session', 'spawn-happy-session-extra']) {
        expect(isSessionStartRpc('machine:' + name)).toBe(false);
    }
});
it('leaves headroom for preflight and reconnect around registration', () => {
    expect(SESSION_START_RPC_TIMEOUT_MS - SESSION_REGISTRATION_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(SESSION_START_ACK_TIMEOUT_MS - SESSION_START_RPC_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
});
