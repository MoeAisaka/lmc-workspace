import { describe, expect, it } from 'vitest';
import { holdReleaseIntent, MOUSE_SORT_SLOP_PX, sortSlopForPointer, TOUCH_SORT_SLOP_PX, touchSortIntent } from './sessionSortGesture';

describe('touch sort intent', () => {
    it('keeps early movement as scrolling even after the hold deadline', () => {
        expect(touchSortIntent(false, 12, false)).toBe('scroll');
    });
    it('requires movement after arming to sort', () => {
        expect(touchSortIntent(true, 9, false)).toBe('drag');
        expect(touchSortIntent(true, 3, false)).toBe('hold');
    });
    it('opens the menu only for a stationary armed release', () => {
        expect(touchSortIntent(true, 3, true)).toBe('menu');
        expect(touchSortIntent(false, 3, true)).toBe('tap');
    });
    it('gives touch/pen wider jitter tolerance so finger roll does not cancel long-press menu', () => {
        expect(sortSlopForPointer('mouse')).toBe(MOUSE_SORT_SLOP_PX);
        expect(sortSlopForPointer('touch')).toBe(TOUCH_SORT_SLOP_PX);
        expect(sortSlopForPointer('pen')).toBe(TOUCH_SORT_SLOP_PX);
        expect(touchSortIntent(true, 10, false, sortSlopForPointer('touch'))).toBe('hold');
        expect(touchSortIntent(true, 10, true, sortSlopForPointer('touch'))).toBe('menu');
        expect(touchSortIntent(true, 14, false, sortSlopForPointer('touch'))).toBe('drag');
    });
});

describe('holdReleaseIntent', () => {
    it('gives a finger the menu, since it has no other way to reach one', () => {
        expect(holdReleaseIntent('touch', true)).toBe('menu');
        expect(holdReleaseIntent('pen', true)).toBe('menu');
    });

    it('lets a held mouse press mean the drag it looks like', () => {
        expect(holdReleaseIntent('mouse', true)).toBe('cancel');
    });

    it('leaves a short press alone whatever pressed it', () => {
        expect(holdReleaseIntent('mouse', false)).toBe('tap');
        expect(holdReleaseIntent('touch', false)).toBe('tap');
    });
});
