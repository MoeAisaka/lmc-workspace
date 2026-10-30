import { describe, it, expect } from 'vitest';
import { allowsRuntimePacket, parseRuntimeScope } from './runtimeScope';

describe('scoped runtime socket boundary', () => {
    const scope = { sessionId: 'session-one', machineId: 'machine-one' };
    it('only registers methods and writes in its own session', () => {
        expect(allowsRuntimePacket(scope, ['rpc-register', { method: 'session-one:permission' }])).toBe(true);
        expect(allowsRuntimePacket(scope, ['rpc-register', { method: 'machine-one:bash' }])).toBe(false);
        expect(allowsRuntimePacket(scope, ['message', { sid: 'session-other', message: 'payload' }])).toBe(false);
        expect(allowsRuntimePacket(scope, ['update-state', { sid: 'session-one' }])).toBe(true);
        expect(allowsRuntimePacket(scope, ['rpc-call', { method: 'session-other:abort' }])).toBe(false);
        expect(allowsRuntimePacket(scope, ['machine-alive', { machineId: 'machine-one' }])).toBe(false);
    });
    it('rejects path-shaped scope identifiers', () => {
        expect(parseRuntimeScope({ ...scope, sessionId: '../sessions' })).toBeNull();
        expect(parseRuntimeScope(scope)).toEqual(scope);
    });
});
