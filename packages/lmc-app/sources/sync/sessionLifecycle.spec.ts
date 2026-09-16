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
    it('supports top-level session envelopes and legacy main events', () => {
        expect(resolveSessionLifecycle(undefined, { role: 'session', content: { turn: 'B', ev: { t: 'turn-start' } } }, 20)).toEqual({ seq: 20, turnId: 'B', thinking: true });
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
