import { describe, expect, it } from 'vitest';
import { refreshProgress, refreshWaitReason } from './sessionRefreshProgress';
describe('session refresh progress', () => {
    it('keeps queued work pending even when the current turn is long', () => {
        expect(refreshProgress({ sessionConfigState: 'queued', sessionConfigUpdatedAt: 1000 }, 301000)).toMatchObject({ pending: true, stalled: false, visible: true });
    });
    it('turns an unconfirmed restart or verification into a recoverable stall', () => {
        for (const state of ['refreshing', 'verifying'] as const) {
            expect(refreshProgress({ sessionConfigState: state, sessionConfigUpdatedAt: 1000 }, 92000)).toMatchObject({ pending: false, slow: false, stalled: true, visible: true });
        }
    });
    it('still reports a slow restart while it remains inside the handoff deadline', () => {
        expect(refreshProgress({ sessionConfigState: 'refreshing', sessionConfigUpdatedAt: 1000 }, 61000)).toMatchObject({ pending: true, slow: true, stalled: false });
    });
    it('briefly shows a server-confirmed completion and retains failures', () => {
        expect(refreshProgress({sessionConfigState:'applied',sessionConfigUpdatedAt:1000}, 2000).visible).toBe(true);
        expect(refreshProgress({sessionConfigState:'applied',sessionConfigUpdatedAt:1000}, 12000).visible).toBe(false);
        expect(refreshProgress({sessionConfigState:'error'}, 12000).visible).toBe(true);
    });
    it('does not invent completion times for legacy sessions', () => {
        expect(refreshProgress({sessionConfigState:'applied'}, Date.now()).visible).toBe(false);
        expect(refreshProgress({sessionConfigState:'refreshing'}, Date.now())).toMatchObject({pending:true,slow:false,stalled:false});
    });
});

describe('refreshWaitReason', () => {
    it('names the permission request first: it is the only one waiting on a person', () => {
        expect(refreshWaitReason({ thinking: true, agentState: { requests: { a: {} } } })).toBe('permission');
    });

    it('names the turn when the agent is simply working', () => {
        expect(refreshWaitReason({ thinking: true, agentState: { requests: {} } })).toBe('thinking');
    });

    it('falls back to the queue when nothing else is in the way', () => {
        expect(refreshWaitReason({ thinking: false })).toBe('queue');
        expect(refreshWaitReason({})).toBe('queue');
    });
});
