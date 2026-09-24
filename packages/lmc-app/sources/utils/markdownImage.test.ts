import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseMarkdown } from '@/components/markdown/parseMarkdown';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { sessionRPC: rpc } }));
import { parseMarkdownImageSource, loadMarkdownImage } from './markdownImage';

beforeEach(() => rpc.mockReset());
describe('Markdown image delivery', () => {
    it('resolves the bracketed, space-containing host path from an actual Markdown block', () => {
        const [block] = parseMarkdown('![Preview](</Volumes/Work Disk/project/preview.png>)');
        expect(block.type).toBe('image');
        if (block.type !== 'image') throw new Error('Image block missing');
        expect(parseMarkdownImageSource(block.url)).toEqual({ kind: 'file', path: '/Volumes/Work Disk/project/preview.png', mime: 'image/png' });
    });
    it('decodes file URLs and relative file paths without changing HTTP URLs', () => {
        expect(parseMarkdownImageSource('file:///tmp/Preview%20Page.jpg')).toEqual({ kind: 'file', path: '/tmp/Preview Page.jpg', mime: 'image/jpeg' });
        expect(parseMarkdownImageSource('./screens/preview.webp')).toEqual({ kind: 'file', path: './screens/preview.webp', mime: 'image/webp' });
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
});
