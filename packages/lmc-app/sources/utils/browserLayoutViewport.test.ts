// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserLayoutSizing, readBrowserLayoutWidth } from './browserLayoutViewport';

const native = vi.hoisted(() => ({ OS: 'web', width: 680 }));
vi.mock('react-native', () => ({
    Platform: native,
    useWindowDimensions: () => ({ width: native.width, height: 896, scale: 2, fontScale: 1 }),
}));
import { useLayoutWindowDimensions } from '@/hooks/useLayoutWindowDimensions';

describe('browser layout after rotation', () => {
    let width: number;
    let cleanup: () => void;
    beforeEach(() => {
        vi.useFakeTimers();
        native.OS = 'web';
        width = 680;
        vi.spyOn(document.documentElement, 'clientWidth', 'get').mockImplementation(() => width);
        vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { width: 680, offsetTop: 0, scale: 1 }));
        cleanup = installBrowserLayoutSizing();
    });
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });
    const cssWidth = () => document.documentElement.style.getPropertyValue('--lmc-layout-width');
    const cssHeight = () => document.documentElement.style.getPropertyValue('--lmc-layout-height');

    it('never rewrites the document frame in response to keyboard geometry or caret panning', () => {
        vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(756);
        const input = document.createElement('textarea');
        input.dataset.lmcTextInput = 'true'; document.body.appendChild(input);
        input.value = '保留中文草稿';
        input.focus();
        try {
            for (const [height, offset, inner] of [[756, 0, 756], [447, 309, 447], [424, 218, 538], [424, 332, 424], [424, 379.7, 424]]) {
                vi.stubGlobal('innerHeight', inner);
                vi.stubGlobal('scrollY', offset);
                Object.assign(window.visualViewport!, { height, offsetTop: offset, pageTop: offset });
                window.visualViewport!.dispatchEvent(new Event('resize'));
                window.visualViewport!.dispatchEvent(new Event('scroll'));
                window.dispatchEvent(new Event('scroll'));
                vi.advanceTimersByTime(700);
                expect(cssHeight()).toBe('');
                expect(document.documentElement.style.getPropertyValue('--lmc-layout-top')).toBe('');
                expect(document.documentElement.classList.contains('lmc-input-viewport')).toBe(false);
                expect(document.documentElement.classList.contains('lmc-input-native-bottom')).toBe(false);
                expect(window.scrollY).toBe(offset);
                expect(document.activeElement).toBe(input);
                expect(input.value).toBe('保留中文草稿');
            }
        } finally { input.remove(); }
    });

    it('does not change the root between a focused touch and its click after blur', () => {
        const input = document.createElement('textarea');
        input.dataset.lmcTextInput = 'true'; document.body.appendChild(input);
        Object.assign(window.visualViewport!, { height: 424, offsetTop: 332 });
        vi.stubGlobal('innerHeight', 424);
        const root = document.documentElement;
        const before = { css: root.style.cssText, classes: root.className };
        input.focus();
        expect({ css: root.style.cssText, classes: root.className }).toEqual(before);
        input.blur();
        expect({ css: root.style.cssText, classes: root.className }).toEqual(before);
        input.remove();
    });

    it('uses layout width even when the visual viewport still reports portrait', () => {
        width = 1368;
        window.dispatchEvent(new Event('resize'));
        expect(cssWidth()).toBe('1368px');
        expect(readBrowserLayoutWidth()).toBe(1368);
        expect(window.visualViewport!.width).toBe(680);
    });
    it('remeasures after an early orientation event without another resize', () => {
        window.dispatchEvent(new Event('orientationchange'));
        expect(cssWidth()).toBe('680px');
        width = 1368;
        vi.advanceTimersByTime(300);
        expect(cssWidth()).toBe('1368px');
        window.dispatchEvent(new Event('orientationchange'));
        width = 820;
        vi.advanceTimersByTime(700);
        expect(cssWidth()).toBe('820px');
        expect(vi.getTimerCount()).toBe(0);
    });
    it.each(['pageshow', 'focus', 'visibilitychange'])('recovers missed rotation on %s', event => {
        width = 1368;
        (event === 'visibilitychange' ? document : window).dispatchEvent(new Event(event));
        expect(cssWidth()).toBe('1368px');
    });
    it('does not narrow the page when pinch zoom narrows the visual viewport', () => {
        width = 1368;
        Object.assign(window.visualViewport!, { width: 684, scale: 2 });
        window.visualViewport!.dispatchEvent(new Event('resize'));
        expect(cssWidth()).toBe('1368px');
    });
    it('cancels pending measurements and listeners on cleanup', () => {
        window.dispatchEvent(new Event('orientationchange'));
        cleanup();
        expect(vi.getTimerCount()).toBe(0);
        width = 1368;
        window.dispatchEvent(new Event('resize'));
        vi.runAllTimers();
        expect(cssWidth()).toBe('');
        expect(cssHeight()).toBe('');
    });
    it('updates column width without remounting or losing a draft when RN is stale', () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        const container = document.createElement('div');
        const root = createRoot(container);
        function Probe() {
            const size = useLayoutWindowDimensions();
            return createElement('input', { key: 'draft', defaultValue: '保留草稿', 'data-width': size.width });
        }
        act(() => root.render(createElement(Probe)));
        const input = container.querySelector('input')!;
        input.value = '未发送的修改';
        for (const next of [1368, 820, 1368]) {
            act(() => { width = next; window.dispatchEvent(new Event('resize')); });
            expect(container.querySelector('input')).toBe(input);
            expect(input.value).toBe('未发送的修改');
            expect(input.dataset.width).toBe(String(next));
        }
        native.OS = 'ios';
        act(() => root.render(createElement(Probe)));
        expect(input.dataset.width).toBe('680');
        act(() => root.unmount());
    });
});
