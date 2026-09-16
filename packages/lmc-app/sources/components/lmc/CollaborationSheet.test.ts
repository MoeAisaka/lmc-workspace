import { describe, expect, it } from 'vitest';
import { applyDutyPrefix, dutyPresetKeyFor, parseDutyPrefix, sanitizeDutyText, snapshotRole, stripDutyPrefix } from './collaborationDuty';

describe('duty prefix', () => {
    it('reads the bracketed duty off the front of a name', () => {
        expect(parseDutyPrefix('【评审】LMC')).toBe('评审');
        expect(parseDutyPrefix('LMC')).toBeNull();
    });

    it('strips the duty prefix, leaving the rest of the name untouched', () => {
        expect(stripDutyPrefix('【评审】LMC')).toBe('LMC');
        expect(stripDutyPrefix('LMC')).toBe('LMC');
    });

    it('applies a new duty over whatever prefix was already there', () => {
        expect(applyDutyPrefix('LMC', '评审')).toBe('【评审】LMC');
        expect(applyDutyPrefix('【编码】LMC', '评审')).toBe('【评审】LMC');
    });

    it('removes the prefix entirely when the duty clears', () => {
        expect(applyDutyPrefix('【评审】LMC', null)).toBe('LMC');
    });

    it('round-trips: applying then parsing recovers the same duty', () => {
        const named = applyDutyPrefix('MacMini', '回归部署');
        expect(parseDutyPrefix(named)).toBe('回归部署');
    });

    it('strips stray brackets out of a hand-typed duty so the prefix round-trips cleanly', () => {
        const named = applyDutyPrefix('LMC', '评审】注入');
        expect(named).toBe('【评审注入】LMC');
        expect(stripDutyPrefix(named)).toBe('LMC');
    });

    it('sanitizes a duty by dropping its own brackets and trimming', () => {
        expect(sanitizeDutyText('  评审】注入【  ')).toBe('评审注入');
    });

    it('ignores a duty that sanitizes down to nothing', () => {
        expect(applyDutyPrefix('LMC', '【】')).toBe('LMC');
    });
});

describe('dutyPresetKeyFor', () => {
    it('matches a preset by its text in any shipped language', () => {
        expect(dutyPresetKeyFor('评审')).toBe('dutyReview');
        expect(dutyPresetKeyFor('Review')).toBe('dutyReview');
        expect(dutyPresetKeyFor('编码')).toBe('dutyCoding');
        expect(dutyPresetKeyFor('Coding')).toBe('dutyCoding');
    });

    it('returns null for a duty that is not a preset in any language', () => {
        expect(dutyPresetKeyFor('心跳')).toBeNull();
    });
});

describe('snapshotRole', () => {
    it('captures a hub as its worker ids, for a later rebuild', () => {
        const snapshot = snapshotRole({ role: 'hub', workers: [{ sessionId: 'W1', boundAt: 1, by: 'manual' }, { sessionId: 'W2', boundAt: 2, by: 'auto' }] } as any);
        expect(snapshot).toEqual({ role: 'hub', workerIds: ['W1', 'W2'] });
    });

    it('captures a worker as the hub it reports to', () => {
        const snapshot = snapshotRole({ role: 'worker', hub: { sessionId: 'H', boundAt: 1, by: 'manual' } } as any);
        expect(snapshot).toEqual({ role: 'worker', hubId: 'H' });
    });

    it('captures an ordinary session as plain, with nothing to rebuild', () => {
        expect(snapshotRole(undefined)).toEqual({ role: 'plain' });
    });
});
