import { describe, it, expect, vi } from 'vitest';

vi.mock('./apiSocket', () => ({ apiSocket: { sessionRPC: vi.fn() } }));

import { apiSocket } from './apiSocket';
import { queueSteerState, sessionDequeue, sessionSetQueueMode, sessionSteerQueued, sessionSupportsTurnQueue, steerFailureKey } from './turnQueue';

describe('queueSteerState', () => {
    it('is enabled only on Codex — Claude keeps the button, dimmed', () => {
        expect(queueSteerState({ flavor: 'codex' } as any)).toBe('enabled');
        expect(queueSteerState({ flavor: 'claude' } as any)).toBe('disabled');
        expect(queueSteerState(null)).toBe('disabled');
    });
});

describe('steerFailureKey', () => {
    it('separates cannot-at-all from not-this-time, and never claims a resend', () => {
        expect(steerFailureKey('unsupported')).toBe('lmc.queue.steerUnavailable');
        expect(steerFailureKey('gone')).toBe('lmc.queue.steerTooLate');
        expect(steerFailureKey('unconfirmed')).toBe('lmc.queue.steerUnconfirmed');
        for (const reason of ['settings', 'attachments', 'command', 'refused', 'idle', undefined]) {
            expect(steerFailureKey(reason)).toBe('lmc.queue.steerNotNow');
        }
    });
});

describe('sessionSupportsTurnQueue', () => {
    it('reads the capability bit only', () => {
        expect(sessionSupportsTurnQueue({ sessionCapabilities: { turnQueue: true } } as any)).toBe(true);
        expect(sessionSupportsTurnQueue({ sessionCapabilities: { refresh: true } } as any)).toBe(false);
        expect(sessionSupportsTurnQueue(null)).toBe(false);
    });
});

describe('queue RPCs', () => {
    it('dequeue returns the CLI verdict', async () => {
        (apiSocket.sessionRPC as any).mockResolvedValueOnce({ removed: false });
        expect(await sessionDequeue('s', 'k')).toBe(false);
        expect(apiSocket.sessionRPC).toHaveBeenCalledWith('s', 'dequeue', { key: 'k' });
    });

    it('steer reports the runner verdict verbatim', async () => {
        (apiSocket.sessionRPC as any).mockResolvedValueOnce({ steered: false, reason: 'settings' });
        expect(await sessionSteerQueued('s', 'k')).toEqual({ steered: false, reason: 'settings' });
        expect(apiSocket.sessionRPC).toHaveBeenCalledWith('s', 'steer', { key: 'k' });
    });

    it('setQueueMode sends only queueMode and rejects a non-applied answer', async () => {
        (apiSocket.sessionRPC as any).mockResolvedValueOnce({ status: 'applied' });
        await sessionSetQueueMode('s', 'sequential');
        expect(apiSocket.sessionRPC).toHaveBeenCalledWith('s', 'configure-session', { queueMode: 'sequential' });
        (apiSocket.sessionRPC as any).mockResolvedValueOnce({ status: 'queued' });
        await expect(sessionSetQueueMode('s', 'batch')).rejects.toThrow();
    });
});
