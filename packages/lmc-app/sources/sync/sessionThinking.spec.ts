import { describe, it, expect } from 'vitest';
import { resolveThinking } from './sessionThinking';

const facet = (active: boolean, thinking: boolean, thinkingAt: number) => ({ active, thinking, thinkingAt });

describe('resolveThinking', () => {
    it('accepts the first sighting of a session', () => {
        expect(resolveThinking(undefined, facet(true, true, 1000)))
            .toEqual({ thinking: true, thinkingAt: 1000, stale: false });
    });

    it('accepts an update that moves forward', () => {
        expect(resolveThinking(facet(true, true, 1000), facet(true, false, 2000)))
            .toEqual({ thinking: false, thinkingAt: 2000, stale: false });
    });

    it('accepts an update at the same timestamp', () => {
        // The task_started / task_complete message path flips the flag while
        // carrying the stored thinkingAt forward — it must not be rejected.
        expect(resolveThinking(facet(true, false, 1000), facet(true, true, 1000)))
            .toEqual({ thinking: true, thinkingAt: 1000, stale: false });
    });

    it('rejects an update that would walk the flag backwards', () => {
        expect(resolveThinking(facet(true, true, 2000), facet(true, false, 1000)))
            .toEqual({ thinking: true, thinkingAt: 2000, stale: true });
    });

    it('accepts a disconnect stamped with an older timestamp', () => {
        // presence/timeout.ts announces a disconnect using the session's LAST
        // active time, which is older than what we hold.
        expect(resolveThinking(facet(true, true, 2000), facet(false, false, 1000)))
            .toEqual({ thinking: false, thinkingAt: 1000, stale: false });
    });

    it('accepts a reconnect stamped with an older timestamp', () => {
        expect(resolveThinking(facet(false, false, 2000), facet(true, true, 1000)))
            .toEqual({ thinking: true, thinkingAt: 1000, stale: false });
    });

    it('lets a refetch clear an inactive session that can never clear itself', () => {
        // fetchSessions sends { thinking: false, thinkingAt: 0 } for a session
        // the server reports as inactive.
        expect(resolveThinking(facet(true, true, 5000), facet(false, false, 0)))
            .toEqual({ thinking: false, thinkingAt: 0, stale: false });
    });
});
