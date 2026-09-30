import { describe, expect, it, vi } from 'vitest';
vi.mock('@/utils/engineLoginContext', () => ({ engineLoginContext: () => ({ supported: true }) }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
import { CodexAppServerClient } from './codexAppServerClient';

describe('Codex turn model routing', () => {
    it('does not issue turn/start for a ChatGPT model absent from the current account catalog', async () => {
        const client = new CodexAppServerClient();
        (client as any)._threadId = 'original';
        const request = vi.fn(async (method: string) => method === 'account/read' ? { account: { type: 'chatgpt' } }
            : method === 'model/list' ? { data: [{ model: 'gpt-6.1-sol' }] } : { turn: { id: 'turn' } });
        (client as any).request = request;
        await expect(client.sendTurn('work', { model: 'gpt-6.1', effort: 'medium' })).rejects.toThrow('gpt-6.1-sol');
        expect(request.mock.calls.map(call => call[0])).toEqual(['account/read', 'model/list']);
        await client.sendTurn('work', { model: 'gpt-6.1-sol', effort: 'medium' });
        expect(request).toHaveBeenLastCalledWith('turn/start', expect.objectContaining({ model: 'gpt-6.1-sol', effort: 'medium', threadId: 'original' }));
    });
});
