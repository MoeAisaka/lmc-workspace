import { describe, expect, it, vi } from 'vitest';
import { assertAccountModel } from './accountModelGuard';

function port(overrides = {}) {
    return { standardChatGptRoute: true,
        readAccount: vi.fn(async () => ({ account: { type: 'chatgpt' } })),
        listModels: vi.fn(async () => [{ model: 'gpt-6.1-sol', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }]),
        ...overrides };
}

describe('account model guard', () => {
    it('rejects unsupported shorthand using the live account catalog, without rewriting it', async () => {
        await expect(assertAccountModel('gpt-6.1', 'medium', port())).rejects.toThrow(/gpt-6.1.*gpt-6.1-sol/);
        await expect(assertAccountModel('gpt-6.1-sol', 'medium', port())).resolves.toBeUndefined();
    });
    it('validates effort against that same catalog', async () => {
        await expect(assertAccountModel('gpt-6.1-sol', 'ultra', port())).rejects.toThrow('medium');
    });
    it('leaves API-key and custom-provider model names to their provider', async () => {
        const custom = port({ standardChatGptRoute: false });
        await assertAccountModel('private-model', 'ultra', custom);
        expect(custom.readAccount).not.toHaveBeenCalled();
        const api = port({ readAccount: vi.fn(async () => ({ account: { type: 'apiKey' } })) });
        await assertAccountModel('private-model', 'ultra', api);
        expect(api.listModels).not.toHaveBeenCalled();
    });
    it('does not mistake unavailable discovery for an unsupported model or use stale defaults', async () => {
        await expect(assertAccountModel('gpt-6.1-sol', 'medium', port({ listModels: vi.fn(async () => []) }))).rejects.toThrow('目录');
        await expect(assertAccountModel('gpt-6.1-sol', 'medium', port({ readAccount: vi.fn(async () => { throw new Error('offline'); }) }))).rejects.toThrow('offline');
    });
});
