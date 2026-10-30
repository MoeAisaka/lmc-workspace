// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
// @ts-expect-error react-native-web has no declarations in this workspace.
import { Pressable } from 'react-native-web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SortableHubGroups } from '@/components/lmc/SortableHubGroups.web';
import { sync } from '@/sync/sync';
import { SORT_HOLD_MS, TOUCH_MENU_HOLD_MS } from '@/utils/sessionSortGesture';

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
                    React.createElement('span', { 'data-metadata': item.id }, 'Device · Model'),
                    React.createElement('span', { role: 'button', 'data-menu': item.id }, 'Menu')),
                React.createElement('div', { 'data-whitespace': item.id }),
                React.createElement('span', { 'data-hint': item.id }, 'Drop here to bind'),
                React.createElement('div', { 'data-session-sort-id': `worker-${item.id}`, 'data-worker-padding': item.id }),
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

    function pointer(target: Element, type: string, y = 10, pointerType = 'mouse') {
        // Works with jsdom versions without PointerEvent, while retaining real
        // bubbling/capture and the actual descendant as event.target.
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: y });
        Object.defineProperties(event, {
            pointerId: { value: 1 }, pointerType: { value: pointerType }, isPrimary: { value: true },
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

    it.each(['group', 'whitespace', 'hint', 'metadata'])('sorts from the expanded %s area with a touch hold', (kind) => {
        mount();
        const target = container.querySelector(`[data-${kind}="H1"]`)!;
        pointer(target, 'pointerdown', 10, 'touch');
        act(() => vi.advanceTimersByTime(SORT_HOLD_MS + 1));
        expect(target.closest('[data-sort-active]')?.getAttribute('data-sort-active')).toBe('true');
        pointer(target, 'pointermove', 365, 'touch');
        pointer(target, 'pointerup', 365, 'touch');
        act(() => vi.runAllTimers());
        expect(sync.applySettings).toHaveBeenCalledExactlyOnceWith({ sessionProjectOrder: { 'lmc:hubs': ['H2', 'H3', 'H1'] } });
    });

    it('leaves early movement on the expanded area available for scrolling', () => {
        mount();
        const target = container.querySelector('[data-hint="H1"]')!;
        pointer(target, 'pointerdown', 10, 'touch');
        pointer(target, 'pointermove', 30, 'touch');
        act(() => vi.advanceTimersByTime(SORT_HOLD_MS + 1));
        pointer(target, 'pointermove', 365, 'touch');
        pointer(target, 'pointerup', 365, 'touch');
        act(() => vi.runAllTimers());
        expect(container.querySelector('[data-sort-active="true"]')).toBeNull();
        expect(sync.applySettings).not.toHaveBeenCalled();
    });

    it.each(['worker', 'menu', 'worker-padding'])('does not arm or sort from a nested %s control', (kind) => {
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

    it('opens the hub header contextmenu while still held on iPad touch long-press', () => {
        mount();
        const header = container.querySelector('[data-hub-sort-id="H1"][data-session-sort-id="H1"]')!;
        const onContextMenu = vi.fn();
        header.addEventListener('contextmenu', onContextMenu);
        const text = header.querySelector('[data-header-text="H1"]')!;

        pointer(text, 'pointerdown', 10, 'touch');
        // Minor capacitive finger roll (<= 12px) must not cancel or start a drag.
        pointer(text, 'pointermove', 20, 'touch');
        act(() => vi.advanceTimersByTime(TOUCH_MENU_HOLD_MS + 1));

        expect(onContextMenu).toHaveBeenCalledTimes(1);
        expect(container.querySelector('[data-sort-active="true"]')).toBeNull();

        // Releasing after the menu already opened does not fire a second menu or reorder.
        pointer(text, 'pointerup', 20, 'touch');
        act(() => vi.runAllTimers());
        expect(onContextMenu).toHaveBeenCalledTimes(1);
        expect(sync.applySettings).not.toHaveBeenCalled();
    });

    it('ignores secondary right-click / Ctrl+click so iPad trackpad right-click reaches the row menu', () => {
        mount();
        const text = container.querySelector('[data-header-text="H1"]')!;
        const rightDown = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 10 });
        Object.defineProperties(rightDown, { pointerId: { value: 2 }, pointerType: { value: 'touch' }, isPrimary: { value: true } });
        act(() => { text.dispatchEvent(rightDown); });
        act(() => vi.advanceTimersByTime(TOUCH_MENU_HOLD_MS + 10));
        expect(container.querySelector('[data-sort-active="true"]')).toBeNull();

        const ctrlDown = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, ctrlKey: true, clientX: 20, clientY: 10 });
        Object.defineProperties(ctrlDown, { pointerId: { value: 3 }, pointerType: { value: 'mouse' }, isPrimary: { value: true } });
        act(() => { text.dispatchEvent(ctrlDown); });
        act(() => vi.advanceTimersByTime(TOUCH_MENU_HOLD_MS + 10));
        expect(container.querySelector('[data-sort-active="true"]')).toBeNull();
    });

    it('does not block clicks inside a React-portaled context menu right after touch long-press', () => {
        const onMenuAction = vi.fn();
        const onHeaderPress = vi.fn();

        function Harness() {
            const [openId, setOpenId] = React.useState<string | null>(null);
            return React.createElement(SortableHubGroups<{ id: string }>, {
                storageKey: 'lmc:hubs',
                items: [{ id: 'H1' }],
                getId: (item) => item.id,
                renderItem: (item, handleProps) => React.createElement('section', { 'data-group': item.id },
                    React.createElement(Pressable, {
                        ...handleProps,
                        accessibilityRole: 'button',
                        onPress: onHeaderPress,
                        onContextMenu: (e: Event) => {
                            e.preventDefault();
                            setOpenId(item.id);
                        },
                    }, React.createElement('span', { 'data-header-text': item.id }, item.id)),
                    openId === item.id
                        ? createPortal(
                            React.createElement(Pressable, {
                                accessibilityRole: 'button',
                                testID: 'portaled-menu-item',
                                onPress: onMenuAction,
                            }, React.createElement('span', null, 'Rename')),
                            document.body,
                        )
                        : null,
                ),
            });
        }

        act(() => root.render(React.createElement(Harness)));
        const text = container.querySelector('[data-header-text="H1"]')!;
        pointer(text, 'pointerdown', 10, 'touch');
        act(() => vi.advanceTimersByTime(TOUCH_MENU_HOLD_MS + 1));
        pointer(text, 'pointerup', 10, 'touch');

        // Trailing click on the header itself must still be swallowed.
        act(() => {
            text.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 20, clientY: 10 }));
        });
        expect(onHeaderPress).not.toHaveBeenCalled();

        // Immediate tap (< 700ms) on the portaled menu item in document.body must fire!
        const menuItem = document.body.querySelector('[data-testid="portaled-menu-item"]')!;
        expect(menuItem).not.toBeNull();
        act(() => {
            menuItem.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
        });
        expect(onMenuAction).toHaveBeenCalledTimes(1);
    });

    it('arms drag and touch long-press through <a data-lmc-context-hit> while still ignoring real nested links', () => {
        const onContextMenu = vi.fn();
        act(() => root.render(React.createElement(SortableHubGroups<{ id: string }>, {
            storageKey: 'lmc:hubs',
            items: [{ id: 'H1' }, { id: 'H2' }],
            getId: (item) => item.id,
            renderItem: (item, handleProps) => React.createElement('section', { 'data-group': item.id },
                React.createElement(Pressable, {
                    ...handleProps,
                    accessibilityRole: 'button',
                    onContextMenu,
                },
                React.createElement('a', { 'data-lmc-context-hit': '', href: 'lmc-context:row', 'data-hit': item.id }, '\u00a0'),
                React.createElement('a', { href: 'https://example.com', 'data-real-link': item.id }, 'Link'))),
        })));
        const geometry = [{ top: 0, height: 80 }, { top: 80, height: 80 }];
        container.querySelectorAll<HTMLElement>('[data-sort-active]').forEach((node, index) => {
            vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(geometry[index] as DOMRect);
        });
        Object.defineProperty(container.firstElementChild, 'setPointerCapture', { value: () => {}, configurable: true });

        // 1. Real nested link does not arm sorting.
        const realLink = container.querySelector('[data-real-link="H1"]')!;
        pickUp(realLink);
        expect(container.querySelector('[data-sort-active="true"]')).toBeNull();
        pointer(realLink, 'pointerup', 10);

        // 2. Hit-overlay anchor <a data-lmc-context-hit> DOES arm sorting and touch long-press menu!
        const hitOverlay = container.querySelector('[data-hit="H1"]')!;
        pointer(hitOverlay, 'pointerdown', 10, 'touch');
        act(() => vi.advanceTimersByTime(TOUCH_MENU_HOLD_MS + 1));
        expect(onContextMenu).toHaveBeenCalledTimes(1);
        pointer(hitOverlay, 'pointerup', 10, 'touch');
        act(() => vi.runAllTimers());

        pickUp(hitOverlay);
        pointer(hitOverlay, 'pointermove', 165);
        pointer(hitOverlay, 'pointerup', 165);
        act(() => vi.runAllTimers());
        expect(sync.applySettings).toHaveBeenCalledExactlyOnceWith({ sessionProjectOrder: { 'lmc:hubs': ['H2', 'H1'] } });
    });
});
