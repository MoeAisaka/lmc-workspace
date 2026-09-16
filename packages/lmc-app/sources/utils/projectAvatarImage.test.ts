import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    manipulateAsync: vi.fn(),
    readFileBytes: vi.fn(),
    generateThumbhash: vi.fn(),
}));

vi.mock('expo-image-manipulator', () => ({
    manipulateAsync: mocks.manipulateAsync,
    SaveFormat: { PNG: 'png' },
}));
vi.mock('@/utils/readFileBytes', () => ({
    readFileBytes: mocks.readFileBytes,
}));
vi.mock('@/utils/thumbhash', () => ({
    generateThumbhash: mocks.generateThumbhash,
}));

import {
    createAvatarBlobUrlReleaser,
    normalizeAvatarCropRect,
    prepareProjectAvatarImage,
} from './projectAvatarImage';

describe('createAvatarBlobUrlReleaser', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('releases an owned blob URL at most once', () => {
        const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
        const release = createAvatarBlobUrlReleaser('blob:https://app.example.test/picked');

        release();
        release();

        expect(revokeObjectURL).toHaveBeenCalledOnce();
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:https://app.example.test/picked');
    });
});

describe('normalizeAvatarCropRect', () => {
    it('rounds a fractional crop to an in-bounds integer square', () => {
        expect(normalizeAvatarCropRect(
            { originX: 100.4, originY: -0.2, width: 400.2, height: 400.7 },
            600,
            400,
        )).toEqual({ originX: 100, originY: 0, width: 400, height: 400 });
    });

    it('moves an edge crop inward instead of shrinking below the requested size', () => {
        expect(normalizeAvatarCropRect(
            { originX: 450, originY: 475, width: 100, height: 100 },
            500,
            500,
        )).toEqual({ originX: 400, originY: 400, width: 100, height: 100 });
    });

    it('rejects empty, non-finite, or invalid source geometry', () => {
        expect(() => normalizeAvatarCropRect(
            { originX: 0, originY: 0, width: 0, height: 10 },
            100,
            100,
        )).toThrow('Invalid project avatar crop');
        expect(() => normalizeAvatarCropRect(
            { originX: Number.NaN, originY: 0, width: 10, height: 10 },
            100,
            100,
        )).toThrow('Invalid project avatar crop');
        expect(() => normalizeAvatarCropRect(
            { originX: 0, originY: 0, width: 10, height: 10 },
            0,
            100,
        )).toThrow('Invalid project avatar crop');
    });
});

describe('prepareProjectAvatarImage', () => {
    let revokeObjectURL: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
        mocks.manipulateAsync.mockResolvedValue({
            uri: 'blob:https://app.example.test/cropped',
            width: 512,
            height: 512,
        });
        mocks.readFileBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
        mocks.generateThumbhash.mockResolvedValue('thumbhash-cropped');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('crops before resizing and returns upload-ready PNG bytes', async () => {
        await expect(prepareProjectAvatarImage({
            uri: 'blob:https://app.example.test/original',
            imageWidth: 600,
            imageHeight: 400,
            crop: { originX: 100.2, originY: 0, width: 400, height: 400 },
        })).resolves.toEqual({
            bytes: new Uint8Array([1, 2, 3]),
            mimeType: 'image/png',
            thumbhash: 'thumbhash-cropped',
        });

        expect(mocks.manipulateAsync).toHaveBeenCalledWith(
            'blob:https://app.example.test/original',
            [
                { crop: { originX: 100, originY: 0, width: 400, height: 400 } },
                { resize: { width: 512, height: 512 } },
            ],
            { compress: 1, format: 'png' },
        );
        expect(mocks.readFileBytes).toHaveBeenCalledWith('blob:https://app.example.test/cropped');
        expect(mocks.generateThumbhash).toHaveBeenCalledWith(
            'blob:https://app.example.test/cropped',
            512,
            512,
        );
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:https://app.example.test/cropped');
    });

    it('rejects an output whose ThumbHash could not be generated', async () => {
        mocks.generateThumbhash.mockResolvedValueOnce(undefined);

        await expect(prepareProjectAvatarImage({
            uri: 'blob:https://app.example.test/original',
            imageWidth: 500,
            imageHeight: 500,
            crop: { originX: 0, originY: 0, width: 500, height: 500 },
        })).rejects.toThrow('Could not generate project avatar preview');
    });

    it('rejects an empty PNG output before upload', async () => {
        mocks.readFileBytes.mockResolvedValueOnce(new Uint8Array());

        await expect(prepareProjectAvatarImage({
            uri: 'blob:https://app.example.test/original',
            imageWidth: 500,
            imageHeight: 500,
            crop: { originX: 0, originY: 0, width: 500, height: 500 },
        })).rejects.toThrow('Project avatar image was empty');
    });
});
