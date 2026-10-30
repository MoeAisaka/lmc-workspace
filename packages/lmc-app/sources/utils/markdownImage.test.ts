import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseMarkdown } from '@/components/markdown/parseMarkdown';
const { rpc, getFileAsset, readFileAssetParts } = vi.hoisted(() => ({
    rpc: vi.fn(),
    getFileAsset: vi.fn(),
    readFileAssetParts: vi.fn(),
}));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { sessionRPC: rpc } }));
vi.mock('@/sync/apiFileAssets', () => ({ getFileAsset, readFileAssetParts }));
import { UnsupportedSavedImageError, parseMarkdownImageSource, loadMarkdownImage, loadSavedFileImage } from './markdownImage';

beforeEach(() => {
    rpc.mockReset();
    getFileAsset.mockReset();
    readFileAssetParts.mockReset();
});
afterEach(() => {
    vi.unstubAllGlobals();
});
describe('Markdown image delivery', () => {
    it('resolves the bracketed, space-containing host path from an actual Markdown block', () => {
        const [block] = parseMarkdown('![Preview](</Volumes/Work Disk/project/preview.png>)');
        expect(block.type).toBe('image');
        if (block.type !== 'image') throw new Error('Image block missing');
        expect(parseMarkdownImageSource(block.url)).toEqual({ kind: 'file', path: '/Volumes/Work Disk/project/preview.png', mime: 'image/png' });
    });
    it.each(['codex', 'claude'])('reads a slash-prefixed Windows image from a %s reply using its real drive path', async (engine) => {
        const path = 'D:/AgentWork/Projects/Demo Project/preview.png';
        const [block] = parseMarkdown(`![Preview](</${path}>)`);
        if (block.type !== 'image') throw new Error('Image block missing');
        const source = parseMarkdownImageSource(block.url);
        expect(source).toEqual({ kind: 'file', path, mime: 'image/png' });
        if (source?.kind !== 'file') throw new Error('File source missing');
        rpc.mockResolvedValue({ success: true, size: 1, content: 'AQ==', nextOffset: null });
        await loadMarkdownImage(`${engine}-session`, source.path, source.mime);
        expect(rpc).toHaveBeenCalledExactlyOnceWith(`${engine}-session`, 'resource-file', { path, action: 'download' });
    });
    it.each(['/D:/out/My%20Shot.png', 'file:///D%3A/out/My%20Shot.png'])('normalizes a Windows drive path after decoding: %s', (url) => {
        expect(parseMarkdownImageSource(url)).toEqual({ kind: 'file', path: 'D:/out/My Shot.png', mime: 'image/png' });
    });
    it('decodes file URLs and relative file paths without changing HTTP URLs', () => {
        expect(parseMarkdownImageSource('file:///tmp/Preview%20Page.jpg')).toEqual({ kind: 'file', path: '/tmp/Preview Page.jpg', mime: 'image/jpeg' });
        expect(parseMarkdownImageSource('./screens/preview.webp')).toEqual({ kind: 'file', path: './screens/preview.webp', mime: 'image/webp' });
        // Windows session hosts: a drive letter is a path, not a scheme (2026-10-08, Work-PC).
        expect(parseMarkdownImageSource('D:/Services/LLM/integration/nmem-ui-diagnostics/processing-current.png')).toEqual({ kind: 'file', path: 'D:/Services/LLM/integration/nmem-ui-diagnostics/processing-current.png', mime: 'image/png' });
        expect(parseMarkdownImageSource('C:\\Users\\alice\\shot.jpg')).toEqual({ kind: 'file', path: 'C:\\Users\\alice\\shot.jpg', mime: 'image/jpeg' });
        expect(parseMarkdownImageSource('file:///D:/out/My%20Shot.png')).toEqual({ kind: 'file', path: 'D:/out/My Shot.png', mime: 'image/png' });
        expect(parseMarkdownImageSource('mailto:a@b.png')).toBeNull();
        expect(parseMarkdownImageSource('d:relative.png')).toBeNull();
        expect(parseMarkdownImageSource('<https://example.com/image.png?size=2>')).toEqual({ kind: 'uri', uri: 'https://example.com/image.png?size=2' });
    });
    it('does not read non-image files or unsupported schemes as local previews', () => {
        for (const url of ['javascript:alert(1)', 'ftp://host/image.png', '/tmp/secret.json', 'file://another-host/a.png', '/tmp/a\0.png']) expect(parseMarkdownImageSource(url)).toBeNull();
    });
    it('assembles padded base64 chunks into one complete image instead of truncating at the first chunk', async () => {
        rpc.mockResolvedValueOnce({ success: true, name: 'preview.png', size: 5, revision: 'r1', content: 'AQI=', nextOffset: 2 })
            .mockResolvedValueOnce({ success: true, name: 'preview.png', size: 5, revision: 'r1', content: 'AwQF', nextOffset: null });
        await expect(loadMarkdownImage('codex-session', '/tmp/preview.png', 'image/png')).resolves.toBe('data:image/png;base64,AQIDBAU=');
        expect(rpc).toHaveBeenLastCalledWith('codex-session', 'resource-file', { path: '/tmp/preview.png', action: 'download', offset: 2, revision: 'r1' });
    });
    it('keeps requests for the same path on different sessions separate', async () => {
        rpc.mockImplementation(async (sid: string) => ({ success: true, name: 'p.png', size: 1, content: sid === 'claude' ? 'AQ==' : 'Ag==', nextOffset: null }));
        const images = await Promise.all(['claude', 'codex'].map(sid => loadMarkdownImage(sid, '/tmp/p.png', 'image/png')));
        expect(images).toEqual(['data:image/png;base64,AQ==', 'data:image/png;base64,Ag==']);
    });
    it('fails boundedly on a bad cursor, oversized file or changed revision', async () => {
        rpc.mockResolvedValueOnce({ success: true, size: 2, content: 'AQ==', nextOffset: 0 });
        await expect(loadMarkdownImage('s', '/tmp/bad-cursor.png', 'image/png')).rejects.toThrow();
        rpc.mockResolvedValueOnce({ success: true, size: 33 * 1024 * 1024, content: 'AQ==', nextOffset: 1 });
        await expect(loadMarkdownImage('s', '/tmp/large.png', 'image/png')).rejects.toThrow();
        rpc.mockResolvedValueOnce({ success: true, size: 2, revision: 'r1', content: 'AQ==', nextOffset: 1 })
            .mockResolvedValueOnce({ success: true, size: 2, revision: 'r2', content: 'Ag==', nextOffset: null });
        await expect(loadMarkdownImage('s', '/tmp/changed.png', 'image/png')).rejects.toThrow();
    });
    it('allows another attempt after a failed request', async () => {
        rpc.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ success: true, size: 1, content: 'AQ==', nextOffset: null });
        await expect(loadMarkdownImage('s', '/tmp/retry.png', 'image/png')).rejects.toThrow('offline');
        await expect(loadMarkdownImage('s', '/tmp/retry.png', 'image/png')).resolves.toBe('data:image/png;base64,AQ==');
    });
    it('recognizes same-host and relative saved-file links as encrypted FileAssets without hijacking third-party URLs', () => {
        const assetId = '32c8188a-024c-4507-8272-57fac1deecb1';
        vi.stubGlobal('window', { location: { origin: 'https://lmc.example:8443' } });
        const [block] = parseMarkdown(`![页面预览](https://lmc.example:8443/saved-files/${assetId})`);
        expect(block.type).toBe('image');
        if (block.type !== 'image') throw new Error('Image block missing');
        expect(parseMarkdownImageSource(block.url)).toEqual({ kind: 'saved-file', id: assetId });
        expect(parseMarkdownImageSource(`https://lmc.example/saved-files/${assetId}`)).toEqual({ kind: 'saved-file', id: assetId });
        expect(parseMarkdownImageSource(`/saved-files/${assetId}`)).toEqual({ kind: 'saved-file', id: assetId });
        expect(parseMarkdownImageSource(`<https://lmc.example:8443/saved-files/${assetId}>`)).toEqual({ kind: 'saved-file', id: assetId });
        expect(parseMarkdownImageSource(`https://evil.example/saved-files/${assetId}`)).toEqual({
            kind: 'uri',
            uri: `https://evil.example/saved-files/${assetId}`,
        });
    });
    it('decrypts multi-part saved-file images, supports octet-stream extension fallback, and rejects non-images or oversized assets', async () => {
        const assetId = '32c8188a-024c-4507-8272-57fac1deecb1';
        getFileAsset.mockResolvedValueOnce({
            manifest: { id: assetId, name: 'preview.png', mimeType: 'image/png', size: 5, parts: [{ size: 2, sha256: 'a' }, { size: 3, sha256: 'b' }] },
            key: new Uint8Array(32),
            createdAt: 1,
        });
        readFileAssetParts.mockImplementationOnce(async (_file: unknown, write: (chunk: Uint8Array) => Promise<void>) => {
            await write(new Uint8Array([1, 2]));
            await write(new Uint8Array([3, 4, 5]));
        });
        await expect(loadSavedFileImage(assetId)).resolves.toBe('data:image/png;base64,AQIDBAU=');

        getFileAsset.mockResolvedValueOnce({
            manifest: { id: assetId, name: 'diagram.svg', mimeType: 'application/octet-stream', size: 2, parts: [{ size: 2, sha256: 'c' }] },
            key: new Uint8Array(32),
            createdAt: 1,
        });
        readFileAssetParts.mockImplementationOnce(async (_file: unknown, write: (chunk: Uint8Array) => Promise<void>) => {
            await write(new Uint8Array([60, 62]));
        });
        await expect(loadSavedFileImage(assetId)).resolves.toBe('data:image/svg+xml;base64,PD4=');

        getFileAsset.mockResolvedValueOnce({
            manifest: { id: assetId, name: 'report.pdf', mimeType: 'application/pdf', size: 10, parts: [{ size: 10, sha256: 'd' }] },
            key: new Uint8Array(32),
            createdAt: 1,
        });
        await expect(loadSavedFileImage(assetId)).rejects.toBeInstanceOf(UnsupportedSavedImageError);
        expect(readFileAssetParts).toHaveBeenCalledTimes(2);

        getFileAsset.mockResolvedValueOnce({
            manifest: { id: assetId, name: 'huge.png', mimeType: 'image/png', size: 33 * 1024 * 1024, parts: [] },
            key: new Uint8Array(32),
            createdAt: 1,
        });
        await expect(loadSavedFileImage(assetId)).rejects.toThrow('Image unavailable');
        expect(readFileAssetParts).toHaveBeenCalledTimes(2);
    });
});
