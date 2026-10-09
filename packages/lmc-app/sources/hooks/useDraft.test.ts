// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    sessions: {} as Record<string, { draft?: string | null }>,
    save: vi.fn(),
    appState: null as null | ((state: string) => void),
}));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ sessions: state.sessions, updateSessionDraft: state.save }) } }));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
vi.mock('react-native', () => ({ AppState: { addEventListener: (_: string, listener: (state: string) => void) => {
    state.appState = listener;
    return { remove: () => { if (state.appState === listener) state.appState = null; } };
} } }));
import { useDraft } from './useDraft';

describe('composer draft lifecycle', () => {
    let root: Root;
    let clear: () => void;
    const onChange = vi.fn();
    function Probe({ value, sessionId = 'one' }: { value: string; sessionId?: string }) {
        clear = useDraft(sessionId, value, onChange).clearDraft;
        return null;
    }
    const render = (value: string, sessionId = 'one') => act(() => root.render(createElement(Probe, { value, sessionId })));
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        state.sessions = { one: {}, two: {} };
        state.save.mockReset();
        onChange.mockReset();
        root = createRoot(document.createElement('div'));
    });
    afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });

    it('saves the empty/nonempty transition once, then debounces typing instead of saving on every render cleanup', () => {
        render(''); render('a');
        expect(state.save.mock.calls).toEqual([['one', 'a']]);
        for (const text of ['ab', 'abc', 'abcd', 'abcde']) { render(text); act(() => vi.advanceTimersByTime(100)); }
        expect(state.save.mock.calls).toEqual([['one', 'a']]);
        act(() => vi.advanceTimersByTime(2000));
        expect(state.save.mock.calls).toEqual([['one', 'a'], ['one', 'abcde']]);
    });
    it('flushes the latest text on unmount and cancels its pending timer', () => {
        render('a'); render('latest'); state.save.mockClear();
        act(() => root.unmount());
        expect(state.save.mock.calls).toEqual([['one', 'latest']]);
        act(() => vi.runAllTimers());
        expect(state.save).toHaveBeenCalledTimes(1);
    });
    it('flushes the latest text when the app becomes inactive without repeating a saved value', () => {
        render('a'); render('latest'); state.save.mockClear();
        act(() => { state.appState?.('inactive'); state.appState?.('background'); });
        expect(state.save.mock.calls).toEqual([['one', 'latest']]);
    });
    it('does not resurrect a sent draft when cleared immediately before unmount', () => {
        render('pending'); state.save.mockClear();
        act(() => clear()); act(() => root.unmount());
        expect(state.save.mock.calls).toEqual([['one', null]]);
    });
    it('flushes the old session to its own id when switching to another session', () => {
        render('first'); render('first edited'); state.save.mockClear();
        render('second', 'two');
        expect(state.save.mock.calls.filter(call => call[0] === 'one')).toEqual([['one', 'first edited']]);
    });
});
