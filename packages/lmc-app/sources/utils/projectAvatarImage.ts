import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import type { ProjectAvatarUploadInput } from '@/sync/projects';
import { readFileBytes } from '@/utils/readFileBytes';
import { generateThumbhash } from '@/utils/thumbhash';
import type { CropRect } from './avatarCrop';

export const PROJECT_AVATAR_OUTPUT_SIZE = 512;

export interface PrepareProjectAvatarImageInput {
    uri: string;
    imageWidth: number;
    imageHeight: number;
    crop: CropRect;
}

export function revokeAvatarBlobUrl(uri: string): void {
    if (uri.startsWith('blob:')
        && typeof URL !== 'undefined'
        && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(uri);
    }
}

/** Return the final-close hook for one picker-owned URL. */
export function createAvatarBlobUrlReleaser(uri: string): () => void {
    let released = false;
    return () => {
        if (released) return;
        released = true;
        revokeAvatarBlobUrl(uri);
    };
}

export function normalizeAvatarCropRect(
    crop: CropRect,
    imageWidth: number,
    imageHeight: number,
): CropRect {
    const values = [
        crop.originX,
        crop.originY,
        crop.width,
        crop.height,
        imageWidth,
        imageHeight,
    ];
    if (!values.every(Number.isFinite) || crop.width <= 0 || crop.height <= 0) {
        throw new Error('Invalid project avatar crop');
    }

    const sourceWidth = Math.floor(imageWidth);
    const sourceHeight = Math.floor(imageHeight);
    const side = Math.min(
        Math.round(Math.min(crop.width, crop.height)),
        sourceWidth,
        sourceHeight,
    );
    if (sourceWidth <= 0 || sourceHeight <= 0 || side <= 0) {
        throw new Error('Invalid project avatar crop');
    }

    return {
        originX: Math.min(sourceWidth - side, Math.max(0, Math.round(crop.originX))),
        originY: Math.min(sourceHeight - side, Math.max(0, Math.round(crop.originY))),
        width: side,
        height: side,
    };
}

export async function prepareProjectAvatarImage(
    input: PrepareProjectAvatarImageInput,
    compact = false,
): Promise<ProjectAvatarUploadInput> {
    const crop = normalizeAvatarCropRect(input.crop, input.imageWidth, input.imageHeight);
    const result = await manipulateAsync(
        input.uri,
        [
            { crop },
            { resize: { width: compact ? 128 : PROJECT_AVATAR_OUTPUT_SIZE, height: compact ? 128 : PROJECT_AVATAR_OUTPUT_SIZE } },
        ],
        { compress: 1, format: SaveFormat.PNG },
    );
    let bytes: Uint8Array;
    let thumbhash: string | undefined;
    try {
        [bytes, thumbhash] = await Promise.all([
            readFileBytes(result.uri),
            generateThumbhash(result.uri, result.width, result.height),
        ]);
    } finally {
        revokeAvatarBlobUrl(result.uri);
    }
    if (bytes.length === 0) {
        throw new Error('Project avatar image was empty');
    }
    if (!thumbhash?.trim()) {
        throw new Error('Could not generate project avatar preview');
    }
    return {
        bytes,
        mimeType: 'image/png',
        thumbhash,
    };
}
