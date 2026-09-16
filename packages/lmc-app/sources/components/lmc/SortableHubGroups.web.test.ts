// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
// @ts-expect-error react-native-web has no declarations in this workspace.
import { Pressable } from 'react-native-web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SortableHubGroups } from '@/components/lmc/SortableHubGroups.web';
import { sync } from '@/sync/sync';
import { SORT_HOLD_MS } from '@/utils/sessionSortGesture';

vi.mock('@/sync/storage', () => ({ useSetting: () => ({}) }));
vi.mock('@/sync/sync', () => ({ sync: { applySettings: vi.fn() } }));

describe('SortableHubGroups with RN Web Pressable', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.stubGlobal('matchMedia', () => ({ matches: true }));
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    function mount() {
        act(() => root.render(React.createElement(SortableHubGroups<{ id: string }>, {
            storageKey: 'lmc:hubs', items: [{ id: 'H1' }, { id: 'H2' }, { id: 'H3' }],
            getId: (item) => item.id,
            renderItem: (item, handleProps) => React.createElement('section', { 'data-group': item.id },
                React.createElement(Pressable, { ...handleProps, accessibilityRole: 'button' },
                    React.createElement('span', { 'data-header-text': item.id }, item.id),
                    React.createElement('span', { role: 'button', 'data-menu': item.id }, 'Menu')),
                React.createElement('button', { 'data-worker': item.id }, 'Worker')),
        })));
        // jsdom has no layout/pointer capture. Only those browser facilities
        // are supplied here; Pressable, DOM markers, closest() and event
        // propagation all run unchanged.
        const geometry = [{ top: 0, height: 180 }, { top: 180, height: 80 }, { top: 260, height: 100 }];
        container.querySelectorAll<HTMLElement>('[data-sort-active]').forEach((node, index) => {
            vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(geometry[index] as DOMRect);
        });
        Object.defineProperty(container.firstElementChild, 'setPointerCapture', { value: () => {}, configurable: true });
    }

    function pointer(target: Element, type: string, y = 10) {
        // Works with jsdom versions without PointerEvent, while retaining real
        // bubbling/capture and the actual descendant as event.target.
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: y });
        Object.defineProperties(event, {
            pointerId: { value: 1 }, pointerType: { value: 'mouse' }, isPrimary: { value: true },
        });
        act(() => { target.dispatchEvent(event); });
    }

    function pickUp(target: Element) {
        pointer(target, 'pointerdown');
        act(() => vi.advanceTimersByTime(SORT_HOLD_MS + 1));
    }

    function drag() {
        const text = container.querySelector('[data-header-text="H1"]')!;
        pickUp(text);
        pointer(text, 'pointermove', 365);
        return text;
    }

    it('arms from a real Pressable descendant via DOM pointerdown capture', () => {
        mount();
        const header = container.querySelector('[data-hub-sort-id="H1"]');
        expect(header).not.toBeNull();
        const text = header!.querySelector('[data-header-text="H1"]')!;
        pickUp(text);
        expect(header!.closest('[data-sort-active]')?.getAttribute('data-sort-active')).toBe('true');
    });

    it('moves the whole measured group and saves the new order', () => {
        mount();
        const text = drag();
        pointer(text, 'pointerup', 365);
        act(() => vi.runAllTimers());
        expect(sync.applySettings).toHaveBeenCalledExactlyOnceWith({ sessionProjectOrder: { 'lmc:hubs': ['H2', 'H3', 'H1'] } });
    });

    it.each(['worker', 'menu'])('does not arm or sort from a nested %s control', (kind) => {
        mount();
        const control = container.querySelector(`[data-${kind}="H1"]`)!;
        pickUp(control);
        expect(container.querySelector('[data-sort-active="true"]')).toBeNull();
        pointer(control, 'pointermove', 365);
        pointer(control, 'pointerup', 365);
        act(() => vi.runAllTimers());
        expect(sync.applySettings).not.toHaveBeenCalled();
    });

    it('cancels on Escape even when focus is outside the sorter', () => {
        mount();
        const text = drag();
        const outside = document.createElement('input');
        document.body.appendChild(outside);
        outside.focus();
        const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        act(() => { outside.dispatchEvent(escape); });
        expect(escape.defaultPrevented).toBe(true);
        pointer(text, 'pointerup', 365);
        act(() => vi.runAllTimers());
        expect(sync.applySettings).not.toHaveBeenCalled();
        outside.remove();
    });

    it.each(['drop', 'unmount'])('removes the window key listener after %s', (end) => {
        const add = vi.spyOn(window, 'addEventListener');
        const remove = vi.spyOn(window, 'removeEventListener');
        mount();
        expect(add.mock.calls.filter(([name]) => name === 'keydown')).toHaveLength(0);
        const text = drag();
        const listener = add.mock.calls.find(([name]) => name === 'keydown')?.[1];
        expect(listener).toBeDefined();
        if (end === 'unmount') act(() => root.render(null));
        else {
            pointer(text, 'pointerup', 365);
            act(() => vi.runAllTimers());
        }
        expect(remove.mock.calls.some(([name, fn]) => name === 'keydown' && fn === listener)).toBe(true);
    });
});
