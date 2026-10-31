import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
    getFileAsset: vi.fn(), fileAssetBlob: vi.fn(), downloadFileAsset: vi.fn(),
    getFileShares: vi.fn(), getFileDeliveries: vi.fn(), createFileShare: vi.fn(),
    deliverFileAsset: vi.fn(), revokeFileShare: vi.fn(), decryptFileReceipt: vi.fn(),
}));
vi.mock('@/sync/persistence', () => ({ loadSettings: () => ({ settings: {} }) }));
vi.mock('@/sync/apiFileAssets', () => ({ ...api, FILE_PREVIEW_LIMIT: 16 * 1024 * 1024 }));
vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator', Platform: { OS: 'web' } }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: {} } }) }));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/components/FileIcon', () => ({ FileIcon: () => null }));
vi.mock('@/components/lmc/SettingsSelect', () => ({ SettingsMenuHost: 'SettingsMenuHost', SettingsSelect: 'SettingsSelect' }));
vi.mock('@/sync/storage', () => ({ useAllSessions: () => [] }));
vi.mock('@/sync/apiAccounts', () => ({ accountMe: vi.fn(() => Promise.resolve({ capabilities: { fileSharing: false } })) }));
vi.mock('@/components/lmc/ResourceSharingDialog', () => ({ openResourceSharing: vi.fn() }));

import { SavedFileDetails } from './SavedFileDetails';

const id = '11111111-1111-4111-8111-111111111110';
const file = { manifest: { id, name: 'notes.md', mimeType: 'text/markdown', size: 100, parts: [] }, key: new Uint8Array(32), createdAt: 1 };
let renderer: ReturnType<typeof create> | undefined;
const clipboard = vi.fn();
async function mount() {
    await act(async () => { renderer = create(React.createElement(SavedFileDetails, { id })); });
}
async function press(label: string) {
    const button = renderer.root.findAllByType('Pressable').find((node: any) => node.findAllByType('Text').some((text: any) => text.props.children === label));
    expect(button).toBeTruthy();
    await act(async () => { button.props.onPress(); });
}
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { location: { origin: 'https://lmc.example:8443', href: 'https://lmc.example:8443/session/chat' } });
    vi.stubGlobal('navigator', { clipboard: { writeText: clipboard } });
    api.getFileAsset.mockResolvedValue(file);
    api.getFileShares.mockResolvedValue([]);
    api.getFileDeliveries.mockResolvedValue([]);
    api.fileAssetBlob.mockResolvedValue(new Blob(['preview body']));
});
afterEach(async () => {
    if (renderer) await act(async () => renderer.unmount());
    renderer = undefined;
    vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('saved file overlay content', () => {
    it('previews on opening without creating a public share or sending a file, and copies the stable file URL', async () => {
        await mount();
        expect(api.fileAssetBlob).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(renderer.toJSON())).toContain('preview body');
        await press('Copy link');
        expect(clipboard).toHaveBeenCalledWith('https://lmc.example:8443/saved-files/' + id);
        expect(api.createFileShare).not.toHaveBeenCalled();
        expect(api.deliverFileAsset).not.toHaveBeenCalled();
    });

    it('aborts an unfinished preview on close and releases a late object URL', async () => {
        api.getFileAsset.mockResolvedValue({ ...file, manifest: { ...file.manifest, mimeType: 'image/png' } });
        let resolve!: (blob: Blob) => void;
        api.fileAssetBlob.mockReturnValue(new Promise<Blob>(r => { resolve = r; }));
        const createURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:late-preview');
        const revokeURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        await mount();
        const signal = api.fileAssetBlob.mock.calls[0][3] as AbortSignal;
        await act(async () => renderer.unmount()); renderer = undefined;
        expect(signal.aborted).toBe(true);
        await act(async () => resolve(new Blob(['image'])));
        expect(createURL).toHaveBeenCalledOnce();
        expect(revokeURL).toHaveBeenCalledWith('blob:late-preview');
    });

    it('shows a preview failure and allows a successful retry', async () => {
        api.fileAssetBlob.mockRejectedValueOnce(new Error('预览连接中断'));
        await mount();
        expect(JSON.stringify(renderer.toJSON())).toContain('预览连接中断');
        await press('Load preview');
        expect(JSON.stringify(renderer.toJSON())).toContain('preview body');
        expect(JSON.stringify(renderer.toJSON())).not.toContain('预览连接中断');
    });

    it('does not fetch oversized previews and keeps download available', async () => {
        api.getFileAsset.mockResolvedValue({ ...file, manifest: { ...file.manifest, size: 17 * 1024 * 1024 } });
        await mount();
        expect(api.fileAssetBlob).not.toHaveBeenCalled();
        expect(JSON.stringify(renderer.toJSON())).toContain('File exceeds 16 MiB');
        await press('Download');
        expect(api.downloadFileAsset).toHaveBeenCalledOnce();
    });
});
