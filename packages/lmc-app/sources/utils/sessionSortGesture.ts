export const SORT_HOLD_MS = 350;
export function touchSortIntent(armed: boolean, distance: number, released: boolean) {
    if (distance > 8) return armed ? 'drag' : 'scroll';
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
