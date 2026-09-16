import { describe, it, expect } from 'vitest';
import {
    clampCropScale,
    clampTranslation,
    computeBaseScale,
    computeCropRect,
    maxTranslation,
    scaleFromWheel,
} from './avatarCrop';

const FRAME = 300;

describe('computeBaseScale', () => {
    it('covers the frame from the short edge', () => {
        // 600x400 → the 400 side is the constraint, so it must scale by 300/400.
        expect(computeBaseScale(600, 400, FRAME)).toBeCloseTo(0.75);
        expect(computeBaseScale(400, 600, FRAME)).toBeCloseTo(0.75);
    });

    it('scales a small image up rather than leaving gaps', () => {
        expect(computeBaseScale(150, 150, FRAME)).toBeCloseTo(2);
    });

    it('degrades to 1 on nonsense input instead of NaN or Infinity', () => {
        expect(computeBaseScale(0, 100, FRAME)).toBe(1);
        expect(computeBaseScale(100, 100, 0)).toBe(1);
    });
});

describe('clampTranslation', () => {
    it('allows no movement when the image only just covers the frame', () => {
        expect(maxTranslation(FRAME, FRAME)).toBe(0);
        expect(clampTranslation(50, FRAME, FRAME)).toBe(0);
    });

    it('limits travel to the overhang on each side', () => {
        // 400 wide behind a 300 frame leaves 50 of slack each way.
        expect(maxTranslation(400, FRAME)).toBe(50);
        expect(clampTranslation(120, 400, FRAME)).toBe(50);
        expect(clampTranslation(-120, 400, FRAME)).toBe(-50);
        expect(clampTranslation(20, 400, FRAME)).toBe(20);
    });

    it('treats a non-finite gesture value as no offset', () => {
        expect(clampTranslation(Number.NaN, 400, FRAME)).toBe(0);
    });
});

describe('crop zoom', () => {
    it('clamps zoom to the supported one-to-four-times range', () => {
        expect(clampCropScale(0.5)).toBe(1);
        expect(clampCropScale(2.25)).toBe(2.25);
        expect(clampCropScale(10)).toBe(4);
        expect(clampCropScale(Number.NaN)).toBe(1);
    });

    it('zooms in on wheel-up and out on wheel-down without escaping the range', () => {
        expect(scaleFromWheel(2, -100)).toBeGreaterThan(2);
        expect(scaleFromWheel(2, 100)).toBeLessThan(2);
        expect(scaleFromWheel(4, -100_000)).toBe(4);
        expect(scaleFromWheel(1, 100_000)).toBe(1);
    });
});

describe('computeCropRect', () => {
    it('takes the centred square of a landscape image at rest', () => {
        // 600x400 covers at 0.75, so the frame sees 400x400 of source, centred.
        const rect = computeCropRect({
            imageWidth: 600, imageHeight: 400, frame: FRAME,
            scale: 1, translateX: 0, translateY: 0,
        });
        expect(rect.width).toBeCloseTo(400);
        expect(rect.height).toBeCloseTo(400);
        expect(rect.originX).toBeCloseTo(100);
        expect(rect.originY).toBeCloseTo(0);
    });

    it('takes the whole square image at rest', () => {
        const rect = computeCropRect({
            imageWidth: 500, imageHeight: 500, frame: FRAME,
            scale: 1, translateX: 0, translateY: 0,
        });
        expect(rect).toEqual({ originX: 0, originY: 0, width: 500, height: 500 });
    });

    it('shrinks the source window as the user zooms in', () => {
        const rect = computeCropRect({
            imageWidth: 500, imageHeight: 500, frame: FRAME,
            scale: 2, translateX: 0, translateY: 0,
        });
        expect(rect.width).toBeCloseTo(250);
        // Still centred: half the discarded width on each side.
        expect(rect.originX).toBeCloseTo(125);
        expect(rect.originY).toBeCloseTo(125);
    });

    it('moves the window opposite the drag', () => {
        // Dragging the image right (+x) reveals pixels further left.
        const rect = computeCropRect({
            imageWidth: 500, imageHeight: 500, frame: FRAME,
            scale: 2, translateX: 60, translateY: 0,
        });
        expect(rect.originX).toBeLessThan(125);
        expect(rect.originY).toBeCloseTo(125);
    });

    it('never leaves the image, however far the gesture pushed', () => {
        const rect = computeCropRect({
            imageWidth: 500, imageHeight: 500, frame: FRAME,
            scale: 2, translateX: 100000, translateY: -100000,
        });
        expect(rect.originX).toBeGreaterThanOrEqual(0);
        expect(rect.originY).toBeGreaterThanOrEqual(0);
        expect(rect.originX + rect.width).toBeLessThanOrEqual(500);
        expect(rect.originY + rect.height).toBeLessThanOrEqual(500);
    });

    it('treats zoom below cover as cover', () => {
        const zoomedOut = computeCropRect({
            imageWidth: 500, imageHeight: 500, frame: FRAME,
            scale: 0.2, translateX: 0, translateY: 0,
        });
        expect(zoomedOut.width).toBeCloseTo(500);
    });

    it('caps the source window at the four-times zoom limit', () => {
        const zoomedIn = computeCropRect({
            imageWidth: 500, imageHeight: 500, frame: FRAME,
            scale: 10, translateX: 0, translateY: 0,
        });
        expect(zoomedIn.width).toBeCloseTo(125);
        expect(zoomedIn.originX).toBeCloseTo(187.5);
    });

    it('degrades safely on a zero-sized image', () => {
        const rect = computeCropRect({
            imageWidth: 0, imageHeight: 0, frame: FRAME,
            scale: 1, translateX: 0, translateY: 0,
        });
        expect(rect).toEqual({ originX: 0, originY: 0, width: 0, height: 0 });
    });
});
