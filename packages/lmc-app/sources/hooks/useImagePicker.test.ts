import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    platform: { OS: 'ios' },
    requestMediaLibraryPermissionsAsync: vi.fn(),
    launchImageLibraryAsync: vi.fn(),
    manipulateAsync: vi.fn(),
    generateThumbhash: vi.fn(),
}));

vi.mock('react-native', () => ({
    Platform: mocks.platform,
}));

vi.mock('expo-document-picker', () => ({
    getDocumentAsync: vi.fn(),
}));
vi.mock('expo-image-picker', () => ({
    requestMediaLibraryPermissionsAsync: mocks.requestMediaLibraryPermissionsAsync,
    launchImageLibraryAsync: mocks.launchImageLibraryAsync,
}));

vi.mock('expo-image-manipulator', () => ({
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: mocks.manipulateAsync,
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/utils/thumbhash', () => ({
    generateThumbhash: mocks.generateThumbhash,
}));

import { normalizePickedAssetForUpload } from './useImagePicker';

describe('normalizePickedAssetForUpload', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.platform.OS = 'ios';
    });

    it('normalizes iOS image picker assets to JPEG before upload', async () => {
        mocks.manipulateAsync.mockResolvedValue({
            uri: 'file:///tmp/ImageManipulator/IMG_9824.jpg',
            width: 4032,
            height: 3024,
        });

        const normalized = await normalizePickedAssetForUpload({
            uri: 'file:///tmp/IMG_9824.HEIC',
            width: 4032,
            height: 3024,
            fileName: 'IMG_9824.HEIC',
            fileSize: 2_701_533,
        });

        expect(mocks.manipulateAsync).toHaveBeenCalledWith(
            'file:///tmp/IMG_9824.HEIC',
            [],
            { compress: expect.any(Number), format: 'jpeg' },
        );
        expect(normalized).toEqual({
            uri: 'file:///tmp/ImageManipulator/IMG_9824.jpg',
            mimeType: 'image/jpeg',
            name: 'IMG_9824.jpg',
            width: 4032,
            height: 3024,
        });
    });
});

describe('unsent attachments survive switching sessions', () => {
    it('restores the picked files when the composer for the same session mounts again', async () => {
        const React = await import('react');
        // @ts-expect-error react-test-renderer ships without type declarations here
        const TestRenderer: any = (await import('react-test-renderer')).default;
        const { useImagePicker } = await import('./useImagePicker');
        let api: ReturnType<typeof useImagePicker> | null = null;
        const Composer = ({ id }: { id: string }) => { api = useImagePicker(id); return null; };
        const file = { id: 'f1', uri: 'blob:x', width: 1, height: 1, mimeType: 'text/plain', size: 3, name: 'notes.txt' };

        let renderer: any;
        await TestRenderer.act(async () => { renderer = TestRenderer.create(React.createElement(Composer, { id: 'a' })); });
        await TestRenderer.act(async () => { api!.addImages([file]); });
        // Switching away unmounts this composer; another session starts empty.
        await TestRenderer.act(async () => { renderer.unmount(); renderer = TestRenderer.create(React.createElement(Composer, { id: 'b' })); });
        expect(api!.selectedImages).toEqual([]);
        await TestRenderer.act(async () => { renderer.unmount(); renderer = TestRenderer.create(React.createElement(Composer, { id: 'a' })); });
        expect(api!.selectedImages).toEqual([file]);
        // Sending clears it, so it does not come back a second time.
        await TestRenderer.act(async () => { api!.clearImages(); });
        await TestRenderer.act(async () => { renderer.unmount(); renderer = TestRenderer.create(React.createElement(Composer, { id: 'a' })); });
        expect(api!.selectedImages).toEqual([]);
        // Same mounted composer moving to another session swaps drafts too.
        await TestRenderer.act(async () => { api!.addImages([file]); });
        await TestRenderer.act(async () => { renderer.update(React.createElement(Composer, { id: 'b' })); });
        expect(api!.selectedImages).toEqual([]);
        await TestRenderer.act(async () => { renderer.update(React.createElement(Composer, { id: 'a' })); });
        expect(api!.selectedImages).toEqual([file]);
        renderer.unmount();
    });
});
