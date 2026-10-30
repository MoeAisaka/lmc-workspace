import { describe, expect, it } from 'vitest';
import { spawnLogSummary, suppliedCredentialEngine, withoutAmbientCredentials } from './spawnCredentials';
import { buildSessionChildEnvironment } from './sessionEnvironment';

describe('supplied model credentials', () => {
    it.each(['agy', 'gemini', 'openclaw'] as const)('rejects %s instead of treating its token as Claude OAuth', agent => {
        expect(() => suppliedCredentialEngine({ agent, token: 'synthetic-token' })).toThrow('native login');
    });

    it('rejects an explicitly empty credential instead of falling back to the host login', () => {
        expect(() => suppliedCredentialEngine({ agent: 'codex', token: '' })).toThrow('empty');
        expect(() => suppliedCredentialEngine({ agent: 'claude', token: '  ' })).toThrow('empty');
    });

    it('keeps native logins unchanged when no token was selected', () => {
        expect(suppliedCredentialEngine({ agent: 'agy' })).toBeNull();
        const original = { CODEX_HOME: '/native', ANTHROPIC_BASE_URL: 'https://native.example' };
        expect(withoutAmbientCredentials(original, null)).toEqual(original);
    });

    it.each([
        ['codex', 'CODEX_HOME'], ['codex', 'openai_api_key'], ['codex', 'OPENAI_BASE_URL'],
        ['claude', 'ANTHROPIC_API_KEY'], ['claude', 'CLAUDE_CODE_OAUTH_TOKEN'], ['claude', 'CLAUDE_CONFIG_DIR'],
    ] as const)('rejects %s authentication overridden by %s before spawning', (agent, key) => {
        expect(() => suppliedCredentialEngine({ agent, token: 'selected', environmentVariables: { [key]: 'other' } })).toThrow('conflicts');
    });

    it('uses the selected Codex credential rather than an inherited API key or endpoint', () => {
        const ambient = { OPENAI_API_KEY: 'host-key', OPENAI_BASE_URL: 'https://host.example', CODEX_HOME: '/host', PATH: '/bin', HTTPS_PROXY: 'http://proxy.example' };
        const engine = suppliedCredentialEngine({ agent: 'codex', token: 'synthetic-json' });
        const child = buildSessionChildEnvironment(withoutAmbientCredentials(ambient, engine), { CODEX_HOME: '/selected' });
        expect(child).toEqual({ CODEX_HOME: '/selected', PATH: '/bin', HTTPS_PROXY: 'http://proxy.example' });
        expect(ambient.OPENAI_API_KEY).toBe('host-key');
    });

    it('removes competing Claude cloud switches and inherited credentials', () => {
        const child = buildSessionChildEnvironment(withoutAmbientCredentials({
            ANTHROPIC_API_KEY: 'host-key', ANTHROPIC_BASE_URL: 'https://host.example', CLAUDE_CODE_USE_VERTEX: '1',
            claude_code_oauth_token: 'host-token', CLAUDE_CONFIG_DIR: '/host', PATH: '/bin',
        }, 'claude'), { CLAUDE_CODE_OAUTH_TOKEN: 'selected' });
        expect(child).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'selected', PATH: '/bin' });
    });

    it('never logs token, environment values, prompt or unknown RPC values', () => {
        const options = { agent: 'codex' as const, token: 'DO-NOT-LOG-TOKEN', environmentVariables: { SECRET: 'DO-NOT-LOG-ENV' }, title: 'DO-NOT-LOG-PROMPT', extra: 'DO-NOT-LOG-UNKNOWN' };
        expect(JSON.stringify(spawnLogSummary(options))).not.toContain('DO-NOT-LOG');
        expect(spawnLogSummary(options)).toEqual({ engine: 'codex', hasSuppliedCredential: true, environmentVariableCount: 1, resume: false, fork: false });
    });
});
