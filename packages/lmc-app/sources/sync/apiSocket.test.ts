import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ io: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: mocks.io }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, AppState: { currentState: 'active' } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: 'test' } } }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: {} }));
vi.mock('./storage', () => ({ storage: { getState: () => ({ localSettings: {} }) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/lmc/serverErrorText', () => ({ translateLmcServerMessage: (value: string) => value }));

import { apiSocket } from './apiSocket';
import type { Encryption } from './encryption/encryption';

class TestSocket extends EventEmitter {
    active = false;
    connected = false;
    recovered = false;
    connect = vi.fn(() => { this.active = true; return this; });
    disconnect = vi.fn(() => { this.active = false; this.connected = false; return this; });
    onAny = vi.fn();
    reject() { this.active = false; this.emit('connect_error', new Error('Scope verification unavailable')); }
    accept() { this.active = true; this.connected = true; this.emit('connect'); }
}

let socket: TestSocket;
beforeEach(() => {
    vi.useFakeTimers();
    socket = new TestSocket();
    mocks.io.mockReset().mockReturnValue(socket);
    apiSocket.initialize({ endpoint: 'https://sync.example.test', token: 'synthetic-token' }, {} as Encryption);
});
afterEach(() => { apiSocket.disconnect(); vi.useRealTimers(); });

describe('socket recovery after a rejected handshake', () => {
    it('retries a middleware denial and notifies consumers when access recovers', () => {
        const reconnected = vi.fn();
        const unsubscribe = apiSocket.onReconnected(reconnected);
        try {
            socket.reject();
            vi.advanceTimersByTime(1_000);
            expect(socket.connect).toHaveBeenCalledTimes(1);
            socket.reject();
            vi.advanceTimersByTime(2_000);
            expect(socket.connect).toHaveBeenCalledTimes(2);
            socket.accept();
            expect(reconnected).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(60_000);
            expect(socket.connect).toHaveBeenCalledTimes(2);
        } finally { unsubscribe(); }
    });

    it('leaves ordinary transport reconnects to Socket.IO', () => {
        socket.active = true;
        socket.emit('connect_error', new Error('websocket error'));
        vi.advanceTimersByTime(60_000);
        expect(socket.connect).not.toHaveBeenCalled();
    });

    it('cancels pending recovery on explicit disconnect', () => {
        socket.reject();
        apiSocket.disconnect();
        socket.reject(); // A late event from the retired connection must be ignored.
        vi.advanceTimersByTime(60_000);
        expect(socket.connect).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not let an old socket retry or change status after a token replacement', () => {
        socket.reject();
        const replacement = new TestSocket();
        mocks.io.mockReturnValue(replacement);
        apiSocket.updateToken('new-synthetic-token');
        replacement.accept();
        const statuses: string[] = [];
        const unsubscribe = apiSocket.onStatusChange(status => statuses.push(status));
        try {
            socket.reject();
            vi.advanceTimersByTime(60_000);
            expect(statuses).toEqual(['connected']);
            expect(socket.connect).not.toHaveBeenCalled();
            expect(replacement.connect).not.toHaveBeenCalled();
            const callback = mocks.io.mock.calls[1][1].auth;
            callback((auth: { token: string }) => expect(auth.token).toBe('new-synthetic-token'));
        } finally { unsubscribe(); }
    });

    it('backs off repeated denials, caps the delay and resets it after recovery', () => {
        for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
            const attempts = socket.connect.mock.calls.length;
            socket.reject();
            socket.reject(); // One pending retry per connection.
            vi.advanceTimersByTime(delay - 1);
            expect(socket.connect).toHaveBeenCalledTimes(attempts);
            vi.advanceTimersByTime(1);
            expect(socket.connect).toHaveBeenCalledTimes(attempts + 1);
        }
        socket.accept();
        socket.connected = false;
        socket.reject();
        vi.advanceTimersByTime(1_000);
        expect(socket.connect).toHaveBeenCalledTimes(8);
    });
});
