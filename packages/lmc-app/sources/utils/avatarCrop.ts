/**
 * Geometry for the square avatar cropper.
 *
 * The frame is fixed and the image moves behind it: the image starts scaled to
 * cover the frame, and pan/pinch offset and magnify it. These helpers convert
 * that view state into a crop rectangle in the source image's own pixels, which
 * is what expo-image-manipulator wants.
 *
 * Kept free of react-native imports so the math stays unit testable.
 */

export interface CropRect {
    originX: number;
    originY: number;
    width: number;
    height: number;
}

export const MAX_CROP_SCALE = 4;

export function clampCropScale(scale: number): number {
    'worklet';
    if (!Number.isFinite(scale)) return 1;
    return Math.min(MAX_CROP_SCALE, Math.max(1, scale));
}

export function scaleFromWheel(currentScale: number, deltaY: number): number {
    'worklet';
    if (!Number.isFinite(deltaY)) return clampCropScale(currentScale);
    const boundedDelta = Math.min(1_000, Math.max(-1_000, deltaY));
    return clampCropScale(currentScale * Math.exp(-boundedDelta * 0.002));
}

/** Scale at which the image exactly covers the frame; the cropper's floor. */
export function computeBaseScale(imageWidth: number, imageHeight: number, frame: number): number {
    if (!(imageWidth > 0) || !(imageHeight > 0) || !(frame > 0)) return 1;
    return Math.max(frame / imageWidth, frame / imageHeight);
}

/**
 * How far the image may travel before a frame edge would expose empty space.
 * Zero on an axis the image only just covers.
 */
export function maxTranslation(displayLength: number, frame: number): number {
    'worklet';
    return Math.max(0, (displayLength - frame) / 2);
}

/** Keep the frame fully covered, whatever the gesture proposed. */
export function clampTranslation(
    translation: number,
    displayLength: number,
    frame: number,
): number {
    'worklet';
    const limit = maxTranslation(displayLength, frame);
    if (!Number.isFinite(translation)) return 0;
    return Math.min(limit, Math.max(-limit, translation));
}

/**
 * The frame's window onto the source image, in source pixels.
 *
 * `scale` is the user's zoom on top of the cover fit, so 1 means "cover".
 * The result is clamped into the image, so a rounding error at the edge
 * cannot ask the manipulator for pixels that do not exist.
 */
export function computeCropRect(params: {
    imageWidth: number;
    imageHeight: number;
    frame: number;
    scale: number;
    translateX: number;
    translateY: number;
}): CropRect {
    const { imageWidth, imageHeight, frame } = params;
    if (!(imageWidth > 0) || !(imageHeight > 0) || !(frame > 0)) {
        return { originX: 0, originY: 0, width: Math.max(0, imageWidth), height: Math.max(0, imageHeight) };
    }

    const scale = clampCropScale(params.scale);
    const totalScale = computeBaseScale(imageWidth, imageHeight, frame) * scale;
    const displayWidth = imageWidth * totalScale;
    const displayHeight = imageHeight * totalScale;

    const translateX = clampTranslation(params.translateX, displayWidth, frame);
    const translateY = clampTranslation(params.translateY, displayHeight, frame);

    // Distance from the image's top-left to the frame's top-left, on screen.
    const offsetX = displayWidth / 2 - frame / 2 - translateX;
    const offsetY = displayHeight / 2 - frame / 2 - translateY;

    const size = frame / totalScale;
    const width = Math.min(size, imageWidth);
    const height = Math.min(size, imageHeight);

    return {
        originX: Math.min(Math.max(0, offsetX / totalScale), imageWidth - width),
        originY: Math.min(Math.max(0, offsetY / totalScale), imageHeight - height),
        width,
        height,
    };
}
