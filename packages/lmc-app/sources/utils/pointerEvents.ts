/**
 * Coordinate and pointer-kind helpers shared by press handlers.
 *
 * Deliberately free of react-native imports so the logic stays unit testable:
 * importing `react-native` pulls Flow syntax that the test runner cannot parse.
 */

// Mirrors react-native-web's getTouchFromResponderEvent: a TouchEvent carries
// the coordinates on its touch list, a PointerEvent carries them directly.
export function readEventPoint(event: any): { x: number; y: number } {
    const ne = event?.nativeEvent ?? event;
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
    const ne = event?.nativeEvent ?? event;
    if (typeof ne?.pointerType === 'string') {
        return ne.pointerType !== 'mouse';
    }
    if (typeof ne?.touches?.length === 'number') {
        return ne.touches.length > 0 || (typeof ne?.changedTouches?.length === 'number' && ne.changedTouches.length > 0);
    }
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        return window.matchMedia('(hover: none)').matches;
    }
    return false;
}

// Secondary pointer/mouse press used on iPadOS WebKit (WKWebView), where
// external mouse right-click, Magic Keyboard two-finger click, or Ctrl+click
// dispatches pointerdown/pointerup without reliably firing a DOM contextmenu event.
export function isSecondaryPressEvent(event: any): boolean {
    const ne = event?.nativeEvent ?? event;
    if (!ne) return false;
    if (ne.button === 2 || ne.buttons === 2 || ne.which === 3) {
        return true;
    }
    if (
        ne.ctrlKey === true
        && (ne.button === 0 || ne.button == null)
        && ne.pointerType !== 'touch'
        && ne.pointerType !== 'pen'
    ) {
        return true;
    }
    return false;
}
