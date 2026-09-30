import { expect, it, vi } from 'vitest';
const { read, load, preview, viewer, toast } = vi.hoisted(() => ({ read: vi.fn(), load: vi.fn(), preview: vi.fn(), viewer: vi.fn(), toast: vi.fn() }));
vi.mock('@/sync/ops', () => ({ sessionReadFile: read }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: {} }));
vi.mock('@/components/lmc/toolOverlayStore', () => ({ openSessionFile: viewer }));
vi.mock('@/components/lmc/Toast', () => ({ showToast: toast }));
vi.mock('@/utils/deliverResourceFile', () => ({ deliverResourceFile: vi.fn() }));
vi.mock('@/components/ImagePreviewModal', () => ({ openImagePreview: preview }));
vi.mock('@/utils/markdownImage', async importOriginal => ({ ...await importOriginal<object>(), loadMarkdownImage: load }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { openFileReference } from './openFileReference';
it('opens an image link in the shared preview without reading it as a text file', async () => {
    load.mockResolvedValue('data:image/png;base64,AQ==');
    await openFileReference('codex', '/tmp/exec-example.png');
    expect(load).toHaveBeenCalledWith('codex', '/tmp/exec-example.png', 'image/png');
    expect(preview).toHaveBeenCalledWith('data:image/png;base64,AQ==', 'exec-example.png');
    expect(read).not.toHaveBeenCalled();
    expect(viewer).not.toHaveBeenCalled();
});
