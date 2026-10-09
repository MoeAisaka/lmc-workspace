// @vitest-environment jsdom
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ View: ({ children }: { children: React.ReactNode }) => createElement('div', null, children) }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { input: { text: '#000' } } } }) }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({ fontFamily: 'sans-serif' }) } }));
import { MultiTextInput, type MultiTextInputHandle } from './MultiTextInput.web';

describe('web composer Enter and IME', () => {
    let root: Root;
    let container: HTMLDivElement;
    let input: HTMLTextAreaElement;
    const onKeyPress = vi.fn(() => true);
    const key = (extra: KeyboardEventInit = {}) => {
        const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...extra });
        act(() => input.dispatchEvent(event)); return event;
    };
    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); onKeyPress.mockClear();
        container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
        act(() => root.render(createElement(MultiTextInput, { defaultValue: '中文草稿', onKeyPress })));
        input = container.querySelector('textarea')!; input.focus();
    });
    afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
    it('forwards plain Enter and the Shift modifier without losing focus', () => {
        expect(key().defaultPrevented).toBe(true); key({ shiftKey: true });
        expect(onKeyPress.mock.calls).toEqual([[{ key: 'Enter', shiftKey: false }], [{ key: 'Enter', shiftKey: true }]]);
        expect(document.activeElement).toBe(input);
    });
    it('does not send while composition is active even if a key event omits isComposing', () => {
        act(() => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
        key(); expect(onKeyPress).not.toHaveBeenCalled();
        act(() => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' })));
        key(); expect(onKeyPress).toHaveBeenCalledTimes(1);
    });
    it('does not send native composing Enter or WebKit legacy keyCode 229', () => {
        key({ isComposing: true }); key({ keyCode: 229 }); expect(onKeyPress).not.toHaveBeenCalled();
    });
    it('programmatic insertion and clearing notify once even without a parent rerender', () => {
        const ref = createRef<MultiTextInputHandle>();
        const onChangeText = vi.fn();
        act(() => root.render(createElement(MultiTextInput, { ref, defaultValue: '中文草稿', onKeyPress, onChangeText })));
        act(() => ref.current!.setTextAndSelection('多行\n补全', { start: 5, end: 5 }));
        expect(input.value).toBe('多行\n补全');
        expect(input.selectionStart).toBe(5);
        expect(container.querySelector('.lmc-textarea-mirror')?.textContent).toBe('多行\n补全 ');
        act(() => ref.current!.setTextAndSelection('', { start: 0, end: 0 }));
        expect(input.value).toBe('');
        expect(container.querySelector('.lmc-textarea-mirror')?.textContent).toBe(' ');
        expect(onChangeText.mock.calls).toEqual([['多行\n补全'], ['']]);
        expect(document.activeElement).toBe(input);
    });
    it('keeps the CSS mirror in sync for controlled drafts and trailing blank lines', () => {
        act(() => root.render(createElement(MultiTextInput, { value: '第一行\n', placeholder: '输入消息' })));
        expect(container.querySelector('.lmc-textarea-mirror')?.textContent).toBe('第一行\n ');
        act(() => root.render(createElement(MultiTextInput, { value: '', placeholder: '输入消息' })));
        expect(container.querySelector('.lmc-textarea-mirror')?.textContent).toBe('输入消息 ');
    });
    it('touch activation focuses without asking the browser to scroll the document', () => {
        vi.stubGlobal('matchMedia', () => ({ matches: true }));
        input.setSelectionRange(1, 3); input.blur();
        const focus = vi.spyOn(input, 'focus');
        const down = new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true });
        act(() => input.dispatchEvent(down));
        expect(down.defaultPrevented).toBe(true);
        expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
        expect(document.activeElement).toBe(input);
        expect(input.value).toBe('中文草稿');
        expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3]);
        focus.mockClear();
        const editing = new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true });
        act(() => input.dispatchEvent(editing));
        expect(editing.defaultPrevented).toBe(false);
        expect(focus).not.toHaveBeenCalled();
        focus.mockRestore();
    });
    it('leaves mouse selection and secondary-button activation native', () => {
        vi.stubGlobal('matchMedia', () => ({ matches: false }));
        input.blur();
        const focus = vi.spyOn(input, 'focus');
        for (const button of [0, 2]) {
            const down = new MouseEvent('mousedown', { button, bubbles: true, cancelable: true });
            act(() => input.dispatchEvent(down));
            expect(down.defaultPrevented).toBe(false);
        }
        expect(focus).not.toHaveBeenCalled();
        focus.mockRestore();
    });
    it('imperative focus also preserves the document scroll position', () => {
        const ref = createRef<MultiTextInputHandle>();
        act(() => root.render(createElement(MultiTextInput, { ref, defaultValue: '中文草稿' })));
        input.blur();
        const focus = vi.spyOn(input, 'focus');
        act(() => ref.current!.focus());
        expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
        expect(document.activeElement).toBe(input);
        focus.mockRestore();
    });
});
