import { beforeEach, expect, it, vi } from 'vitest';
import { parseMarkdown } from '@/components/markdown/parseMarkdown';
const { sessionRPC, machineRPC, state } = vi.hoisted(() => ({ sessionRPC: vi.fn(), machineRPC: vi.fn(), state: { sessions: {} as Record<string, any> } }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { sessionRPC, machineRPC } }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => state } }));
import { parseMarkdownImageSource, loadMarkdownImage } from './markdownImage';

beforeEach(() => { vi.resetAllMocks(); state.sessions = {}; });

// The message that failed on Work-PC on 2026-10-08: bracketed, a space in
// the path, and 197,359 bytes, so it needs a second chunk.
const MESSAGE = '已补充并保存。\n\n![补充完成截图](<D:/AgentWork/Projects/Demo Project/.lmc-inbox/qwen-section-updated-20261008.png>)';
const PATH = 'D:/AgentWork/Projects/Demo Project/.lmc-inbox/qwen-section-updated-20261008.png';

it('finds the image block and its Windows path in the real message', () => {
    const image = parseMarkdown(MESSAGE).find(block => block.type === 'image');
    expect(image).toBeTruthy();
    if (image?.type !== 'image') throw new Error('Image block missing');
    expect(parseMarkdownImageSource(image.url)).toEqual({ kind: 'file', path: PATH, mime: 'image/png' });
});

it('reads both chunks through the host while the session process still refuses drive paths', async () => {
    state.sessions.s = { metadata: { machineId: 'win-host', path: 'D:\\AgentWork\\Projects\\Demo Project' } };
    sessionRPC.mockResolvedValue({ success: false, error: '无效的文件路径' });
    machineRPC
        .mockResolvedValueOnce({ success: true, name: 'a.png', size: 5, revision: '1:2:5', content: 'AQI=', nextOffset: 2 })
        .mockResolvedValueOnce({ success: true, name: 'a.png', size: 5, revision: '1:2:5', content: 'AwQF', nextOffset: null });
    await expect(loadMarkdownImage('s', PATH, 'image/png')).resolves.toBe('data:image/png;base64,AQIDBAU=');
    expect(machineRPC).toHaveBeenNthCalledWith(1, 'win-host', 'resource-file', { path: PATH, action: 'download' });
    expect(machineRPC).toHaveBeenNthCalledWith(2, 'win-host', 'resource-file', { path: PATH, action: 'download', offset: 2, revision: '1:2:5' });
});
