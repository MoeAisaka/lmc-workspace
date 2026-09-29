import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '../typesRaw';
import type { AgentState } from '../storageTypes';
import { createReducer, reducer } from './reducer';

const question = { questions: [{ question: 'Q?', header: 'H', options: [{ label: 'A' }], multiSelect: false }] };
const completed = (id: string, createdAt: number): AgentState => ({
    completedRequests: { [id]: { tool: 'AskUserQuestion', arguments: question, createdAt, completedAt: createdAt + 10, status: 'approved' } },
} as AgentState);
const window: NormalizedMessage[] = [
    { id: 'm1', localId: null, createdAt: 5_000, role: 'user', content: { type: 'text', text: 'latest turn' }, isSidechain: false } as NormalizedMessage,
];

describe('completed requests outside the loaded window', () => {
    it('does not bring back a question whose tool call scrolled out of the window', () => {
        const state = createReducer();
        state.windowTruncated = true;
        reducer(state, window);
        const result = reducer(state, [], completed('toolu_old', 1_000));
        expect(result.messages.some((m) => m.kind === 'tool-call')).toBe(false);
    });

    it('still shows a completed request from inside the window that has no tool call', () => {
        const state = createReducer();
        state.windowTruncated = true;
        reducer(state, window);
        const result = reducer(state, [], completed('toolu_new', 6_000));
        expect(result.messages.filter((m) => m.kind === 'tool-call')).toHaveLength(1);
    });

    it('does not bring back old questions when agent state arrives before any message', () => {
        const state = createReducer();
        expect(reducer(state, [], completed('toolu_old', 1_000)).messages.filter((m) => m.kind === 'tool-call')).toHaveLength(0);
        // The first page of a fresh load is not marked truncated either.
        const result = reducer(state, window, completed('toolu_old', 1_000));
        expect(result.messages.some((m) => m.kind === 'tool-call')).toBe(false);
    });

    it('still shows a request from the loaded range once messages are known', () => {
        const state = createReducer();
        reducer(state, [], completed('toolu_new', 6_000));
        const result = reducer(state, window, completed('toolu_new', 6_000));
        expect(result.messages.filter((m) => m.kind === 'tool-call')).toHaveLength(1);
    });
});

describe('window rebuild', () => {
    it('does not append old answered questions after the window drops their tool calls', async () => {
        const { rebuildDerivedMessageWindow } = await import('../messageWindow');
        const rebuilt = rebuildDerivedMessageWindow(window, completed('toolu_old', 1_000));
        expect(rebuilt.messages.map((m) => m.kind)).toEqual(['user-text']);
    });
});
