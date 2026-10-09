import { describe, expect, it } from 'vitest';
import { overlayHeight } from './browserLayoutViewport';

describe('overlay height', () => {
    it('uses the layout viewport whenever no field is being edited', () => {
        // The reported state: Safari left the visual viewport at a small stale height with no keyboard up.
        expect(overlayHeight(100, 659, false)).toBe(659);
        expect(overlayHeight(659, 659, false)).toBe(659);
        // Browser chrome collapsing can make the visual viewport taller for a moment; the shell is still the layout size.
        expect(overlayHeight(720, 659, false)).toBe(659);
    });
    it('lets the keyboard take height only while a field has focus', () => {
        expect(overlayHeight(323, 659, true)).toBe(323);
        expect(overlayHeight(700, 659, true)).toBe(659);
        expect(overlayHeight(0, 659, true)).toBe(659);
    });
    it('falls back to the visual height where there is no layout viewport', () => {
        expect(overlayHeight(812, 0, false)).toBe(812);
    });
});
