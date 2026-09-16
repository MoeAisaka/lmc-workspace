import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexExecutable } from '@/runtime/managedRuntime';
import { parseEngineAuth, isEngineAuthError, readCodexEnvKey, checkEngineAuth } from './engineAuth';

it('only publishes authentication state, never credential output', () => {
    expect(parseEngineAuth('claude', 0, '{"loggedIn":true,"apiKey":"secret"}')).toBe('ready');
    expect(parseEngineAuth('claude', 1, '{"loggedIn":false}')).toBe('required');
    expect(parseEngineAuth('claude', 1, 'network failure')).toBe('unknown');
    expect(parseEngineAuth('codex', 0, 'Logged in using ChatGPT')).toBe('ready');
    expect(parseEngineAuth('codex', 1, 'Not logged in')).toBe('required');
});
it('recognizes auth errors without treating capacity or connection errors as logout', () => {
    expect(isEngineAuthError('Not logged in · Please run /login')).toBe(true);
    expect(isEngineAuthError('authentication_error')).toBe(true);
    expect(isEngineAuthError('Selected model is at capacity')).toBe(false);
    expect(isEngineAuthError('Connection closed')).toBe(false);
});
it('reads the env key of the selected Codex provider, and only that one', () => {
    // The real company config: a custom provider authenticated from an env var.
    const config = [
        'model_provider = "company"',
        'model = "gpt-5.6-sol"',
        '',
        '[model_providers.company]',
        'wire_api = "responses"',
        'base_url = "http://192.168.1.35:6002"',
        'requires_openai_auth = false',
        'env_key = "LMC_COMPANY_CODEX_API_KEY"',
        '',
        '[model_providers.other]',
        'env_key = "SOME_OTHER_KEY"',
    ].join('\n');
    expect(readCodexEnvKey(config)).toBe('LMC_COMPANY_CODEX_API_KEY');
    // A quoted table name is the same table.
    expect(readCodexEnvKey('model_provider = "company"\n[model_providers."company"]\nenv_key = "K"')).toBe('K');
    // Nothing to report when the provider is the built-in one, is unknown, or
    // authenticates some other way.
    expect(readCodexEnvKey('[model_providers.company]\nenv_key = "K"')).toBeUndefined();
    expect(readCodexEnvKey('model_provider = "company"')).toBeUndefined();
    expect(readCodexEnvKey('model_provider = "company"\n[model_providers.company]\nbase_url = "http://x"')).toBeUndefined();
    // A commented-out key is not a key.
    expect(readCodexEnvKey('model_provider = "company"\n[model_providers.company]\n# env_key = "K"')).toBeUndefined();
});

// The false negative these guard against lives in how the real binary answers,
// not in any string this file could hand to a parser, so they run it. Skipped
// where Codex is not installed rather than failing for the wrong reason.
const codexInstalled = (() => {
    try { execFileSync(codexExecutable(), ['--version'], { stdio: 'ignore', timeout: 10_000 }); return true; } catch { return false; }
})();

// Shaped like the real company gateway config; `name` is mandatory, and Codex
// refuses to load the whole file without it.
const COMPANY_CONFIG = [
    'model_provider = "company"',
    'model = "gpt-5.6-sol"',
    '',
    '[model_providers.company]',
    'name = "Company internal gateway"',
    'wire_api = "responses"',
    'base_url = "http://192.168.1.35:6002"',
    'requires_openai_auth = false',
    'env_key = "LMC_COMPANY_CODEX_API_KEY"',
].join('\n');

function codexHome(withConfig: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), 'engineauth-'));
    if (withConfig) writeFileSync(join(dir, 'config.toml'), COMPANY_CONFIG);
    return dir;
}

it.skipIf(!codexInstalled)('does not wave through a Codex that genuinely has no credentials', async () => {
    // No config and no login: "Not logged in" means what it says.
    expect(await checkEngineAuth('codex', process.cwd(), { CODEX_HOME: codexHome(false) })).toBe('required');
    // The provider authenticates from the environment, but the variable is empty.
    expect(await checkEngineAuth('codex', process.cwd(), {
        CODEX_HOME: codexHome(true), LMC_COMPANY_CODEX_API_KEY: '   ',
    })).toBe('required');
}, 30_000);

it.skipIf(!codexInstalled)('reads an env-key provider as ready even though `login status` says Not logged in', async () => {
    expect(await checkEngineAuth('codex', process.cwd(), {
        CODEX_HOME: codexHome(true), LMC_COMPANY_CODEX_API_KEY: 'value-present',
    })).toBe('ready');
}, 30_000);
