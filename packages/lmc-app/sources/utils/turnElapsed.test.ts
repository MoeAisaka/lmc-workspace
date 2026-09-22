import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { resolveTurnElapsed } from './turnElapsed';
import { resolveSessionLifecycle, resolveFetchedSessionLifecycle } from '@/sync/sessionLifecycle';
const user = (at = 1000): Message => ({ kind: 'user-text', id: 'user', localId: null, text: 'go', createdAt: at });
const text = (at: number): Message => ({ kind: 'agent-text', id: 'answer', localId: null, text: 'done', createdAt: at });
const tool = (name: string, start = 2000, end: number | null = 6000): Message => ({ kind: 'tool-call', id: name, localId: null, createdAt: start, children: [], tool: {
    name, input: {}, description: null, state: end ? 'completed' : 'running', createdAt: start, startedAt: start, completedAt: end,
} });
const event = (t: string, time: number, turn = 'A', extra = {}) => ({ role: 'session', content: { time, turn, ev: { t, status: 'completed', ...extra } } });

describe('D22 latest-turn elapsed', () => {
    it.each(['Bash', 'exec_command'])('%s: excludes queue time and counts overlapping tools only once', name => {
        const start = resolveSessionLifecycle(undefined, event('turn-start', 2000), 2);
        const end = resolveSessionLifecycle(start, event('turn-end', 10000), 6);
        const messages = [user(11000), text(9500), tool(name, 3000, 9000), tool('parallel', 2000, 8000), user(1000)];
        expect(resolveTurnElapsed(messages, start, true)).toMatchObject({ startedAt: 2000, endedAt: null, approximate: false, status: 'running' });
        expect(resolveTurnElapsed(messages, end, false)).toMatchObject({ startedAt: 2000, endedAt: 10000, approximate: false, status: 'completed' });
    });
    it.each(['cancelled', 'failed'])('freezes an authoritative %s boundary without a final answer', status => {
        const start = resolveSessionLifecycle(undefined, event('turn-start', 2000), 2);
        const end = resolveSessionLifecycle(start, event('turn-end', 10000, 'A', { status }), 4);
        expect(resolveTurnElapsed([], end, false)).toMatchObject({ startedAt: 2000, endedAt: 10000, status: status === 'cancelled' ? 'stopped' : 'error' });
    });
    it('reconstructs the same total after reload and ignores older-page history', () => {
        const lifecycle = resolveFetchedSessionLifecycle(undefined, [
            { seq: 6, raw: event('turn-end', 10000) }, { seq: 2, raw: event('turn-start', 2000) },
        ], 'newest');
        expect(resolveTurnElapsed([], lifecycle, false)).toMatchObject({ startedAt: 2000, endedAt: 10000 });
        expect(resolveFetchedSessionLifecycle(lifecycle, [{ seq: 1, raw: event('turn-start', 1, 'old') }], 'older')).toBe(lifecycle);
    });
    it('does not restart on duplicate starts, queued prompts, or subagent events', () => {
        const start = resolveSessionLifecycle(undefined, event('turn-start', 2000), 2);
        const duplicate = resolveSessionLifecycle(start, event('turn-start', 3000), 3);
        expect(duplicate?.timing?.startedAt).toBe(2000);
        const child = event('turn-end', 5000, 'child');
        expect(resolveSessionLifecycle(duplicate, { ...child, content: { ...child.content, subagent: 'worker' } }, 4)).toBe(duplicate);
        expect(resolveTurnElapsed([user(9000)], duplicate, true)?.startedAt).toBe(2000);
    });
    it('uses received timestamps only as an estimate for legacy Codex', () => {
        const raw = (type: string) => ({ role: 'agent', content: { type: 'codex', data: { type, turn_id: 'A' } } });
        const start = resolveSessionLifecycle(undefined, raw('task_started'), 2, 0, 2000);
        const end = resolveSessionLifecycle(start, raw('task_complete'), 3, 0, 8000);
        expect(resolveTurnElapsed([], end, false)).toMatchObject({ startedAt: 2000, endedAt: 8000, approximate: true });
    });
    it('does not invent a missing start or resurrect a stale running clock', () => {
        const end = resolveSessionLifecycle(undefined, event('turn-end', 10000), 6);
        expect(resolveTurnElapsed([], end, false)?.startedAt).toBeNull();
        const start = resolveSessionLifecycle(undefined, event('turn-start', 2000), 2);
        expect(resolveTurnElapsed([], start, false)?.startedAt).toBeNull();
        expect(resolveTurnElapsed([tool('old', 2000, null), user()], undefined, false)?.endedAt).not.toBeNull();
    });
    it('marks bounded legacy totals as estimates and refuses replayed mixed clocks', () => {
        expect(resolveTurnElapsed([text(9000), tool('Bash'), user()], undefined, false)).toMatchObject({ startedAt: 2000, endedAt: 9000, approximate: true });
        const replay = tool('exec_command', 7888 * 60000, 7888 * 60000 + 5000); replay.createdAt = 2000;
        expect(resolveTurnElapsed([text(9000), replay, user()], undefined, false)?.startedAt).toBeNull();
        expect(resolveTurnElapsed([tool('Bash')], undefined, false)?.startedAt).toBeNull();
        expect(resolveTurnElapsed([user()], undefined, false)).toBeNull();
    });
    it('does not carry a completed timer into a newly active turn', () => {
        const start = resolveSessionLifecycle(undefined, event('turn-start', 2000), 2);
        const end = resolveSessionLifecycle(start, event('turn-end', 10000), 6);
        expect(resolveTurnElapsed([], end, true)?.startedAt).toBeNull();
        const next = resolveSessionLifecycle(end, event('turn-start', 12000, 'B'), 8);
        expect(resolveTurnElapsed([], next, true)?.startedAt).toBe(12000);
    });
    it('keeps the frozen total when an identified completion is repeated', () => {
        const start = resolveSessionLifecycle(undefined, event('turn-start', 2000), 2);
        const end = resolveSessionLifecycle(start, event('turn-end', 10000), 6);
        const duplicate = resolveSessionLifecycle(end, event('turn-end', 15000), 7);
        expect(resolveTurnElapsed([], duplicate, false)).toMatchObject({ startedAt: 2000, endedAt: 10000 });
    });
    it('rejects negative or invalid boundary durations', () => {
        const start = resolveSessionLifecycle(undefined, event('turn-start', 9000), 2);
        const end = resolveSessionLifecycle(start, event('turn-end', 1000), 6);
        expect(resolveTurnElapsed([], end, false)?.startedAt).toBeNull();
        expect(resolveTurnElapsed([text(NaN), user()], undefined, false)?.startedAt).toBeNull();
    });
});
