export const SORT_HOLD_MS = 350;
// Stationary touch/pen hold threshold that opens the context menu while the
// finger is still down (standard iPadOS UX), leaving the 350ms–600ms window to
// start a drag-reorder as soon as the finger moves past slop.
export const TOUCH_MENU_HOLD_MS = 600;
export const MOUSE_SORT_SLOP_PX = 8;
export const TOUCH_SORT_SLOP_PX = 12;

export function sortSlopForPointer(pointerType: string): number {
    return pointerType === 'mouse' ? MOUSE_SORT_SLOP_PX : TOUCH_SORT_SLOP_PX;
}

export function touchSortIntent(armed: boolean, distance: number, released: boolean, slop: number = MOUSE_SORT_SLOP_PX) {
    if (distance > slop) return armed ? 'drag' : 'scroll';
    if (released) return armed ? 'menu' : 'tap';
    return armed ? 'hold' : 'tap';
}

/**
 * What releasing a held row means.
 *
 * A finger has no right click and cannot reach a button that only appears on
 * hover, so holding and releasing is the one gesture left to stand in for
 * both — it opens the menu. A mouse has both already, so holding one means the
 * drag it looks like, and releasing without moving cancels it rather than
 * producing a menu nobody asked for.
 */
export function holdReleaseIntent(pointerType: string, armed: boolean): 'menu' | 'cancel' | 'tap' {
    if (!armed) return 'tap';
    return pointerType === 'mouse' ? 'cancel' : 'menu';
}
