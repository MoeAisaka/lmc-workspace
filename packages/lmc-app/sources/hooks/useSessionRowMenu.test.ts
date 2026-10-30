// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
// @ts-expect-error react-native-web has no declarations in this workspace.
import { Pressable } from 'react-native-web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SortableSessionRows } from '@/components/SortableSessionRows.web';
import { SESSION_ROW_MENU_STYLE, shouldUseWebKitLinkContextProbe, useSessionRowMenu } from '@/hooks/useSessionRowMenu';
import { sync } from '@/sync/sync';
import { SORT_HOLD_MS, TOUCH_MENU_HOLD_MS } from '@/utils/sessionSortGesture';

vi.mock('react-native', () => ({ Platform: { OS: 'web', select: (map: any) => map.web ?? map.default } }));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { surfaceHighest: '#eee', surface: '#fff' } } }),
}));
vi.mock('@/hooks/useSessionQuickActions', () => ({ useSessionQuickActions: () => ({ actionItems: [] }) }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/sync/storage', () => ({
    useSession: () => ({ id: 'S1' }),
    useSetting: () => ({}),
}));
vi.mock('@/sync/sync', () => ({ sync: { applySettings: vi.fn() } }));
vi.mock('@/components/lmc/CollaborationSheet', () => ({ openCollaborationSheet: vi.fn() }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

describe('useSessionRowMenu + SortableSessionRows on iPad browsers', () => {
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

    function RowItem({ id, onNavigate, tick = 0 }: { id: string; onNavigate: () => void; tick?: number }) {
        const { anchor, closeMenu, contextHitOverlay, menuProps, outerMenuProps } = useSessionRowMenu(id);
        return React.createElement('div', { 'data-row-host': id, ...(outerMenuProps as any) },
            React.createElement(Pressable, {
                accessibilityRole: 'button',
                onPress: onNavigate,
                style: SESSION_ROW_MENU_STYLE,
                ...menuProps,
            },
            contextHitOverlay,
            React.createElement('span', { key: `label-${tick}`, 'data-row-label': id }, `${id}-${tick}`)),
            anchor && createPortal(
                React.createElement('div', {
                    'data-menu-open': id,
                    'data-menu-point': `${anchor.type === 'point' ? `${anchor.x},${anchor.y}` : ''}`,
                    onPointerDown: (event: React.PointerEvent) => event.stopPropagation(),
                    onPointerUp: (event: React.PointerEvent) => event.stopPropagation(),
                    onClick: closeMenu,
                }, 'menu'),
                document.body,
            ),
        );
    }

    function mountSortable(tick = 0, onNavigate = vi.fn()) {
        act(() => root.render(React.createElement(SortableSessionRows<{ id: string }>, {
            groupId: 'lmc:macmini:claude',
            sessions: [{ id: 'S1' }, { id: 'S2' }],
            renderRow: (session) => React.createElement(RowItem, { key: session.id, id: session.id, onNavigate, tick }),
        })));
        const geometry = [{ top: 0, height: 48 }, { top: 48, height: 48 }];
        container.querySelectorAll<HTMLElement>('.happy-sort-row').forEach((node, index) => {
            vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(geometry[index] as DOMRect);
        });
        Object.defineProperty(container.firstElementChild, 'setPointerCapture', { value: () => {}, configurable: true });
        return onNavigate;
    }

    function dispatchPointer(
        target: Element,
        type: string,
        init: { x?: number; y?: number; button?: number; buttons?: number; ctrlKey?: boolean; pointerType?: string; pointerId?: number } = {},
    ) {
        const event = new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            button: init.button ?? 0,
            buttons: init.buttons ?? 0,
            ctrlKey: init.ctrlKey ?? false,
            clientX: init.x ?? 42,
            clientY: init.y ?? 24,
        });
        Object.defineProperties(event, {
            pointerId: { value: init.pointerId ?? 1 },
            pointerType: { value: init.pointerType ?? 'mouse' },
            isPrimary: { value: true },
        });
        act(() => { target.dispatchEvent(event); });
    }

    it('opens the secondary menu on iPadOS trackpad/mouse right-click even when WebKit omits contextmenu', () => {
        const onNavigate = mountSortable();
        const label = container.querySelector('[data-row-label="S1"]')!;

        dispatchPointer(label, 'pointerdown', { button: 2, buttons: 2, pointerType: 'touch', x: 64, y: 28 });
        dispatchPointer(label, 'pointerup', { button: 2, buttons: 0, pointerType: 'touch', x: 64, y: 28 });

        const menu = document.querySelector('[data-menu-open="S1"]');
        expect(menu).not.toBeNull();
        expect(menu?.getAttribute('data-menu-point')).toBe('64,28');
        expect(onNavigate).not.toHaveBeenCalled();
    });

    it('opens via fallback timer when right-click is held down on iPadOS without contextmenu', () => {
        mountSortable();
        const label = container.querySelector('[data-row-label="S1"]')!;

        dispatchPointer(label, 'pointerdown', { button: 2, buttons: 2, pointerType: 'mouse', x: 80, y: 30 });
        act(() => vi.advanceTimersByTime(100));

        expect(document.querySelector('[data-menu-open="S1"]')?.getAttribute('data-menu-point')).toBe('80,30');
    });

    it('opens on Ctrl+click without navigating to the session', () => {
        const onNavigate = mountSortable();
        const label = container.querySelector('[data-row-label="S1"]')!;

        dispatchPointer(label, 'pointerdown', { button: 0, buttons: 1, ctrlKey: true, pointerType: 'mouse', x: 50, y: 20 });
        act(() => {
            label.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, ctrlKey: true, clientX: 50, clientY: 20 }));
        });
        dispatchPointer(label, 'pointerup', { button: 0, buttons: 0, ctrlKey: true, pointerType: 'mouse', x: 50, y: 20 });
        act(() => {
            label.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, buttons: 0, ctrlKey: true, clientX: 50, clientY: 20, detail: 1 }));
            label.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true, clientX: 50, clientY: 20, detail: 1 }));
        });

        expect(document.querySelector('[data-menu-open="S1"]')).not.toBeNull();
        expect(onNavigate).not.toHaveBeenCalled();
    });

    it('opens on stationary iPad touch long-press while finger is still down, even if child text re-renders', () => {
        const onNavigate = vi.fn();
        mountSortable(0, onNavigate);
        const initialLabel = container.querySelector('[data-row-label="S1"]')!;

        dispatchPointer(initialLabel, 'pointerdown', { pointerType: 'touch', x: 70, y: 22 });
        // Simulate streaming session status re-replacing the inner text span mid-hold.
        mountSortable(1, onNavigate);
        const nextLabel = container.querySelector('[data-row-label="S1"]')!;
        expect(initialLabel.isConnected).toBe(false);

        // Small capacitive finger pad shift (<= 12px) keeps stationary hold alive.
        dispatchPointer(nextLabel, 'pointermove', { pointerType: 'touch', x: 76, y: 28 });
        act(() => vi.advanceTimersByTime(TOUCH_MENU_HOLD_MS + 5));

        expect(document.querySelector('[data-menu-open="S1"]')?.getAttribute('data-menu-point')).toBe('70,22');

        // Lifting the finger afterwards must not navigate or reorder.
        dispatchPointer(nextLabel, 'pointerup', { pointerType: 'touch', x: 76, y: 28 });
        act(() => {
            nextLabel.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
        });
        expect(onNavigate).not.toHaveBeenCalled();
        expect(sync.applySettings).not.toHaveBeenCalled();
    });

    it('preserves touch hold-then-drag reordering without opening a competing menu', () => {
        mountSortable();
        const label = container.querySelector('[data-row-label="S1"]')!;

        dispatchPointer(label, 'pointerdown', { pointerType: 'touch', x: 40, y: 12 });
        act(() => vi.advanceTimersByTime(SORT_HOLD_MS + 10));
        dispatchPointer(label, 'pointermove', { pointerType: 'touch', x: 40, y: 86 });
        act(() => vi.advanceTimersByTime(TOUCH_MENU_HOLD_MS));
        expect(document.querySelector('[data-menu-open="S1"]')).toBeNull();

        dispatchPointer(label, 'pointerup', { pointerType: 'touch', x: 40, y: 86 });
        act(() => vi.runAllTimers());
        expect(sync.applySettings).toHaveBeenCalledExactlyOnceWith({
            sessionProjectOrder: { 'lmc:macmini:claude': ['S2', 'S1'] },
        });
    });

    it('opens on iPadOS secondary click even when WKMouseHover cancels (MouseMove(-1,-1) + pointerleave) before WebCore selectstart', () => {
        const onNavigate = mountSortable();
        const label = container.querySelector('[data-row-label="S1"]')!;

        // Overlay is mounted at rest while menu is closed so stationary / unhovered rows also respond.
        const hitOverlay = container.querySelector<HTMLSpanElement>('[data-row-host="S1"] [data-lmc-context-hit]');
        expect(hitOverlay).not.toBeNull();
        expect(hitOverlay?.style.userSelect).toBe('text');
        expect(hitOverlay?.firstChild?.nodeType).toBe(Node.TEXT_NODE);

        // 1. Trackpad hover moves over the row at (142, 26) with buttons === 0.
        dispatchPointer(label, 'pointermove', { pointerType: 'mouse', buttons: 0, x: 142, y: 26 });

        // 2. Real iPadOS UIKit cancels WKMouseInteraction's UIHoverGestureRecognizer on secondary click,
        // emitting MouseMove(-1, -1) -> pointerout + pointerleave BEFORE prepareSelectionForContextMenu.
        dispatchPointer(label, 'pointermove', { pointerType: 'mouse', buttons: 0, x: -1, y: -1 });
        dispatchPointer(label, 'pointerout', { pointerType: 'mouse', buttons: 0, x: -1, y: -1 });
        dispatchPointer(label, 'pointerleave', { pointerType: 'mouse', buttons: 0, x: -1, y: -1 });

        expect(hitOverlay?.isConnected).toBe(true);
        expect(hitOverlay?.style.userSelect).toBe('text');

        // 3. WebPage::prepareSelectionForContextMenuWithLocationInView dispatches selectstart on Text node.
        const selectStartEvent = new Event('selectstart', { bubbles: true, cancelable: true });
        let notPrevented = true;
        act(() => {
            notPrevented = hitOverlay!.firstChild!.dispatchEvent(selectStartEvent);
        });

        expect(notPrevented).toBe(false);
        expect(selectStartEvent.defaultPrevented).toBe(true);
        expect(document.querySelector('[data-menu-open="S1"]')?.getAttribute('data-menu-point')).toBe('142,26');
        expect(onNavigate).not.toHaveBeenCalled();
    });

    it('opens at cursor coordinates after two-finger trackpad wheel scroll onto an unhovered row', () => {
        const onNavigate = mountSortable();
        const s2Hit = container.querySelector<HTMLSpanElement>('[data-row-host="S2"] [data-lmc-context-hit]')!;
        vi.spyOn(s2Hit, 'getBoundingClientRect').mockReturnValue({
            left: 12,
            top: 48,
            right: 292,
            bottom: 96,
            width: 280,
            height: 48,
            x: 12,
            y: 48,
            toJSON: () => ({}),
        } as DOMRect);

        // User scrolls list under stationary trackpad cursor at (168, 72) — zero pointerenter/pointermove on S2.
        act(() => {
            window.dispatchEvent(new WheelEvent('wheel', { bubbles: true, clientX: 168, clientY: 72, deltaY: 120 }));
        });

        const selectStartEvent = new Event('selectstart', { bubbles: true, cancelable: true });
        act(() => {
            s2Hit.firstChild!.dispatchEvent(selectStartEvent);
        });

        expect(selectStartEvent.defaultPrevented).toBe(true);
        expect(document.querySelector('[data-menu-open="S2"]')?.getAttribute('data-menu-point')).toBe('168,72');
        expect(onNavigate).not.toHaveBeenCalled();
    });

    it('restores secondary-click selectstart readiness after a prior screen tap without requiring mouse movement', () => {
        const onNavigate = mountSortable();
        const s1Hit = container.querySelector<HTMLSpanElement>('[data-row-host="S1"] [data-lmc-context-hit]')!;
        vi.spyOn(s1Hit, 'getBoundingClientRect').mockReturnValue({
            left: 12,
            top: 0,
            right: 292,
            bottom: 48,
            width: 280,
            height: 48,
            x: 12,
            y: 0,
            toJSON: () => ({}),
        } as DOMRect);

        // 1. User taps touchscreen (e.g. opening Portrait FloatingSessionDrawer).
        act(() => {
            const touchStart = new Event('touchstart', { bubbles: true });
            Object.defineProperty(touchStart, 'touches', { value: [{}] });
            window.dispatchEvent(touchStart);
        });
        expect(s1Hit.getAttribute('data-lmc-context-hit')).toBe('inert');
        expect(s1Hit.style.userSelect).toBe('none');

        act(() => {
            const touchEnd = new Event('touchend', { bubbles: true });
            Object.defineProperty(touchEnd, 'touches', { value: [] });
            window.dispatchEvent(touchEnd);
        });

        // 2. After post-touch release window (~120ms), overlay re-arms automatically even with zero pointermove.
        act(() => vi.advanceTimersByTime(150));
        expect(s1Hit.getAttribute('data-lmc-context-hit')).toBe('');
        expect(s1Hit.style.userSelect).toBe('text');

        // 3. Right-click (selectstart) opens the menu immediately.
        const selectStartEvent = new Event('selectstart', { bubbles: true, cancelable: true });
        act(() => {
            s1Hit.firstChild!.dispatchEvent(selectStartEvent);
        });
        expect(selectStartEvent.defaultPrevented).toBe(true);
        expect(document.querySelector('[data-menu-open="S1"]')?.getAttribute('data-menu-point')).toBe('60,24');
        expect(onNavigate).not.toHaveBeenCalled();
    });

    it('keeps primary mouse left-click and cross-row mouse drag from opening menu on selectstart', () => {
        const onNavigate = mountSortable();
        const label = container.querySelector('[data-row-label="S1"]')!;

        dispatchPointer(label, 'pointermove', { pointerType: 'mouse', buttons: 0, x: 96, y: 20 });
        const hitOverlay = container.querySelector<HTMLSpanElement>('[data-row-host="S1"] [data-lmc-context-hit]')!;
        const s2Overlay = container.querySelector<HTMLSpanElement>('[data-row-host="S2"] [data-lmc-context-hit]')!;
        expect(hitOverlay).not.toBeNull();

        // Primary left-click dispatches pointerdown(0) -> selectstart -> pointerup(0) -> click(0).
        dispatchPointer(hitOverlay, 'pointerdown', { button: 0, buttons: 1, pointerType: 'mouse', x: 96, y: 20 });
        const selectStartEvent = new Event('selectstart', { bubbles: true, cancelable: true });
        const crossRowSelectStart = new Event('selectstart', { bubbles: true, cancelable: true });
        act(() => {
            hitOverlay.firstChild!.dispatchEvent(selectStartEvent);
            s2Overlay.firstChild!.dispatchEvent(crossRowSelectStart);
        });
        expect(selectStartEvent.defaultPrevented).toBe(true);
        expect(crossRowSelectStart.defaultPrevented).toBe(true);
        expect(document.querySelector('[data-menu-open="S1"]')).toBeNull();
        expect(document.querySelector('[data-menu-open="S2"]')).toBeNull();

        dispatchPointer(hitOverlay, 'pointerup', { button: 0, buttons: 0, pointerType: 'mouse', x: 96, y: 20 });
        act(() => {
            hitOverlay.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, clientX: 96, clientY: 20, detail: 1 }));
        });
        expect(document.querySelector('[data-menu-open="S1"]')).toBeNull();
        expect(onNavigate).toHaveBeenCalledTimes(1);
    });

    it('suppresses trailing navigation when Ctrl is released before mouseup after Ctrl+click contextmenu', () => {
        const onNavigate = mountSortable();
        const label = container.querySelector('[data-row-label="S1"]')!;

        dispatchPointer(label, 'pointerdown', { button: 0, buttons: 1, ctrlKey: true, pointerType: 'mouse', x: 58, y: 21 });
        act(() => {
            label.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0, ctrlKey: true, clientX: 58, clientY: 21 }));
        });
        // User lifts Ctrl key slightly before releasing mouse button.
        dispatchPointer(label, 'pointerup', { button: 0, buttons: 0, ctrlKey: false, pointerType: 'mouse', x: 58, y: 21 });
        act(() => {
            label.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: false, clientX: 58, clientY: 21, detail: 1 }));
        });

        expect(document.querySelector('[data-menu-open="S1"]')?.getAttribute('data-menu-point')).toBe('58,21');
        expect(onNavigate).not.toHaveBeenCalled();
    });

    it('opens on legacy secondary mousedown/mouseup (which: 3) without PointerEvent or contextmenu', () => {
        const onNavigate = mountSortable();
        const host = container.querySelector('[data-row-host="S1"]')!;

        const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 77, clientY: 19 });
        Object.defineProperty(down, 'which', { value: 3 });
        const up = new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: 77, clientY: 19 });
        Object.defineProperty(up, 'which', { value: 3 });
        act(() => {
            host.dispatchEvent(down);
            host.dispatchEvent(up);
        });

        expect(document.querySelector('[data-menu-open="S1"]')?.getAttribute('data-menu-point')).toBe('77,19');
        expect(onNavigate).not.toHaveBeenCalled();
    });

    it('keeps contextHitOverlay connected as inert during hybrid mouse-hover -> touch-drag so implicit touch capture never detaches', () => {
        mountSortable();
        const label = container.querySelector('[data-row-label="S1"]')!;

        // 1. Magic Keyboard cursor hovers S1 first -> contextHitOverlay mounts.
        dispatchPointer(label, 'pointermove', { pointerType: 'mouse', buttons: 0, x: 48, y: 16 });
        const hitOverlay = container.querySelector<HTMLSpanElement>('[data-row-host="S1"] [data-lmc-context-hit]')!;
        expect(hitOverlay).not.toBeNull();
        expect(hitOverlay.getAttribute('data-lmc-context-hit')).toBe('');

        // 2. User touches S1 directly on the touchscreen to drag-reorder it.
        dispatchPointer(hitOverlay, 'pointerdown', { pointerType: 'touch', pointerId: 9, x: 48, y: 16 });
        expect(hitOverlay.isConnected).toBe(true);
        expect(hitOverlay.getAttribute('data-lmc-context-hit')).toBe('inert');
        expect(hitOverlay.style.userSelect).toBe('none');

        act(() => vi.advanceTimersByTime(SORT_HOLD_MS + 10));
        dispatchPointer(hitOverlay, 'pointermove', { pointerType: 'touch', pointerId: 9, x: 48, y: 88 });
        act(() => vi.advanceTimersByTime(TOUCH_MENU_HOLD_MS));
        expect(document.querySelector('[data-menu-open="S1"]')).toBeNull();

        dispatchPointer(hitOverlay, 'pointerup', { pointerType: 'touch', pointerId: 9, x: 48, y: 88 });
        act(() => vi.runAllTimers());

        expect(sync.applySettings).toHaveBeenCalledExactlyOnceWith({
            sessionProjectOrder: { 'lmc:macmini:claude': ['S2', 'S1'] },
        });
        expect(hitOverlay.isConnected).toBe(true);
        expect(hitOverlay.getAttribute('data-lmc-context-hit')).toBe('');
        expect(hitOverlay.style.userSelect).toBe('text');
    });

    it('suppresses adjacent mouse-hovered row selectstart when touch long-presses another row', () => {
        mountSortable();
        const s1Label = container.querySelector('[data-row-label="S1"]')!;
        const s2Label = container.querySelector('[data-row-label="S2"]')!;

        // 1. Magic Keyboard cursor leaves hover parked on S1.
        dispatchPointer(s1Label, 'pointermove', { pointerType: 'mouse', buttons: 0, x: 52, y: 18 });
        const s1Hit = container.querySelector<HTMLSpanElement>('[data-row-host="S1"] [data-lmc-context-hit]')!;
        expect(s1Hit).not.toBeNull();

        // 2. Finger touches S2; browser touch word-selector must not open S1 via selectstart.
        dispatchPointer(s2Label, 'pointerdown', { pointerType: 'touch', pointerId: 11, x: 52, y: 64 });
        expect(s1Hit.getAttribute('data-lmc-context-hit')).toBe('inert');

        const straySelectStart = new Event('selectstart', { bubbles: true, cancelable: true });
        act(() => {
            s1Hit.firstChild!.dispatchEvent(straySelectStart);
        });
        expect(straySelectStart.defaultPrevented).toBe(true);
        expect(document.querySelector('[data-menu-open="S1"]')).toBeNull();

        act(() => vi.advanceTimersByTime(TOUCH_MENU_HOLD_MS + 5));
        expect(document.querySelector('[data-menu-open="S1"]')).toBeNull();
        expect(document.querySelector('[data-menu-open="S2"]')).not.toBeNull();

        dispatchPointer(s2Label, 'pointerup', { pointerType: 'touch', pointerId: 11, x: 52, y: 64 });
        act(() => vi.runAllTimers());
    });

    it('does not wedge primaryPressActive when a touch pointerdown starts on S1 and lifts off-row', () => {
        const onNavigate = mountSortable();
        const s1Label = container.querySelector('[data-row-label="S1"]')!;
        const s2Label = container.querySelector('[data-row-label="S2"]')!;
        const s1Hit = container.querySelector<HTMLSpanElement>('[data-row-host="S1"] [data-lmc-context-hit]')!;
        vi.spyOn(s1Hit, 'getBoundingClientRect').mockReturnValue({
            left: 12,
            top: 0,
            right: 292,
            bottom: 48,
            width: 280,
            height: 48,
            x: 12,
            y: 0,
            toJSON: () => ({}),
        } as DOMRect);

        // Touch starts on S1 (button === 0 per W3C PointerEvents) and finger lifts on S2 + compatibility mouse events.
        dispatchPointer(s1Label, 'pointerdown', { pointerType: 'touch', pointerId: 21, button: 0, buttons: 1, x: 64, y: 20 });
        dispatchPointer(s2Label, 'pointerup', { pointerType: 'touch', pointerId: 21, button: 0, buttons: 0, x: 64, y: 68 });
        act(() => {
            s1Label.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 64, clientY: 20 }));
            s2Label.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 64, clientY: 68 }));
        });

        act(() => vi.advanceTimersByTime(150));
        expect(s1Hit.style.userSelect).toBe('text');

        // Stationary secondary-click selectstart on S1 must open S1's menu immediately.
        const selectStartEvent = new Event('selectstart', { bubbles: true, cancelable: true });
        act(() => {
            s1Hit.firstChild!.dispatchEvent(selectStartEvent);
        });
        expect(selectStartEvent.defaultPrevented).toBe(true);
        expect(document.querySelector('[data-menu-open="S1"]')?.getAttribute('data-menu-point')).toBe('60,24');
        expect(onNavigate).not.toHaveBeenCalled();
    });

    it('does not reopen menu 600ms after touch-dismissing a portaled SessionActionsPopover backdrop', () => {
        mountSortable();
        const s1Hit = container.querySelector<HTMLSpanElement>('[data-row-host="S1"] [data-lmc-context-hit]')!;
        const s1Label = container.querySelector('[data-row-label="S1"]')!;
        dispatchPointer(s1Label, 'pointermove', { pointerType: 'mouse', buttons: 0, x: 140, y: 24 });

        const selectStartEvent = new Event('selectstart', { bubbles: true, cancelable: true });
        act(() => {
            s1Hit.firstChild!.dispatchEvent(selectStartEvent);
        });
        const portalBackdrop = document.querySelector<HTMLElement>('[data-menu-open="S1"]')!;
        expect(portalBackdrop).not.toBeNull();

        // User taps the portaled backdrop at (1100, 220) on touchscreen to dismiss the menu.
        dispatchPointer(portalBackdrop, 'pointerdown', { pointerType: 'touch', pointerId: 33, button: 0, buttons: 1, x: 1100, y: 220 });
        dispatchPointer(portalBackdrop, 'pointerup', { pointerType: 'touch', pointerId: 33, button: 0, buttons: 0, x: 1100, y: 220 });
        act(() => {
            portalBackdrop.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 1100, clientY: 220 }));
        });
        expect(document.querySelector('[data-menu-open="S1"]')).toBeNull();

        // Advancing past TOUCH_MENU_HOLD_MS (600ms) must NOT reopen S1 at (1100, 220).
        act(() => vi.advanceTimersByTime(TOUCH_MENU_HOLD_MS + 100));
        expect(document.querySelector('[data-menu-open="S1"]')).toBeNull();
    });

    it('allows immediate secondary-click selectstart on a row right after left-clicking another UI button', () => {
        mountSortable();
        const otherButton = document.createElement('button');
        document.body.appendChild(otherButton);
        try {
            // Left-click "已归档" / "展开" button at t=0.
            dispatchPointer(otherButton, 'pointerdown', { pointerType: 'mouse', button: 0, buttons: 1, x: 40, y: 200 });
            dispatchPointer(otherButton, 'pointerup', { pointerType: 'mouse', button: 0, buttons: 0, x: 40, y: 200 });

            // 15ms later, user two-finger taps S2.
            act(() => vi.advanceTimersByTime(15));
            const s2Label = container.querySelector('[data-row-label="S2"]')!;
            const s2Hit = container.querySelector<HTMLSpanElement>('[data-row-host="S2"] [data-lmc-context-hit]')!;
            dispatchPointer(s2Label, 'pointermove', { pointerType: 'mouse', buttons: 0, x: 120, y: 68 });
            const selectStartEvent = new Event('selectstart', { bubbles: true, cancelable: true });
            act(() => {
                s2Hit.firstChild!.dispatchEvent(selectStartEvent);
            });
            expect(selectStartEvent.defaultPrevented).toBe(true);
            expect(document.querySelector('[data-menu-open="S2"]')?.getAttribute('data-menu-point')).toBe('120,68');
        } finally {
            otherButton.remove();
        }
    });

    it('detects iPadOS WebKit browsers (mobile UA and desktop-class Macintosh + touch) while excluding desktop Macs', () => {
        expect(shouldUseWebKitLinkContextProbe({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
            platform: 'MacIntel',
            maxTouchPoints: 5,
        })).toBe(true);
        expect(shouldUseWebKitLinkContextProbe({
            userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.0.0 Mobile/15E148 Safari/604.1',
            platform: 'iPad',
            maxTouchPoints: 5,
        })).toBe(true);
        expect(shouldUseWebKitLinkContextProbe({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            platform: 'MacIntel',
            maxTouchPoints: 0,
        })).toBe(false);
    });

    it('opens on iPadOS 17.4+/18/26 BrowserEngineKit secondary click via zero-net-change document selectionchange with zero pointer/contextmenu/selectstart events', () => {
        Object.defineProperty(window.navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
            configurable: true,
        });
        Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
        Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 5, configurable: true });

        const composer = document.createElement('textarea');
        composer.value = 'draft prompt';
        document.body.appendChild(composer);
        composer.focus();
        composer.setSelectionRange(2, 5);

        try {
            const onNavigate = mountSortable();
            // Advance past focusin guard after mounting.
            act(() => vi.advanceTimersByTime(60));

            const s1Hit = container.querySelector<HTMLAnchorElement>('[data-row-host="S1"] a[data-lmc-context-hit]')!;
            expect(s1Hit).not.toBeNull();
            expect(s1Hit.tagName).toBe('A');
            expect(s1Hit.getAttribute('href')).toBe('lmc-context:row');
            expect((s1Hit.style as any).WebkitTouchCallout).toBe('none');

            // 1. Trackpad pointer hovers S1 at (154, 27).
            dispatchPointer(s1Hit, 'pointermove', { pointerType: 'mouse', buttons: 0, x: 154, y: 27 });

            // 2. iPadOS BrowserEngineKit secondary click emits ZERO pointerdown/contextmenu/selectstart,
            // only TemporarySelectionChange -> document `selectionchange` with unchanged DOM & textarea selection.
            act(() => {
                document.dispatchEvent(new Event('selectionchange'));
            });

            expect(document.querySelector('[data-menu-open="S1"]')?.getAttribute('data-menu-point')).toBe('154,27');
            expect(document.activeElement).toBe(composer);
            expect(composer.selectionStart).toBe(2);
            expect(composer.selectionEnd).toBe(5);
            expect(onNavigate).not.toHaveBeenCalled();
        } finally {
            composer.remove();
        }
    });

    it('ignores real user transcript selection changes, textarea caret movement, and off-row link clicks while hovering a row on iPadOS', () => {
        Object.defineProperty(window.navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
            platform: 'MacIntel',
            configurable: true,
        } as PropertyDescriptor);
        Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 5, configurable: true });

        const transcript = document.createElement('div');
        transcript.textContent = 'assistant output';
        const externalLink = document.createElement('a');
        externalLink.href = 'https://example.com';
        externalLink.textContent = 'docs';
        const composer = document.createElement('textarea');
        composer.value = 'hello world';
        document.body.append(transcript, externalLink, composer);

        try {
            mountSortable();
            act(() => vi.advanceTimersByTime(60));
            const s1Hit = container.querySelector<HTMLAnchorElement>('[data-row-host="S1"] a[data-lmc-context-hit]')!;

            // Hover S1 first.
            dispatchPointer(s1Hit, 'pointermove', { pointerType: 'mouse', buttons: 0, x: 112, y: 22 });

            // Case 1: Real DOM text selection changes in transcript -> must NOT open S1 menu.
            act(() => {
                const range = document.createRange();
                range.selectNodeContents(transcript);
                const sel = window.getSelection()!;
                sel.removeAllRanges();
                sel.addRange(range);
                document.dispatchEvent(new Event('selectionchange'));
            });
            expect(document.querySelector('[data-menu-open="S1"]')).toBeNull();

            // Case 2: Textarea focused and caret moved -> must NOT open S1 menu.
            act(() => {
                composer.focus();
                composer.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
                vi.advanceTimersByTime(60);
                composer.setSelectionRange(1, 4);
                document.dispatchEvent(new Event('selectionchange'));
            });
            expect(document.querySelector('[data-menu-open="S1"]')).toBeNull();

            // Case 3: Pointer moves off S1 onto an external link in transcript at (620, 310),
            // and right-clicking that external link fires phantom selectionchange -> must NOT open S1 menu.
            Object.defineProperty(document, 'elementFromPoint', {
                value: (x: number, y: number) => (x === 620 && y === 310 ? externalLink : s1Hit),
                configurable: true,
            });
            dispatchPointer(s1Hit, 'pointerleave', { pointerType: 'mouse', buttons: 0, x: 620, y: 310 });
            dispatchPointer(externalLink, 'pointermove', { pointerType: 'mouse', buttons: 0, x: 620, y: 310 });
            act(() => {
                document.dispatchEvent(new Event('selectionchange'));
            });
            expect(document.querySelector('[data-menu-open="S1"]')).toBeNull();
        } finally {
            window.getSelection()?.removeAllRanges();
            delete (document as any).elementFromPoint;
            transcript.remove();
            externalLink.remove();
            composer.remove();
        }
    });

    it('strips href during finger touch gestures on iPadOS and restores href afterwards while keeping primary click navigation intact', () => {
        Object.defineProperty(window.navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
            configurable: true,
        });
        Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
        Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 5, configurable: true });

        const onNavigate = mountSortable();
        const s1Hit = container.querySelector<HTMLAnchorElement>('[data-row-host="S1"] a[data-lmc-context-hit]')!;
        expect(s1Hit.getAttribute('href')).toBe('lmc-context:row');

        // Touch start strips href synchronously so WebKit touch callout never probes it as a link.
        dispatchPointer(s1Hit, 'pointerdown', { pointerType: 'touch', pointerId: 41, x: 60, y: 20 });
        expect(s1Hit.hasAttribute('href')).toBe(false);
        expect(s1Hit.getAttribute('data-lmc-context-hit')).toBe('inert');

        dispatchPointer(s1Hit, 'pointerup', { pointerType: 'touch', pointerId: 41, x: 60, y: 20 });
        act(() => vi.advanceTimersByTime(180));
        expect(s1Hit.getAttribute('href')).toBe('lmc-context:row');

        // Primary mouse click on <a href="lmc-context:row"> prevents browser link navigation while firing Pressable.onPress!
        dispatchPointer(s1Hit, 'pointerdown', { pointerType: 'mouse', button: 0, buttons: 1, x: 90, y: 24 });
        dispatchPointer(s1Hit, 'pointerup', { pointerType: 'mouse', button: 0, buttons: 0, x: 90, y: 24 });
        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, clientX: 90, clientY: 24, detail: 1 });
        act(() => {
            s1Hit.dispatchEvent(clickEvent);
        });
        expect(clickEvent.defaultPrevented).toBe(true);
        expect(onNavigate).toHaveBeenCalledTimes(1);
    });

    it('does not bounce-reopen menu when hybrid touch backdrop tap emits compatibility mousemove + click + modal-unmount selectionchange', () => {
        Object.defineProperty(window.navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
            configurable: true,
        });
        Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
        Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 5, configurable: true });

        mountSortable();
        act(() => vi.advanceTimersByTime(60));
        const s1Hit = container.querySelector<HTMLAnchorElement>('[data-row-host="S1"] a[data-lmc-context-hit]')!;

        // 1. Trackpad pointer hovers S1 and secondary-click selectionchange opens S1 menu.
        dispatchPointer(s1Hit, 'pointermove', { pointerType: 'mouse', buttons: 0, x: 154, y: 27 });
        act(() => {
            document.dispatchEvent(new Event('selectionchange'));
        });
        const portalBackdrop = document.querySelector<HTMLElement>('[data-menu-open="S1"]')!;
        expect(portalBackdrop).not.toBeNull();

        // 2. User taps the backdrop with a finger: touchstart -> touchend -> compatibility pointermove(mouse) -> click -> modal unmount selectionchange.
        act(() => {
            const touchPoint = { identifier: 7, clientX: 560, clientY: 420, pageX: 560, pageY: 420, target: portalBackdrop };
            const touchStart = new Event('touchstart', { bubbles: true, cancelable: true });
            Object.defineProperty(touchStart, 'touches', { value: [touchPoint] });
            Object.defineProperty(touchStart, 'targetTouches', { value: [touchPoint] });
            Object.defineProperty(touchStart, 'changedTouches', { value: [touchPoint] });
            portalBackdrop.dispatchEvent(touchStart);

            const touchEnd = new Event('touchend', { bubbles: true, cancelable: true });
            Object.defineProperty(touchEnd, 'touches', { value: [] });
            Object.defineProperty(touchEnd, 'targetTouches', { value: [] });
            Object.defineProperty(touchEnd, 'changedTouches', { value: [touchPoint] });
            portalBackdrop.dispatchEvent(touchEnd);
        });
        dispatchPointer(portalBackdrop, 'pointermove', { pointerType: 'mouse', buttons: 0, x: 560, y: 420 });
        act(() => {
            portalBackdrop.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 560, clientY: 420 }));
            document.dispatchEvent(new Event('selectionchange'));
        });

        expect(document.querySelector('[data-menu-open="S1"]')).toBeNull();

        // 3. Even after touch suppression releases (200ms later), real trackpad hover + secondary click works again immediately!
        act(() => vi.advanceTimersByTime(200));
        const s1HitReMounted = container.querySelector<HTMLAnchorElement>('[data-row-host="S1"] a[data-lmc-context-hit]')!;
        dispatchPointer(s1HitReMounted, 'pointermove', { pointerType: 'mouse', buttons: 0, x: 160, y: 28 });
        act(() => {
            document.dispatchEvent(new Event('selectionchange'));
        });
        expect(document.querySelector('[data-menu-open="S1"]')?.getAttribute('data-menu-point')).toBe('160,28');
    });

    it('preserves registeredHitOverlays when replacing all rows in one React commit (passive effect cleanup before mount)', () => {
        Object.defineProperty(window.navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
            configurable: true,
        });
        Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
        Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 5, configurable: true });

        // First render mounts only tree A (globalListenerRefs = 1).
        act(() => {
            root.render(React.createElement('div', { key: 'tree-a' }, React.createElement(RowItem, { id: 'OLD_HUB', onNavigate: vi.fn() })));
        });

        // Second render unmounts tree A and mounts completely new tree B in the same commit:
        // React attaches tree B's refs during commit BEFORE running tree A's passive useEffect cleanup.
        act(() => {
            root.render(React.createElement('div', { key: 'tree-b' }, React.createElement(RowItem, { id: 'NEW_ENGINE', onNavigate: vi.fn() })));
            vi.advanceTimersByTime(60);
        });

        const newHit = container.querySelector<HTMLAnchorElement>('[data-row-host="NEW_ENGINE"] a[data-lmc-context-hit]')!;
        expect(newHit).not.toBeNull();
        dispatchPointer(newHit, 'pointermove', { pointerType: 'mouse', buttons: 0, x: 88, y: 34 });
        act(() => {
            document.dispatchEvent(new Event('selectionchange'));
        });
        expect(document.querySelector('[data-menu-open="NEW_ENGINE"]')?.getAttribute('data-menu-point')).toBe('88,34');
    });

    it('omits href on desktop browsers (maxTouchPoints === 0) so hovering rows never shows a browser URL status pill', () => {
        Object.defineProperty(window.navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            configurable: true,
        });
        Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
        Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 0, configurable: true });

        mountSortable();
        const s1Hit = container.querySelector<HTMLAnchorElement>('[data-row-host="S1"] a[data-lmc-context-hit]')!;
        expect(s1Hit.hasAttribute('href')).toBe(false);
        expect(s1Hit.hasAttribute('title')).toBe(false);
    });
});
