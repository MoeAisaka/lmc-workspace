import { describe, expect, it } from 'vitest';
import { armPendingDuty, clearPendingDuty, isPendingDuty, PENDING_DUTY_MS, pruneExpired } from './pendingDuty';

describe('pendingDuty', () => {
    it('arms two different workers independently: neither arm clears the other', () => {
        let state = armPendingDuty(new Map(), 'W1', 0);
        state = armPendingDuty(state, 'W2', 100);
        expect(isPendingDuty(state, 'W1', 100)).toBe(true);
        expect(isPendingDuty(state, 'W2', 100)).toBe(true);
    });

    it('each worker expires on its own schedule', () => {
        let state = armPendingDuty(new Map(), 'W1', 0);
        state = armPendingDuty(state, 'W2', 3000);
        const justAfterW1Expires = PENDING_DUTY_MS + 1;
        expect(isPendingDuty(state, 'W1', justAfterW1Expires)).toBe(false);
        expect(isPendingDuty(state, 'W2', justAfterW1Expires)).toBe(true);
    });

    it('clearing one worker leaves the other untouched', () => {
        let state = armPendingDuty(new Map(), 'W1', 0);
        state = armPendingDuty(state, 'W2', 0);
        state = clearPendingDuty(state, 'W1');
        expect(state.has('W1')).toBe(false);
        expect(isPendingDuty(state, 'W2', 0)).toBe(true);
    });

    it('clearing a worker that was never armed is a no-op, not an error', () => {
        const state = armPendingDuty(new Map(), 'W1', 0);
        expect(clearPendingDuty(state, 'GHOST')).toBe(state);
    });

    it('re-arming one worker resets only its own timer', () => {
        let state = armPendingDuty(new Map(), 'W1', 0);
        state = armPendingDuty(state, 'W2', 0);
        state = armPendingDuty(state, 'W1', 1000);
        // W1, re-armed at t=1000, still has time left after W2 (armed at t=0) expires.
        expect(isPendingDuty(state, 'W2', PENDING_DUTY_MS + 1)).toBe(false);
        expect(isPendingDuty(state, 'W1', PENDING_DUTY_MS + 1)).toBe(true);
        expect(isPendingDuty(state, 'W1', 1000 + PENDING_DUTY_MS + 1)).toBe(false);
    });

    it('pruneExpired drops only what has timed out, and returns the same reference when nothing did', () => {
        let state = armPendingDuty(new Map(), 'W1', 0);
        state = armPendingDuty(state, 'W2', 0);
        const untouched = pruneExpired(state, 100);
        expect(untouched).toBe(state);
        const pruned = pruneExpired(state, PENDING_DUTY_MS + 1);
        expect(pruned.has('W1')).toBe(false);
        expect(pruned.has('W2')).toBe(false);
    });

    it('pruneExpired keeps a worker whose own window has not closed yet, even if another has', () => {
        let state = armPendingDuty(new Map(), 'W1', 0);
        state = armPendingDuty(state, 'W2', 3000);
        const pruned = pruneExpired(state, PENDING_DUTY_MS + 1);
        expect(pruned.has('W1')).toBe(false);
        expect(pruned.has('W2')).toBe(true);
    });
});
