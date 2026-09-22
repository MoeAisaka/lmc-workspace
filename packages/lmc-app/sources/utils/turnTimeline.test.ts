import { describe, expect, it } from 'vitest';
import type { Message, ToolCall, ToolCallMessage } from '@/sync/typesMessage';
import { buildTurnTimeline, getToolTiming, isCurrentTurnMessage, isTimelineExpanded, selectTimelineItems } from './turnTimeline';

function tool(id: string, start: number | null, end: number | null, extra: Partial<ToolCall> = {}): ToolCallMessage {
    return { kind: 'tool-call', id, localId: null, createdAt: start ?? 1000, children: [], tool: {
        name: 'Bash', state: end === null ? 'running' : 'completed', input: {}, description: null,
        createdAt: start ?? 1000, startedAt: start, completedAt: end, ...extra,
    } };
}

describe('per-turn timeline', () => {
    it.each(['Bash', 'exec_command'])('groups measured %s overlap by elapsed wall time, not summed duration', name => {
        const result = buildTurnTimeline([tool('second', 3000, 8000, { name }), tool('first', 1000, 10000, { name })], 1000, false, 10000);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ type: 'parallel', durationMs: 9000, offsetMs: 0, steps: [{ id: 'first' }, { id: 'second' }] });
    });
    it('keeps adjacent serial calls separate and keeps zero-duration records', () => {
        const result = buildTurnTimeline([tool('third', 4000, 4000), tool('second', 2000, 4000), tool('first', 1000, 2000)], 1000, false, 4000);
        expect(result.map(x => x.type)).toEqual(['step', 'step', 'step']);
        expect(result[2]).toMatchObject({ durationMs: 0 });
    });
    it('uses the union of transitively overlapping intervals', () => {
        const result = buildTurnTimeline([tool('c', 4000, 7000), tool('b', 2000, 5000), tool('a', 1000, 3000)], 0, false, 7000);
        expect(result[0]).toMatchObject({ type: 'parallel', durationMs: 6000 });
    });
    it('does not invent concurrency or duration for missing or invalid timestamps', () => {
        const result = buildTurnTimeline([tool('b', null, 5000), tool('a', 1000, 6000)], 1000, false, 9000);
        expect(result.map(x => x.type)).toEqual(['step', 'step']);
        expect(result[1]).toMatchObject({ durationMs: null, offsetMs: null });
        expect(getToolTiming(tool('bad', 5000, 3000).tool, false, 9000).durationMs).toBeNull();
        expect(getToolTiming(tool('nan', NaN, 3000).tool, false, 9000).durationMs).toBeNull();
    });
    it('ticks active steps, freezes completed ones and never revives historical running flags', () => {
        const running = tool('run', 1000, null).tool;
        expect(getToolTiming(running, true, 5000)).toMatchObject({ status: 'running', durationMs: 4000 });
        expect(getToolTiming(running, false, 500000)).toMatchObject({ status: 'unknown', durationMs: null });
        expect(getToolTiming(tool('done', 1000, 2000).tool, false, 500000).durationMs).toBe(1000);
    });
    it('keeps pending approval outside parallel execution and preserves denied/canceled/error states', () => {
        const pending = tool('wait', null, null, { permission: { id: 'p', status: 'pending' } });
        const result = buildTurnTimeline([pending, tool('run', 1000, null)], 1000, true, 5000);
        expect(result.map(x => x.type)).toEqual(['step', 'step']);
        expect(result[1]).toMatchObject({ status: 'waiting', durationMs: 4000 });
        for (const status of ['denied', 'canceled'] as const) {
            expect(getToolTiming(tool('x', null, null, { permission: { id: 'p', status } }).tool, true, 5000).status).toBe('stopped');
        }
        expect(getToolTiming(tool('error', 1000, 2000, { state: 'error' }).tool, false, 5000).status).toBe('error');
    });
    it('preserves progress text and does not count nested subagent tools twice', () => {
        const parent = tool('task', 1000, 5000); parent.children = [tool('child', 2000, 3000)];
        const progress: Message = { kind: 'agent-text', id: 'text', createdAt: 6000, localId: null, text: 'Checking' };
        expect(buildTurnTimeline([progress, parent], 1000, false, 6000).map(x => x.id)).toEqual(['task', 'text']);
    });
    it('does not animate a previous turn when the session starts a new one', () => {
        const user: Message = { kind: 'user-text', id: 'user', localId: null, createdAt: 2000, text: 'next' };
        const messages = [tool('new', 3000, null), user, tool('old', 1000, null)];
        expect(isCurrentTurnMessage(messages, 'new')).toBe(true);
        expect(isCurrentTurnMessage(messages, 'old')).toBe(false);
    });
});

describe('D24 process visibility', () => {
    it('defaults to expanded regardless of lifecycle and preserves explicit choices', () => {
        expect(isTimelineExpanded()).toBe(true);
        expect(isTimelineExpanded(undefined)).toBe(true);
        expect(isTimelineExpanded(true)).toBe(true);
        expect(isTimelineExpanded(false)).toBe(false);
    });
    it.each(['Bash', 'exec_command'])('shows recent work plus earlier active %s calls and preserves prose', name => {
        const progress: Message = { kind: 'agent-text', id: 'prose', createdAt: 2500, localId: null, text: 'Status update' };
        const messages = [tool('e', 5000, 6000), tool('d', 4000, 5000), tool('c', 3000, 4000), progress, tool('b', 2000, 3000), tool('a', 1000, null, { name })];
        const all = buildTurnTimeline(messages, 1000, true, 7000);
        const recent = selectTimelineItems(all, true, true, false);
        expect(recent.hiddenCount).toBe(1);
        expect(JSON.stringify(recent.items)).toContain('Status update');
        expect(recent.items[0]).toMatchObject({ id: 'a' });
        expect(selectTimelineItems(all, true, true, true).hiddenCount).toBe(0);
    });
    it('folds only successful steps, keeps failures, approvals, unknown completion and commentary', () => {
        const prose: Message = { kind: 'agent-text', id: 'text', createdAt: 4000, localId: null, text: 'Still visible' };
        const items = buildTurnTimeline([prose, tool('unknown', 3000, null), tool('wait', null, null, { permission: { id: 'p', status: 'pending' } }), tool('err', 2000, 3000, { state: 'error' }), tool('ok', 1000, 2000)], 1000, false, 5000);
        const folded = selectTimelineItems(items, false, false, false);
        expect(folded.hiddenCount).toBe(1);
        expect(folded.items.map(item => item.id)).toEqual(['err', 'wait', 'unknown', 'text']);
        expect(folded.items[1]).toMatchObject({ status: 'waiting' });
    });
});
