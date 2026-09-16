/**
 * Coordinate and pointer-kind helpers shared by press handlers.
 *
 * Deliberately free of react-native imports so the logic stays unit testable:
 * importing `react-native` pulls Flow syntax that the test runner cannot parse.
 */

// Mirrors react-native-web's getTouchFromResponderEvent: a TouchEvent carries
// the coordinates on its touch list, a PointerEvent carries them directly.
export function readEventPoint(event: any): { x: number; y: number } {
    const ne = event?.nativeEvent;
    const source = ne?.touches?.[0] ?? ne?.changedTouches?.[0] ?? ne;
    return {
        x: source?.clientX ?? source?.pageX ?? 0,
        y: source?.clientY ?? source?.pageY ?? 0,
    };
}

// A desktop browser already opens context menus on right click, so long press
// must stay touch-only there: holding the mouse button down should not pop a
// menu mid-drag or mid-selection.
export function isTouchInteraction(event: any): boolean {
    const ne = event?.nativeEvent;
    if (typeof ne?.pointerType === 'string') {
        return ne.pointerType !== 'mouse';
    }
    if (typeof ne?.touches?.length === 'number') {
        return ne.touches.length > 0;
    }
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        return window.matchMedia('(hover: none)').matches;
    }
    return false;
}
