import { describe, expect, it } from 'vitest';
import type { AgentState } from '../storageTypes';
import type { NormalizedMessage } from '../typesRaw';
import { createReducer, reducer } from './reducer';

const requestId = '18acf015-57ac-4f04-909d-5e3b845ea9e5';
const input = { questions: [{ question: '顶部放哪些指标？', header: '顶部看板', options: [{ label: '6 项' }], multiSelect: false }] };
const call = (id = 'toolu_question', at = 10_000): NormalizedMessage => ({
    id: `start-${id}`, localId: null, role: 'agent', createdAt: at, isSidechain: false,
    content: [{ type: 'tool-call', id, name: 'AskUserQuestion', input, description: null, uuid: `uuid-${id}`, parentUUID: null }],
});
const end: NormalizedMessage = {
    id: 'end', localId: null, role: 'agent', createdAt: 20_000, isSidechain: false,
    content: [{ type: 'tool-result', tool_use_id: 'toolu_question', content: null, is_error: false, uuid: 'end-uuid', parentUUID: null }],
};
const permission = (completed = false, patch = {}): AgentState => ({
    [completed ? 'completedRequests' : 'requests']: { [requestId]: {
        tool: 'AskUserQuestion', arguments: input, createdAt: 10_023,
        ...(completed ? { status: 'approved', completedAt: 20_000, answers: { '顶部放哪些指标？': '6 项' } } : {}), ...patch,
    } },
});

describe('native questions whose PermissionRequest has no provider tool id', () => {
    it.each(['together', 'permission-first', 'transcript-first'])('keeps one interactive card and the real approval id (%s)', order => {
        const state = createReducer();
        if (order === 'permission-first') reducer(state, [], permission());
        if (order === 'transcript-first') reducer(state, [call()]);
        reducer(state, order === 'transcript-first' ? [] : [call()], permission());
        const cards = [...state.messages.values()].filter(m => m.tool);
        expect(cards).toHaveLength(1);
        expect(cards[0].tool).toMatchObject({ callId: 'toolu_question', state: 'running', permission: { id: requestId, status: 'pending' } });
        reducer(state, [end], permission(true));
        expect([...state.messages.values()].filter(m => m.tool)).toHaveLength(1);
        expect(cards[0].tool).toMatchObject({ state: 'completed', permission: { id: requestId, status: 'approved' } });
    });

    it('rebuilds old answered history as one card with its answer receipt attached', () => {
        const state = createReducer();
        const result = reducer(state, [call(), end], permission(true));
        expect(result.messages.filter(m => m.kind === 'tool-call')).toHaveLength(1);
        expect([...state.messages.values()].find(m => m.tool)?.tool?.permission?.id).toBe(requestId);
    });

    it.each([
        { name: 'explicit different id', patch: { toolUseId: 'toolu_different' }, calls: [call()] },
        { name: 'different options', patch: { arguments: { questions: [{ ...input.questions[0], options: [{ label: '8 项' }] }] } }, calls: [call()] },
        { name: 'old identical question', patch: { createdAt: 60_000 }, calls: [call()] },
        { name: 'ambiguous repeated question', patch: {}, calls: [call(), call('toolu_second', 10_010)] },
    ])('does not guess a join for $name', ({ patch, calls }) => {
        const state = createReducer();
        reducer(state, calls, permission(false, patch));
        expect([...state.messages.values()].filter(m => m.tool)).toHaveLength(calls.length + 1);
    });
});
