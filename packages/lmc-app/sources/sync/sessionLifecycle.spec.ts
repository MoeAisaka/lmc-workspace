import { describe, expect, it } from 'vitest';
import { resolveSessionLifecycle, resolveFetchedSessionLifecycle } from './sessionLifecycle';

const event = (t: string, turn = 'A', extra = {}) => ({ role: 'agent', content: { type: 'session', data: { turn, ev: { t }, ...extra } } });
describe('session lifecycle ownership', () => {
    const running = { seq: 10, turnId: 'A', thinking: true };
    it('starts and completes the matching main turn', () => {
        const start = resolveSessionLifecycle(undefined, event('turn-start'), 10);
        expect(start).toEqual(running);
        expect(resolveSessionLifecycle(start, event('turn-end'), 11)?.thinking).toBe(false);
    });
    it('does not finish the main turn when a subagent finishes', () => {
        expect(resolveSessionLifecycle(running, event('turn-end', 'child', { subagent: 'worker' }), 11)).toBe(running);
    });
    it('ignores legacy sidechain completion', () => {
        for (const extra of [{ subagent: 'worker' }, { parent_call_id: 'call' }, { isSidechain: true }]) {
            expect(resolveSessionLifecycle(running, { role: 'agent', content: { type: 'codex', data: { type: 'task_complete', turn_id: 'A', ...extra } } }, 11)).toBe(running);
        }
    });
    it('ignores stale and duplicate lifecycle messages', () => {
        expect(resolveSessionLifecycle(running, event('turn-end'), 9)).toBe(running);
        expect(resolveSessionLifecycle(running, event('turn-end'), 10)).toBe(running);
        expect(resolveSessionLifecycle(undefined, event('turn-start'), 9, 10)).toBeUndefined();
    });
    it('ignores delayed completion of a different turn', () => {
        expect(resolveSessionLifecycle(running, event('turn-end', 'old'), 11)).toBe(running);
    });
    it('supports top-level session envelopes, wrapped session-role envelopes, and legacy main events', () => {
        expect(resolveSessionLifecycle(undefined, { role: 'session', content: { turn: 'B', ev: { t: 'turn-start' } } }, 20)).toEqual({ seq: 20, turnId: 'B', thinking: true });
        expect(resolveSessionLifecycle(undefined, {
            role: 'session',
            content: { type: 'session', data: { id: 'e1', role: 'agent', time: 5000, turn: 'W', ev: { t: 'turn-start' } } },
        }, 21)).toEqual({
            seq: 21,
            turnId: 'W',
            thinking: true,
            timing: { startedAt: 5000, endedAt: null, startSeq: 21, approximate: false, status: 'running' },
        });
        expect(resolveSessionLifecycle(running, { role: 'agent', content: { type: 'codex', data: { type: 'turn_aborted', turn_id: 'A' } } }, 11)?.thinking).toBe(false);
    });
    it('does not infer completion from text, tool output, or user replies', () => {
        expect(resolveSessionLifecycle(running, event('text'), 11)).toBe(running);
        expect(resolveSessionLifecycle(running, { role: 'user', content: { type: 'text', text: 'continue' } }, 12)).toBe(running);
    });
    it('does not accept an anonymous completion while an identified turn owns work', () => {
        expect(resolveSessionLifecycle(running, { role: 'agent', content: { type: 'codex', data: { type: 'task_complete' } } }, 11)).toBe(running);
    });
});


describe('fetched session lifecycle ownership', () => {
    const a = { seq: 10, turnId: 'A', thinking: true };
    const missed = [
        { seq: 13, raw: event('turn-start', 'B') },
        { seq: 11, raw: event('turn-end', 'A') },
        { seq: 12, raw: event('text', 'A') },
    ];
    it('repairs ownership after reconnect so the new turn can complete', () => {
        const b = resolveFetchedSessionLifecycle(a, missed, 'newest', 10);
        expect(b).toEqual({ seq: 13, turnId: 'B', thinking: true });
        expect(resolveSessionLifecycle(b, event('turn-end', 'B'), 14, 13)?.thinking).toBe(false);
        expect(missed.map(message => message.seq)).toEqual([13, 11, 12]);
    });
    it('does not let older-page history alter ownership', () => {
        expect(resolveFetchedSessionLifecycle(a, missed, 'older', 0)).toBe(a);
    });
    it('seeds an active turn-start from an older page when the initial newest page had only tool calls', () => {
        const seeded = resolveFetchedSessionLifecycle(undefined, [
            { seq: 171497, raw: { role: 'session', content: { time: 1000, turn: 'prev', ev: { t: 'turn-end', status: 'completed' } } } },
            { seq: 171500, raw: { role: 'session', content: { time: 2000, turn: 'active', ev: { t: 'turn-start' } } } },
        ], 'older', 171942);
        expect(seeded).toEqual({
            seq: 171500,
            turnId: 'active',
            thinking: true,
            timing: {
                startedAt: 2000,
                endedAt: null,
                startSeq: 171500,
                approximate: false,
                status: 'running',
            },
        });
        // Do not seed a completed older turn when no active turn-start was in the page.
        expect(resolveFetchedSessionLifecycle(undefined, [
            { seq: 171497, raw: { role: 'session', content: { time: 1000, turn: 'prev', ev: { t: 'turn-end', status: 'completed' } } } },
        ], 'older', 171942)).toBeUndefined();
    });
    it('backfills startedAt from an older page when the initial newest page only saw turn-end of a long turn', () => {
        const endOnly = resolveFetchedSessionLifecycle(undefined, [
            { seq: 500, raw: { role: 'session', content: { time: 9000, turn: 'long', ev: { t: 'turn-end', status: 'completed' } } } },
        ], 'newest', 0);
        expect(endOnly?.timing).toMatchObject({ startedAt: null, endedAt: 9000, status: 'completed' });
        const backfilled = resolveFetchedSessionLifecycle(endOnly, [
            { seq: 120, raw: { role: 'session', content: { time: 3000, turn: 'long', ev: { t: 'turn-start' } } } },
        ], 'older', 500);
        expect(backfilled).toEqual({
            seq: 500,
            turnId: 'long',
            thinking: false,
            timing: {
                startedAt: 3000,
                endedAt: 9000,
                startSeq: 120,
                approximate: false,
                status: 'completed',
            },
        });
    });
    it('does not overwrite a newer realtime owner while decryption was pending', () => {
        const c = { seq: 20, turnId: 'C', thinking: true };
        expect(resolveFetchedSessionLifecycle(c, missed, 'newest', 10)).toBe(c);
    });
    it('keeps the pre-fetch watermark and ignores sidechains', () => {
        expect(resolveFetchedSessionLifecycle(a, [
            { seq: 9, raw: event('turn-start', 'old') },
            { seq: 11, raw: event('turn-end', 'A', { subagent: 'child' }) },
        ], 'newest', 10)).toBe(a);
    });
});
