// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
// @ts-expect-error react-native-web has no declarations in this workspace.
import { Pressable } from 'react-native-web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SortableSessionRows } from './SortableSessionRows.web';
import { sync } from '@/sync/sync';

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { surfaceHighest: '#eee', surface: '#fff' } } }),
}));
vi.mock('@/sync/storage', () => ({ useSetting: () => ({}) }));
vi.mock('@/sync/sync', () => ({ sync: { applySettings: vi.fn() } }));

describe('SortableSessionRows.web', () => {
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
        delete (document as any).elementsFromPoint;
        delete (document as any).elementFromPoint;
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    function pointer(target: Element | Document | Window, type: string, x: number, y: number, pointerType = 'mouse', pointerId = 1) {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
        Object.defineProperties(event, {
            pointerId: { value: pointerId },
            pointerType: { value: pointerType },
            isPrimary: { value: true },
        });
        act(() => { target.dispatchEvent(event); });
    }

    it('reorders to the bottom edge slot without neighbor [data-drop-target] hijacking and snapping back', () => {
        const onDropOn = vi.fn();
        const adjacentHub = document.createElement('div');
        adjacentHub.setAttribute('data-drop-target', 'hub:H2');
        document.body.appendChild(adjacentHub);

        try {
            act(() => root.render(React.createElement('div', { 'data-drop-target': 'hub:H1' },
                React.createElement(SortableSessionRows<{ id: string }>, {
                    groupId: 'lmc:hub:H1',
                    sessions: [{ id: 'W1' }, { id: 'W2' }, { id: 'W3' }],
                    ownDropTarget: 'hub:H1',
                    onDropOn,
                    renderRow: (s) => React.createElement(Pressable, { accessibilityRole: 'button' },
                        React.createElement('span', { 'data-label': s.id }, s.id)),
                }))));

            const sortRoot = container.querySelector<HTMLElement>('[data-drop-target="hub:H1"] > div')!;
            vi.spyOn(sortRoot, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 244, left: 0, right: 280, width: 280, height: 144, x: 0, y: 100, toJSON: () => ({}) } as DOMRect);
            const rows = container.querySelectorAll<HTMLElement>('.happy-sort-row');
            const geometry = [{ top: 100, height: 48 }, { top: 148, height: 48 }, { top: 196, height: 48 }];
            rows.forEach((node, i) => {
                vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(geometry[i] as DOMRect);
            });
            Object.defineProperty(sortRoot, 'setPointerCapture', { value: () => {}, configurable: true });
            Object.defineProperty(document, 'elementsFromPoint', {
                value: () => [adjacentHub],
                configurable: true,
            });

            const w1 = container.querySelector('[data-label="W1"]')!;
            pointer(w1, 'pointerdown', 40, 120);
            // Drag to bottom edge of H1 (y = 246, within 6px tolerance of root bottom 244).
            pointer(w1, 'pointermove', 40, 246);
            pointer(w1, 'pointerup', 40, 246);
            act(() => vi.runAllTimers());

            expect(onDropOn).not.toHaveBeenCalled();
            expect(sync.applySettings).toHaveBeenCalledExactlyOnceWith({
                sessionProjectOrder: { 'lmc:hub:H1': ['W2', 'W3', 'W1'] },
            });
        } finally {
            adjacentHub.remove();
        }
    });

    it('detects cross-group drop targets beneath the translated dragged row via elementsFromPoint', () => {
        const onDropOn = vi.fn();
        const targetHub = document.createElement('div');
        targetHub.setAttribute('data-drop-target', 'hub:GPD');
        document.body.appendChild(targetHub);

        try {
            act(() => root.render(React.createElement('div', { 'data-drop-target': 'ungroup' },
                React.createElement(SortableSessionRows<{ id: string }>, {
                    groupId: 'lmc:gpd:codex',
                    sessions: [{ id: 'S1' }],
                    ownDropTarget: 'ungroup',
                    onDropOn,
                    renderRow: (s) => React.createElement(Pressable, { accessibilityRole: 'button' },
                        React.createElement('a', { 'data-lmc-context-hit': '', 'data-hit': s.id }, '\u00a0'),
                        React.createElement('span', { 'data-label': s.id }, s.id)),
                }))));

            const sortRoot = container.querySelector<HTMLElement>('[data-drop-target="ungroup"] > div')!;
            vi.spyOn(sortRoot, 'getBoundingClientRect').mockReturnValue({ top: 300, bottom: 348, left: 0, right: 280, width: 280, height: 48, x: 0, y: 300, toJSON: () => ({}) } as DOMRect);
            const s1Row = container.querySelector<HTMLElement>('.happy-sort-row')!;
            vi.spyOn(s1Row, 'getBoundingClientRect').mockReturnValue({ top: 300, height: 48 } as DOMRect);
            const hitLink = container.querySelector<HTMLElement>('[data-hit="S1"]')!;

            // Simulate hit-test returning the translated dragged row first, and targetHub underneath it.
            Object.defineProperty(document, 'elementsFromPoint', {
                value: () => [hitLink, s1Row, targetHub, document.body],
                configurable: true,
            });

            pointer(hitLink, 'pointerdown', 60, 320);
            pointer(hitLink, 'pointermove', 60, 120);
            pointer(document.body, 'pointerup', 60, 120);
            act(() => vi.runAllTimers());

            expect(onDropOn).toHaveBeenCalledExactlyOnceWith('S1', 'hub:GPD');
            expect(sync.applySettings).not.toHaveBeenCalled();
        } finally {
            targetHub.remove();
        }
    });

    it('survives lostpointercapture and commits reorder when pointerup fires on document.body', () => {
        act(() => root.render(React.createElement(SortableSessionRows<{ id: string }>, {
            groupId: 'lmc:macmini:claude',
            sessions: [{ id: 'S1' }, { id: 'S2' }],
            renderRow: (s) => React.createElement(Pressable, { accessibilityRole: 'button' },
                React.createElement('span', { 'data-label': s.id }, s.id)),
        })));

        const sortRoot = container.firstElementChild as HTMLElement;
        const rows = container.querySelectorAll<HTMLElement>('.happy-sort-row');
        vi.spyOn(rows[0], 'getBoundingClientRect').mockReturnValue({ top: 0, height: 48 } as DOMRect);
        vi.spyOn(rows[1], 'getBoundingClientRect').mockReturnValue({ top: 48, height: 48 } as DOMRect);
        Object.defineProperty(sortRoot, 'hasPointerCapture', { value: () => false, configurable: true });

        const s1 = container.querySelector('[data-label="S1"]')!;
        pointer(s1, 'pointerdown', 40, 20);
        pointer(s1, 'pointermove', 40, 42);
        const lost = new MouseEvent('lostpointercapture', { bubbles: true, cancelable: false, clientX: 40, clientY: 42 });
        Object.defineProperties(lost, { pointerId: { value: 1 }, pointerType: { value: 'mouse' }, isPrimary: { value: true } });
        act(() => { sortRoot.dispatchEvent(lost); });

        pointer(document.body, 'pointermove', 420, 88);
        pointer(document.body, 'pointerup', 420, 88);
        act(() => vi.runAllTimers());

        expect(sync.applySettings).toHaveBeenCalledExactlyOnceWith({
            sessionProjectOrder: { 'lmc:macmini:claude': ['S2', 'S1'] },
        });
    });

    it('flushes pending save if a worker spawns/archives during the 180ms drop animation', () => {
        vi.stubGlobal('matchMedia', () => ({ matches: false }));
        const renderSessions = (sessions: { id: string }[]) => act(() => root.render(React.createElement(SortableSessionRows<{ id: string }>, {
            groupId: 'lmc:hub:H1',
            sessions,
            renderRow: (s) => React.createElement(Pressable, { accessibilityRole: 'button' },
                React.createElement('span', { 'data-label': s.id }, s.id)),
        })));

        renderSessions([{ id: 'W1' }, { id: 'W2' }]);
        const rows = container.querySelectorAll<HTMLElement>('.happy-sort-row');
        vi.spyOn(rows[0], 'getBoundingClientRect').mockReturnValue({ top: 0, height: 48 } as DOMRect);
        vi.spyOn(rows[1], 'getBoundingClientRect').mockReturnValue({ top: 48, height: 48 } as DOMRect);

        const w1 = container.querySelector('[data-label="W1"]')!;
        pointer(w1, 'pointerdown', 40, 16);
        pointer(w1, 'pointermove', 40, 88);
        pointer(w1, 'pointerup', 40, 88);

        // Live worker W3 spawns 40ms later while drop animation is still running.
        renderSessions([{ id: 'W1' }, { id: 'W2' }, { id: 'W3' }]);
        expect(sync.applySettings).toHaveBeenCalledExactlyOnceWith({
            sessionProjectOrder: { 'lmc:hub:H1': ['W2', 'W1', 'W3'] },
        });
    });
});
