import * as React from 'react';
import { sync } from '@/sync/sync';
import { useSetting } from '@/sync/storage';
import { orderSessions, moveSession } from '@/sync/sessionOrder';
import { holdReleaseIntent, SORT_HOLD_MS, touchSortIntent } from '@/utils/sessionSortGesture';
import type { SortableHubGroupsProps } from './SortableHubGroups';

/**
 * Same architecture as `SortableSessionRows.web.tsx` — a root that tracks the
 * pointer and per-item boxes for the shift animation. The root delegates
 * pointer-down only from a marked hub header: RN Web's Pressable filters out
 * onPointerDownCapture, so the handler must live on a real DOM element.
 * Worker rows keep their own sortable/bind gesture.
 */
type Drag = { id: string; pointer: number; from: number; to: number; dy: number; grab: number; y: number; phase: 'drag' | 'drop'; boxes: { id: string; top: number; height: number }[] };

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
    const [held, setHeld] = React.useState<string | null>(null);
    const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    // A completed drag's pointerup can still fire the header's own onPress as
    // a trailing click; swallow one click after any drag/hold so releasing
    // over the group never also navigates to its hub.
    const suppressClick = React.useRef(false);
    const clickTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const blockClick = () => { suppressClick.current = true; if (clickTimer.current) clearTimeout(clickTimer.current); clickTimer.current = setTimeout(() => { suppressClick.current = false; }, 700); };
    const update = (next: Drag | null) => { current.current = next; setDrag(next); };
    const save = (id: string, target: string, after: boolean) => sync.applySettings({ sessionProjectOrder: { [storageKey]: moveSession(latestRows.current.map((r) => r.id), id, target, after) } });
    const clearTouch = () => { if (holdTimer.current) clearTimeout(holdTimer.current); touch.current = null; setHeld(null); };

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
        const centre = top + d.boxes[d.from].height / 2;
        const to = d.boxes.filter((b, i) => i !== d.from && centre > b.top + b.height / 2).length;
        update({ ...d, y, to, dy: top - d.boxes[d.from].top });
    };
    const finish = (commit: boolean) => {
        const d = current.current; if (!d || d.phase !== 'drag') return;
        const to = commit ? d.to : d.from;
        const target = d.boxes[to];
        const top = to > d.from ? target.top + target.height - d.boxes[d.from].height : target.top;
        update({ ...d, to, phase: 'drop', dy: top - d.boxes[d.from].top });
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        timer.current = setTimeout(() => {
            if (commit && to !== d.from) save(d.id, target.id, to > d.from);
            update(null); timer.current = null;
        }, reduced ? 0 : 180);
    };

    React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); if (holdTimer.current) clearTimeout(holdTimer.current); if (clickTimer.current) clearTimeout(clickTimer.current); }, []);
    React.useEffect(() => {
        const node = root.current; if (!node) return;
        const prevent = (e: TouchEvent) => { if (touch.current?.armed || current.current) e.preventDefault(); };
        node.addEventListener('touchmove', prevent, { passive: false });
        return () => node.removeEventListener('touchmove', prevent);
    }, []);
    const rowKey = JSON.stringify(rows.map((r) => r.id));
    React.useEffect(() => {
        const d = current.current;
        if (d && JSON.stringify(d.boxes.map((b) => b.id)) !== rowKey) { if (timer.current) clearTimeout(timer.current); update(null); }
    }, [rowKey]);

    React.useEffect(() => {
        if (drag?.phase !== 'drag') return;
        const cancelOnEscape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || current.current?.phase !== 'drag') return;
            event.preventDefault();
            clearTouch();
            finish(false);
        };
        // A pointer drag need not focus its header; listen beyond the sorter.
        window.addEventListener('keydown', cancelOnEscape);
        return () => window.removeEventListener('keydown', cancelOnEscape);
    }, [drag?.phase]);

    // Spread onto the one element that should pick a group up. The same
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
                if (current.current || e.isPrimary === false || e.button !== 0) return;
                const target = e.target as HTMLElement;
                const handle = target.closest<HTMLElement>('[data-hub-sort-id]');
                if (!handle || !e.currentTarget.contains(handle)) return;
                // The header's nested menu button is a control, not a handle.
                const control = target.closest('button, [role="button"], input, textarea, select, a');
                if (control && control !== handle && handle.contains(control)) return;
                const id = handle.dataset.hubSortId;
                if (!id || !latestRows.current.some((row) => row.id === id)) return;
                clearTouch(); suppressClick.current = false;
                touch.current = { id, pointer: e.pointerId, x: e.clientX, y: e.clientY, armed: false, target, pointerType: e.pointerType };
                holdTimer.current = setTimeout(() => { const p = touch.current; if (p) { p.armed = true; setHeld(p.id); } }, SORT_HOLD_MS);
            }}
            onClickCapture={(e) => { if (suppressClick.current) { e.preventDefault(); e.stopPropagation(); } }}
            onContextMenuCapture={(e) => { if (touch.current?.armed || current.current) { e.preventDefault(); e.stopPropagation(); } }}
            onPointerMove={(e) => {
                const p = touch.current;
                if (p && p.pointer === e.pointerId && !current.current) {
                    const intent = touchSortIntent(p.armed, Math.hypot(e.clientX - p.x, e.clientY - p.y), false);
                    if (intent === 'scroll') clearTouch();
                    else if (intent === 'drag') { blockClick(); begin(p.id, p.pointer, p.y); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }
                }
                if (e.pointerId === current.current?.pointer) move(e.clientY);
            }}
            onPointerUp={(e) => {
                const p = touch.current;
                if (e.pointerId === current.current?.pointer) { blockClick(); finish(true); }
                else if (p?.pointer === e.pointerId && p.armed) {
                    blockClick();
                    if (holdReleaseIntent(p.pointerType, p.armed) === 'menu') {
                        // A held touch released without becoming a drag: the
                        // sortable system intercepted it before useSessionRowMenu's
                        // own long-press could open the header's context menu, so
                        // replay it as a genuine contextmenu event, same as a row.
                        const target = p.target; const x = p.x, y = p.y;
                        setTimeout(() => { if (target.isConnected) target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y })); }, 0);
                    }
                }
                clearTouch();
            }}
            onPointerCancel={() => { clearTouch(); finish(false); }}
            onLostPointerCapture={(e) => { if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) finish(false); }}
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
                        data-sort-active={selected || held === row.id}
                        style={{
                            position: 'relative',
                            zIndex: selected ? 2 : 0,
                            transform: `translateY(${shift}px)`,
                            transition: selected && drag?.phase === 'drag' ? 'box-shadow 150ms ease' : 'transform 180ms cubic-bezier(.2,.8,.2,1), box-shadow 180ms ease',
                        } as React.CSSProperties}
                    >
                        {renderItem(row.item, handleProps(row.id))}
                    </div>
                );
            })}
        </div>
    );
}
