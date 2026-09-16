import {it,expect} from 'vitest';
import {resolveSessionState} from './sessionState';

it('restores working state from durable runtime state after browser reconnect', () => {
    expect(resolveSessionState({ isOnline: true, thinking: false, agentState: { runtime: { phase: 'working', pid: 123, updatedAt: 10 } } as any })).toBe('thinking');
});
