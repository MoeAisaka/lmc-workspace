import { describe, it, expect } from 'vitest';
import { assertSessionOwnerAvailable } from './sessionOwnership';

describe('session ownership before registration or metadata writes', () => {
    const owners = [{ happySessionId: 'existing', pid: 10 }, { happySessionId: 'other', pid: 20 }];
    it('rejects another live PID on the same session, including a terminal child', () => {
        expect(() => assertSessionOwnerAvailable('existing', 11, owners, () => true)).toThrow(/already owned/);
    });
    it('allows the current owner to report again', () => {
        expect(() => assertSessionOwnerAvailable('existing', 10, owners, () => true)).not.toThrow();
    });
    it('allows replacement only after the previous runner exits', () => {
        expect(() => assertSessionOwnerAvailable('existing', 11, owners, pid => pid !== 10)).not.toThrow();
    });
    it('does not block independent sessions', () => {
        expect(() => assertSessionOwnerAvailable('new', 11, owners, () => true)).not.toThrow();
    });
    it('checks all registered owners even when the reporting PID is also present', () => {
        expect(() => assertSessionOwnerAvailable('existing', 11, [...owners, { happySessionId: 'existing', pid: 11 }], () => true)).toThrow(/already owned/);
    });
});
