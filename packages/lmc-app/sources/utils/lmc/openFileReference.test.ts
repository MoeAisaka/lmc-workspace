import { beforeEach, expect, it, vi } from 'vitest';
const { read, load, preview, viewer, toast, saved, state } = vi.hoisted(() => ({ read: vi.fn(), load: vi.fn(), preview: vi.fn(), viewer: vi.fn(), toast: vi.fn(), saved: vi.fn(), state: { sessions: {}, sessionMessages: {} } as any }));
vi.mock('@/sync/ops', () => ({ sessionReadFile: read }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: {} }));
vi.mock('@/components/lmc/toolOverlayStore', () => ({ openSessionFile: viewer }));
vi.mock('@/components/lmc/Toast', () => ({ showToast: toast }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => state } }));
vi.mock('@/components/SavedFileDialog', () => ({ openSavedFile: saved }));
vi.mock('@/utils/deliverResourceFile', () => ({ deliverResourceFile: vi.fn() }));
vi.mock('@/components/ImagePreviewModal', () => ({ openImagePreview: preview }));
vi.mock('@/utils/markdownImage', async importOriginal => ({ ...await importOriginal<object>(), loadMarkdownImage: load }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { openFileReference } from './openFileReference';
const asset = '11111111-1111-4111-8111-111111111111';
const card = (id = asset, name = 'guide.html') => ({ kind: 'tool-call', tool: { name: 'file', input: { assetId: id, name, size: 100 } }, children: [] });
beforeEach(() => { vi.clearAllMocks(); state.sessions = {}; state.sessionMessages = {}; });
it.each(['claude', 'codex', 'agy'])('opens a published document from a shared %s session without host-file RPC', async engine => {
    state.sessions[engine] = { shared: true };
    state.sessionMessages[engine] = { messages: [card()] };
    read.mockResolvedValue({ success: false, error: 'sharedActionUnauthorized' });
    await openFileReference(engine, 'D:\\project\\guide.html');
    expect(saved).toHaveBeenCalledWith(asset);
    expect(read).not.toHaveBeenCalled();
    expect(viewer).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
});
it('keeps owner links on the current source file', async () => {
    state.sessions.owner = { shared: false };
    state.sessionMessages.owner = { messages: [card()] };
    read.mockResolvedValue({ success: true, content: 'aGVsbG8=' });
    viewer.mockReturnValue(true);
    await openFileReference('owner', '/project/guide.html');
    expect(saved).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledWith('owner', '/project/guide.html');
});
it('never chooses an attachment from another session or guesses among different same-name files', async () => {
    state.sessions.shared = { shared: true };
    state.sessionMessages.other = { messages: [card()] };
    read.mockResolvedValue({ success: false, error: 'sharedActionUnauthorized' });
    await openFileReference('shared', '/project/guide.html');
    expect(saved).not.toHaveBeenCalled();
    state.sessionMessages.shared = { messages: [card(), card('22222222-2222-4222-8222-222222222222')] };
    await openFileReference('shared', '/project/guide.html');
    expect(saved).not.toHaveBeenCalled();
});
it('recognizes a nested file card and duplicate references to the same saved snapshot', async () => {
    state.sessions.shared = { shared: true };
    state.sessionMessages.shared = { messages: [card(), { kind: 'tool-call', tool: { name: 'Task' }, children: [card()] }] };
    await openFileReference('shared', '/project/guide.html');
    expect(saved).toHaveBeenCalledOnce();
    expect(saved).toHaveBeenCalledWith(asset);
    expect(read).not.toHaveBeenCalled();
});
it('does not mistake arbitrary tool arguments or malformed IDs for a published attachment', async () => {
    state.sessions.shared = { shared: true };
    const fake = card(); fake.tool.name = 'bash';
    state.sessionMessages.shared = { messages: [fake, card('not-an-asset')] };
    read.mockResolvedValue({ success: false, error: 'sharedActionUnauthorized' });
    await openFileReference('shared', '/project/guide.html');
    expect(saved).not.toHaveBeenCalled();
});
it('opens an image link in the shared preview without reading it as a text file', async () => {
    load.mockResolvedValue('data:image/png;base64,AQ==');
    await openFileReference('codex', '/tmp/exec-example.png');
    expect(load).toHaveBeenCalledWith('codex', '/tmp/exec-example.png', 'image/png');
    expect(preview).toHaveBeenCalledWith('data:image/png;base64,AQ==', 'exec-example.png');
    expect(read).not.toHaveBeenCalled();
    expect(viewer).not.toHaveBeenCalled();
});
