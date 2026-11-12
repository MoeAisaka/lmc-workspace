import * as React from 'react';
import { sync } from '@/sync/sync';
import { useSetting } from '@/sync/storage';
import { orderSessions, moveSession } from '@/sync/sessionOrder';
import { holdReleaseIntent, pointerSortIntent, SORT_HOLD_MS, TOUCH_MENU_HOLD_MS } from '@/utils/sessionSortGesture';
import type { SortableHubGroupsProps } from './SortableHubGroups';

/**
 * Same architecture as `SortableSessionRows.web.tsx` — a root that tracks the
 * pointer and per-item boxes for the shift animation. The root delegates
 * pointer-down from the header and surrounding group space: RN Web's
 * Pressable filters out onPointerDownCapture, so the handler lives on a real
 * DOM element. Worker rows keep their own sortable/bind gesture.
 */
type Box = { id: string; top: number; height: number };
type Drag = { id: string; pointer: number; from: number; to: number; dy: number; grab: number; y: number; phase: 'drag' | 'drop'; boxes: Box[] };

function computeTargetSlot(boxes: Box[], from: number, top: number): number {
    const origin = boxes[from];
    const dy = top - origin.top;
    if (dy > 0) {
        const bottom = top + origin.height;
        let passed = 0;
        for (let i = from + 1; i < boxes.length; i++) {
            if (bottom > boxes[i].top + boxes[i].height / 2) passed++;
        }
        return from + passed;
    }
    if (dy < 0) {
        let passed = 0;
        for (let i = 0; i < from; i++) {
            if (top < boxes[i].top + boxes[i].height / 2) passed++;
        }
        return from - passed;
    }
    return from;
}

export function SortableHubGroups<T>({ storageKey, items, getId, renderItem }: SortableHubGroupsProps<T>) {
    const orders = useSetting('sessionProjectOrder');
    const idOf = React.useCallback((item: T) => ({ id: getId(item), item }), [getId]);
    const rows = orderSessions(items.map(idOf), orders[storageKey]);
    const root = React.useRef<HTMLDivElement>(null);
    const elements = React.useRef(new Map<string, HTMLDivElement>());
    const [drag, setDrag] = React.useState<Drag | null>(null);
    const current = React.useRef<Drag | null>(null);
    const latestRows = React.useRef(rows); latestRows.current = rows;
    const touch = React.useRef<{ id: string; pointer: number; x: number; y: number; armed: boolean; target: HTMLElement; pointerType: string } | null>(null);
    const holdTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const menuTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const [held, setHeld] = React.useState<string | null>(null);
    const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingCommit = React.useRef<(() => void) | null>(null);
    const lastHandledEvent = React.useRef<Event | null>(null);
    const detachWindowGesture = React.useRef<(() => void) | null>(null);
    // A completed drag's pointerup can still fire the header's own onPress as
    // a trailing click; swallow one click after any drag/hold so releasing
    // over the group never also navigates to its hub.
    const suppressClick = React.useRef(false);
    const clickTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearBlockClick = () => { suppressClick.current = false; if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; } };
    const blockClick = () => { suppressClick.current = true; if (clickTimer.current) clearTimeout(clickTimer.current); clickTimer.current = setTimeout(() => { suppressClick.current = false; clickTimer.current = null; }, 700); };
    const stopWindowListenersIfIdle = () => {
        if (!touch.current && current.current?.phase !== 'drag' && detachWindowGesture.current) {
            detachWindowGesture.current();
            detachWindowGesture.current = null;
        }
    };
    const flushPendingCommit = () => { const fn = pendingCommit.current; pendingCommit.current = null; fn?.(); };
    const update = (next: Drag | null) => { current.current = next; setDrag(next); if (next?.phase !== 'drag') stopWindowListenersIfIdle(); };
    const save = (id: string, target: string, after: boolean) => sync.applySettings({ sessionProjectOrder: { [storageKey]: moveSession(latestRows.current.map((r) => r.id), id, target, after) } });
    const clearMenuTimer = () => { if (menuTimer.current) { clearTimeout(menuTimer.current); menuTimer.current = null; } };
    const clearTouch = () => { if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; } clearMenuTimer(); touch.current = null; setHeld(null); stopWindowListenersIfIdle(); };
    const openHubMenu = (id: string, target: HTMLElement, x: number, y: number) => {
        const groupNode = elements.current.get(id);
        const headerNode = groupNode?.querySelector<HTMLElement>('[data-session-sort-id][data-hub-sort-id]');
        const receiver = (target.isConnected && headerNode?.contains(target) ? target : null)
            ?? headerNode
            ?? (target.isConnected && target.closest('[role="button"]') ? target : null)
            ?? (target.isConnected ? target : groupNode ?? null);
        receiver?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    };

    const begin = (id: string, pointer: number, y: number) => {
        if (current.current || !root.current) return;
        const from = latestRows.current.findIndex((r) => r.id === id); if (from < 0) return;
        const rootTop = root.current.getBoundingClientRect().top;
        const boxes = latestRows.current.map((r) => { const b = elements.current.get(r.id)!.getBoundingClientRect(); return { id: r.id, top: b.top - rootTop, height: b.height }; });
        update({ id, pointer, from, to: from, dy: 0, grab: y - rootTop - boxes[from].top, y, phase: 'drag', boxes });
    };
    const move = (y: number) => {
        const d = current.current; if (!d || d.phase !== 'drag' || !root.current) return;
        const top = y - d.grab - root.current.getBoundingClientRect().top;
        const to = computeTargetSlot(d.boxes, d.from, top);
        update({ ...d, y, to, dy: top - d.boxes[d.from].top });
    };
    const finish = (commit: boolean) => {
        const d = current.current; if (!d || d.phase !== 'drag') return;
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        const to = commit ? d.to : d.from;
        const target = d.boxes[to];
        const top = to > d.from ? target.top + target.height - d.boxes[d.from].height : target.top;
        pendingCommit.current = commit && to !== d.from ? () => save(d.id, target.id, to > d.from) : null;
        update({ ...d, to, phase: 'drop', dy: top - d.boxes[d.from].top });
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        timer.current = setTimeout(() => {
            timer.current = null;
            flushPendingCommit();
            update(null);
        }, reduced ? 0 : 180);
    };

    const handlePointerMoveRef = React.useRef<(pointerId: number, clientX: number, clientY: number, captureHost: HTMLElement | null) => boolean>(() => false);
    handlePointerMoveRef.current = (pointerId, clientX, clientY, captureHost) => {
        const p = touch.current;
        if (p && p.pointer === pointerId && !current.current) {
            const intent = pointerSortIntent(p.pointerType, p.armed, Math.hypot(clientX - p.x, clientY - p.y), false);
            if (intent === 'scroll') clearTouch();
            else if (intent === 'drag') {
                clearMenuTimer();
                blockClick();
                begin(p.id, p.pointer, p.y);
                if (captureHost) { try { captureHost.setPointerCapture(pointerId); } catch {} }
            }
        }
        if (pointerId === current.current?.pointer) {
            move(clientY);
            return true;
        }
        return false;
    };

    const handlePointerUpRef = React.useRef<(pointerId: number) => void>(() => {});
    handlePointerUpRef.current = (pointerId) => {
        const p = touch.current;
        if (pointerId === current.current?.pointer) {
            blockClick();
            finish(true);
            clearTouch();
            return;
        }
        if (p?.pointer === pointerId) {
            if (p.armed) {
                blockClick();
                if (holdReleaseIntent(p.pointerType, p.armed) === 'menu') {
                    // A held touch released before TOUCH_MENU_HOLD_MS without
                    // becoming a drag: replay it as a contextmenu event on the hub header.
                    const id = p.id; const target = p.target; const x = p.x, y = p.y;
                    setTimeout(() => { openHubMenu(id, target, x, y); }, 0);
                }
            }
            clearTouch();
        }
    };

    const handlePointerCancelRef = React.useRef<(pointerId: number) => void>(() => {});
    handlePointerCancelRef.current = (pointerId) => {
        if (pointerId === current.current?.pointer || pointerId === touch.current?.pointer) {
            clearTouch();
            finish(false);
        }
    };

    const ensureWindowGestureListeners = () => {
        if (detachWindowGesture.current || typeof window === 'undefined') return;
        const onWinMove = (ev: PointerEvent) => { if (lastHandledEvent.current === ev) return; handlePointerMoveRef.current(ev.pointerId, ev.clientX, ev.clientY, root.current); };
        const onWinUp = (ev: PointerEvent) => { if (lastHandledEvent.current === ev) return; handlePointerUpRef.current(ev.pointerId); };
        const onWinCancel = (ev: PointerEvent) => { if (lastHandledEvent.current === ev) return; handlePointerCancelRef.current(ev.pointerId); };
        const onWinBlur = () => { clearTouch(); finish(false); };
        window.addEventListener('pointermove', onWinMove);
        window.addEventListener('pointerup', onWinUp);
        window.addEventListener('pointercancel', onWinCancel);
        window.addEventListener('blur', onWinBlur);
        detachWindowGesture.current = () => {
            window.removeEventListener('pointermove', onWinMove);
            window.removeEventListener('pointerup', onWinUp);
            window.removeEventListener('pointercancel', onWinCancel);
            window.removeEventListener('blur', onWinBlur);
        };
    };

    React.useEffect(() => () => {
        if (detachWindowGesture.current) { detachWindowGesture.current(); detachWindowGesture.current = null; }
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        flushPendingCommit();
        if (holdTimer.current) clearTimeout(holdTimer.current);
        if (menuTimer.current) clearTimeout(menuTimer.current);
        if (clickTimer.current) clearTimeout(clickTimer.current);
    }, []);
    React.useEffect(() => {
        const node = root.current; if (!node) return;
        const prevent = (e: TouchEvent) => { if (touch.current?.armed || current.current) e.preventDefault(); };
        node.addEventListener('touchmove', prevent, { passive: false });
        return () => node.removeEventListener('touchmove', prevent);
    }, []);
    const rowKey = JSON.stringify(rows.map((r) => r.id));
    React.useEffect(() => {
        const d = current.current;
        if (d && JSON.stringify(d.boxes.map((b) => b.id)) !== rowKey) {
            if (timer.current) { clearTimeout(timer.current); timer.current = null; }
            if (d.phase === 'drop') flushPendingCommit();
            else pendingCommit.current = null;
            update(null);
        }
    }, [rowKey]);

    React.useEffect(() => {
        if (drag?.phase !== 'drag') return;
        const cancelOnEscape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || current.current?.phase !== 'drag') return;
            event.preventDefault();
            clearTouch();
            finish(false);
        };
        const syncOnScroll = () => {
            const d = current.current;
            if (d?.phase === 'drag') move(d.y);
        };
        // A pointer drag need not focus its header; listen beyond the sorter.
        window.addEventListener('keydown', cancelOnEscape);
        window.addEventListener('scroll', syncOnScroll, { capture: true, passive: true });
        let frame = 0;
        if (drag.pointer !== -1) {
            const tick = () => {
                const d = current.current; if (!d || d.phase !== 'drag') return;
                let scroll: HTMLElement | null = root.current;
                while (scroll && (scroll.scrollHeight <= scroll.clientHeight || !/(auto|scroll)/.test(getComputedStyle(scroll).overflowY))) scroll = scroll.parentElement;
                if (scroll) {
                    const box = scroll.getBoundingClientRect(); const before = scroll.scrollTop;
                    if (d.y < box.top + 44) scroll.scrollTop -= 8;
                    else if (d.y > box.bottom - 44) scroll.scrollTop += 8;
                    if (scroll.scrollTop !== before) move(d.y);
                }
                frame = requestAnimationFrame(tick);
            };
            frame = requestAnimationFrame(tick);
        }
        return () => {
            window.removeEventListener('keydown', cancelOnEscape);
            window.removeEventListener('scroll', syncOnScroll, true);
            if (frame) cancelAnimationFrame(frame);
        };
    }, [drag?.phase]);

    // Mark the navigation header separately from the wider group area so it
    // remains a drag handle despite being a button itself. The same
    // `data-session-sort-id` marker the row-level sorter uses tells
    // useSessionRowMenu's touch handling to stand down for this press too, so
    // a long-press on the hub header drags the group instead of opening its
    // context menu.
    const handleProps = React.useCallback((id: string): Record<string, unknown> => ({
        dataSet: { sessionSortId: id, hubSortId: id },
    }), []);

    return (
        <div
            ref={root}
            style={{ position: 'relative' }}
            onPointerDownCapture={(e) => {
                if (current.current || e.isPrimary === false || e.button !== 0 || e.ctrlKey) return;
                if (e.currentTarget.contains(e.target as Node)) clearBlockClick();
                const target = e.target as HTMLElement;
                const handle = target.closest<HTMLElement>('[data-hub-sort-id]');
                if (!handle || !e.currentTarget.contains(handle)) return;
                const id = handle.dataset.hubSortId;
                if (!id || !latestRows.current.some((row) => row.id === id)) return;
                // Worker padding is also part of its own sortable row, even
                // where there is no button. Never start both sorters at once.
                const rowHandle = target.closest<HTMLElement>('[data-session-sort-id]');
                if (rowHandle && rowHandle.dataset.hubSortId !== id) return;
                // Nested controls keep their normal click/press behavior.
                const control = target.closest('button, [role="button"], input, textarea, select, a:not([data-lmc-context-hit])');
                if (control && control !== handle && handle.contains(control)) return;
                clearTouch();
                const p = { id, pointer: e.pointerId, x: e.clientX, y: e.clientY, armed: false, target, pointerType: e.pointerType };
                touch.current = p;
                ensureWindowGestureListeners();
                holdTimer.current = setTimeout(() => { if (touch.current === p) { p.armed = true; setHeld(p.id); } }, SORT_HOLD_MS);
                if (holdReleaseIntent(e.pointerType, true) === 'menu') {
                    menuTimer.current = setTimeout(() => {
                        if (touch.current !== p || current.current) return;
                        const { id: hubId, target: menuTarget, x, y } = p;
                        blockClick(); clearTouch();
                        openHubMenu(hubId, menuTarget, x, y);
                    }, TOUCH_MENU_HOLD_MS);
                }
            }}
            onClickCapture={(e) => { if (suppressClick.current && e.currentTarget.contains(e.target as Node)) { clearBlockClick(); e.preventDefault(); e.stopPropagation(); } }}
            onContextMenuCapture={(e) => { if (touch.current?.armed || current.current) { e.preventDefault(); e.stopPropagation(); } }}
            onPointerMove={(e) => {
                lastHandledEvent.current = e.nativeEvent;
                if (handlePointerMoveRef.current(e.pointerId, e.clientX, e.clientY, e.currentTarget as HTMLElement)) e.stopPropagation();
            }}
            onPointerUp={(e) => {
                lastHandledEvent.current = e.nativeEvent;
                handlePointerUpRef.current(e.pointerId);
            }}
            onPointerCancel={(e) => {
                lastHandledEvent.current = e.nativeEvent;
                handlePointerCancelRef.current(e.pointerId);
            }}
        >
            {drag && drag.to !== drag.from && (
                <div aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0, height: 2, background: '#0060F0', zIndex: 3, pointerEvents: 'none', top: drag.to > drag.from ? drag.boxes[drag.to].top + drag.boxes[drag.to].height : drag.boxes[drag.to].top }} />
            )}
            {rows.map((row, index) => {
                const selected = drag?.id === row.id;
                const shift = drag ? (selected ? drag.dy : index > drag.from && index <= drag.to ? -drag.boxes[drag.from].height : index < drag.from && index >= drag.to ? drag.boxes[drag.from].height : 0) : 0;
                return (
                    <div
                        key={row.id}
                        ref={(node) => { if (node) elements.current.set(row.id, node); else elements.current.delete(row.id); }}
                        data-hub-sort-id={row.id}
                        data-yulor-reorder="group"
                        data-sort-active={selected || held === row.id}
                        style={{
                            // Include the group's outer margins in measured drag geometry.
                            // Otherwise collapsed margins leave neighbours one gap short.
                            display: 'flow-root',
                            position: 'relative',
                            userSelect: 'none',
                            WebkitUserSelect: 'none',
                            WebkitTouchCallout: 'none',
                            pointerEvents: selected && drag?.phase === 'drag' ? 'none' : undefined,
                            zIndex: selected ? 2 : 0,
                            transform: `translateY(${shift}px)`,
                            // Once DOM order commits, reset transforms without replaying the drop.
                            transition: !drag || (selected && drag.phase === 'drag') ? 'box-shadow 150ms ease' : 'transform 180ms cubic-bezier(.2,.8,.2,1), box-shadow 180ms ease',
                        } as React.CSSProperties}
                    >
                        {renderItem(row.item, handleProps(row.id))}
                    </div>
                );
            })}
        </div>
    );
}
