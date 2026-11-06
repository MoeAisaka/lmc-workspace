import { describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { reconnectSocketIfIdle } from './reconnectSocket';

function socket(active: boolean, connected: boolean, readyState: string) {
    return { active, connected, io: { engine: { readyState } }, disconnect: vi.fn(), connect: vi.fn() };
}

describe('manual Socket.IO reconnection', () => {
    it.each(['opening', 'open', 'closing'])('does not overlap an active %s transport handshake', state => {
        const client = socket(true, false, state);
        expect(reconnectSocketIfIdle(client as unknown as Socket)).toBe(false);
        expect(client.connect).not.toHaveBeenCalled();
    });
    it('does not reconnect an established namespace', () => {
        const client = socket(true, true, 'open');
        expect(reconnectSocketIfIdle(client as unknown as Socket)).toBe(false);
        expect(client.disconnect).not.toHaveBeenCalled();
    });
    it('retries a closed transport even though namespace subscriptions remain active', () => {
        const client = socket(true, false, 'closed');
        expect(reconnectSocketIfIdle(client as unknown as Socket)).toBe(true);
        expect(client.connect).toHaveBeenCalledOnce();
    });
    it('retries a rejected namespace on a shared open transport', () => {
        const client = socket(false, false, 'open');
        expect(reconnectSocketIfIdle(client as unknown as Socket)).toBe(true);
        expect(client.connect).toHaveBeenCalledOnce();
    });
    it('clears stale connected state after a delayed handshake rejection before retrying', () => {
        const client = socket(false, true, 'closed');
        expect(reconnectSocketIfIdle(client as unknown as Socket)).toBe(true);
        expect(client.disconnect).toHaveBeenCalledOnce();
        expect(client.disconnect.mock.invocationCallOrder[0]).toBeLessThan(client.connect.mock.invocationCallOrder[0]);
    });
});
