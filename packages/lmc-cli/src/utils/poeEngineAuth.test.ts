import { beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock('./probeCommand', () => ({ probeCommand: f.probe }));
vi.mock('@/runtime/managedRuntime', () => ({ claudeExecutable: () => 'fixture-claude', codexExecutable: () => 'fixture-codex', runtimeVersion: vi.fn() }));
vi.mock('@/runtime/poe', async importOriginal => {
    const original = await importOriginal<typeof import('@/runtime/poe')>();
    return { ...original, readPoeSettings: () => ({ enabled: true, version: 1, apiKey: 'fixture-key-only' }) };
});
import { checkEngineAuth } from './engineAuth';
beforeEach(() => f.probe.mockReset().mockResolvedValue({ code: 0, stdout: '{"loggedIn":true}', stderr: '' }));
it('preflights new Poe Claude sessions without passing the old OAuth token', async () => {
    expect(await checkEngineAuth('claude', '/tmp')).toBe('ready');
    expect(f.probe.mock.calls[0][2].env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://api.poe.com', ANTHROPIC_AUTH_TOKEN: 'fixture-key-only', CLAUDE_CODE_OAUTH_TOKEN: '' });
});
it('keeps explicit official login recovery isolated and never injects Poe into Codex', async () => {
    await checkEngineAuth('claude', '/tmp', { HOME: '/tmp/fixture-home' }, false);
    expect(f.probe.mock.calls[0][2].env).toEqual({ HOME: '/tmp/fixture-home' });
    await checkEngineAuth('codex', '/tmp', { HOME: '/tmp/fixture-home' }, false);
    expect(f.probe.mock.calls[1][2].env).toEqual({ HOME: '/tmp/fixture-home' });
});
