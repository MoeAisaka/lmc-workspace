import { describe, it, expect, afterEach } from 'vitest';
import { isSecondaryPressEvent, isTouchInteraction, readEventPoint } from './pointerEvents';

const originalMatchMedia = (globalThis as any).window;

afterEach(() => {
    (globalThis as any).window = originalMatchMedia;
});

function setMatchMedia(hoverNone: boolean | null) {
    if (hoverNone === null) {
        delete (globalThis as any).window;
        return;
    }
    (globalThis as any).window = {
        matchMedia: (query: string) => ({ matches: query === '(hover: none)' ? hoverNone : false }),
    };
}

describe('readEventPoint', () => {
    it('reads a pointer event directly', () => {
        expect(readEventPoint({ nativeEvent: { clientX: 120, clientY: 240 } })).toEqual({ x: 120, y: 240 });
    });

    it('prefers the active touch over the event itself', () => {
        // A TouchEvent has no clientX of its own; the coordinates live on the
        // touch, and taking the event would silently anchor the menu at 0,0.
        const event = {
            nativeEvent: {
                touches: [{ clientX: 30, clientY: 60 }],
                changedTouches: [{ clientX: 999, clientY: 999 }],
            },
        };
        expect(readEventPoint(event)).toEqual({ x: 30, y: 60 });
    });

    it('falls back to changedTouches once the finger is lifted', () => {
        const event = {
            nativeEvent: {
                touches: [],
                changedTouches: [{ clientX: 11, clientY: 22 }],
            },
        };
        expect(readEventPoint(event)).toEqual({ x: 11, y: 22 });
    });

    it('falls back to page coordinates', () => {
        expect(readEventPoint({ nativeEvent: { pageX: 7, pageY: 9 } })).toEqual({ x: 7, y: 9 });
    });

    it('degrades to the origin rather than NaN', () => {
        expect(readEventPoint(undefined)).toEqual({ x: 0, y: 0 });
        expect(readEventPoint({ nativeEvent: {} })).toEqual({ x: 0, y: 0 });
    });
});

describe('isTouchInteraction', () => {
    it('rejects a mouse pointer so desktop keeps right click only', () => {
        expect(isTouchInteraction({ nativeEvent: { pointerType: 'mouse' } })).toBe(false);
    });

    it('accepts touch and pen pointers', () => {
        expect(isTouchInteraction({ nativeEvent: { pointerType: 'touch' } })).toBe(true);
        expect(isTouchInteraction({ nativeEvent: { pointerType: 'pen' } })).toBe(true);
    });

    it('accepts a TouchEvent that carries no pointerType', () => {
        expect(isTouchInteraction({ nativeEvent: { touches: [{}] } })).toBe(true);
    });

    it('rejects an empty touch list', () => {
        expect(isTouchInteraction({ nativeEvent: { touches: [] } })).toBe(false);
    });

    it('uses hover capability when the event says nothing', () => {
        setMatchMedia(true);
        expect(isTouchInteraction({ nativeEvent: {} })).toBe(true);
        setMatchMedia(false);
        expect(isTouchInteraction({ nativeEvent: {} })).toBe(false);
    });

    it('stays false without a window', () => {
        setMatchMedia(null);
        expect(isTouchInteraction({ nativeEvent: {} })).toBe(false);
    });

    it('reads coordinates from raw DOM events without nativeEvent wrapper', () => {
        expect(readEventPoint({ clientX: 88, clientY: 144 })).toEqual({ x: 88, y: 144 });
    });

    it('recognizes touch release events carrying changedTouches', () => {
        expect(isTouchInteraction({ nativeEvent: { touches: [], changedTouches: [{ clientX: 10, clientY: 20 }] } })).toBe(true);
    });
});

describe('isSecondaryPressEvent', () => {
    it('detects right-click / iPadOS trackpad two-finger secondary click', () => {
        expect(isSecondaryPressEvent({ nativeEvent: { button: 2, pointerType: 'mouse' } })).toBe(true);
        expect(isSecondaryPressEvent({ nativeEvent: { button: 2, pointerType: 'touch' } })).toBe(true);
        expect(isSecondaryPressEvent({ button: 0, buttons: 2 })).toBe(true);
        expect(isSecondaryPressEvent({ nativeEvent: { which: 3 } })).toBe(true);
    });

    it('detects Ctrl + primary click on keyboard/mouse but not on touch', () => {
        expect(isSecondaryPressEvent({ nativeEvent: { button: 0, ctrlKey: true, pointerType: 'mouse' } })).toBe(true);
        expect(isSecondaryPressEvent({ nativeEvent: { button: 0, ctrlKey: true, pointerType: 'touch' } })).toBe(false);
        expect(isSecondaryPressEvent({ nativeEvent: { button: 0, ctrlKey: true, pointerType: 'pen' } })).toBe(false);
    });

    it('rejects ordinary primary clicks and middle clicks', () => {
        expect(isSecondaryPressEvent({ nativeEvent: { button: 0, buttons: 1, ctrlKey: false, pointerType: 'mouse' } })).toBe(false);
        expect(isSecondaryPressEvent({ nativeEvent: { button: 1, buttons: 4, pointerType: 'mouse' } })).toBe(false);
        expect(isSecondaryPressEvent(undefined)).toBe(false);
    });
});
