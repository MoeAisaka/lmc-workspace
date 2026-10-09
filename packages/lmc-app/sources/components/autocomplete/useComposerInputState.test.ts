// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useComposerInputState } from './useComposerInputState';
import { applySuggestion } from './applySuggestion';

describe('composer autocomplete render isolation', () => {
    let root: Root;
    let current: ReturnType<typeof useComposerInputState>;
    let renders: number;
    const prefixes = ['@', '/'];
    function Probe({ allowed = prefixes }: { allowed?: string[] }) {
        renders++;
        current = useComposerInputState('', allowed);
        return null;
    }
    const input = (text: string, start = text.length, end = start) => act(() => {
        current.handleInputStateChange({ text, selection: { start, end } });
    });
    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        root = createRoot(document.createElement('div')); renders = 0;
        act(() => root.render(createElement(Probe)));
    });
    afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
    it('retains each live text/caret without rendering for ordinary input and select events', () => {
        const before = renders;
        for (const text of ['你', '你好', '你好世界', 'hello world']) {
            input(text); input(text);
            expect(current.inputState.current.text).toBe(text);
        }
        input('hello world', 3);
        expect(current.inputState.current.selection.start).toBe(3);
        expect(current.activeWord).toBe(null);
        expect(renders).toBe(before);
    });
    it('updates the query only when needed while insertion uses the latest offset', () => {
        input('@fi'); expect(current.activeWord).toBe('@fi');
        const before = renders;
        input('prefix @fi'); input('prefix @fi');
        expect(renders).toBe(before);
        const state = current.inputState.current;
        expect(applySuggestion(state.text, state.selection, '@file.ts', prefixes, true).text).toBe('prefix @file.ts ');
        input('prefix @fi', 7, 10); expect(current.activeWord).toBe(null);
        input('prefix @fi'); expect(current.activeWord).toBe('@fi');
        input(''); expect(current.activeWord).toBe(null);
    });
    it('rechecks the existing caret when the supported prefixes change', () => {
        input('@file'); expect(current.activeWord).toBe('@file');
        act(() => root.render(createElement(Probe, { allowed: ['/'] })));
        expect(current.activeWord).toBe(null);
        expect(current.inputState.current.text).toBe('@file');
    });
});
