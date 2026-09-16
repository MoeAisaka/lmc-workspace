import { describe, expect, it, vi } from 'vitest';
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn(() => ({})) }));
vi.mock('@/runtime/managedRuntime', () => ({ runtimeRelease: () => null, sdkRequire: vi.fn() }));
vi.mock('./lmcEntrypoint', () => ({ resolveLmcEntrypoint: () => '/fixture/claude.cjs' }));
vi.mock('../utils/proxyBypass', () => ({ ensureLocalProxyBypass: vi.fn() }));
import { query } from './query';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

describe('Claude permission capability at the real SDK adapter', () => {
    it('passes the bypass capability explicitly; setting the mode alone is insufficient', () => {
        query({ prompt: 'fixture only', options: { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true } as any });
        // Assert only the relevant scalars: a full options diff contains env.
        expect(vi.mocked(sdkQuery).mock.calls.at(-1)?.[0].options?.permissionMode).toBe('bypassPermissions');
        expect(vi.mocked(sdkQuery).mock.calls.at(-1)?.[0].options?.allowDangerouslySkipPermissions).toBe(true);
        query({ prompt: 'fixture only', options: { permissionMode: 'default' } });
        expect(vi.mocked(sdkQuery).mock.calls.at(-1)?.[0].options?.allowDangerouslySkipPermissions).toBeUndefined();
    });
});
