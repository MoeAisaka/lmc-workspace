import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineLoginContext, engineLoginEnvironment } from './engineLoginContext';

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'lmc-login-context-test-')); dirs.push(dir); return dir; };
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

it.each([
    ['', true],
    ['profile = "company"', false],
    ['profile = "official"', true],
    ['model_provider = "company"', false],
    ['forced_login_method = "api"', false],
    ['profile = "missing"', false],
])('checks only the selected Codex configuration: %s', (selection, supported) => {
    const home = temp(); mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex/config.toml'), `${selection}
[profiles.company]
model_provider = "company"
[profiles.official]
model_provider = "openai"
[model_providers.company]
base_url = "https://example.invalid"
env_key = "COMPANY_KEY"
`);
    expect(engineLoginContext('codex', home, { HOME: home }).supported).toBe(supported);
});

it.each([
    '[model_providers.openai]\nbase_url = "https://example.invalid"',
    'profile = "official"\n[profiles.official]\nforced_login_method = "api"',
    'model_provider = [invalid toml',
])('fails closed for custom active authentication or invalid TOML', config => {
    const home = temp(); mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex/config.toml'), config);
    expect(engineLoginContext('codex', home, { HOME: home }).supported).toBe(false);
});

it('keeps custom configuration directories distinct without exporting credentials', () => {
    const home = temp();
    const a = engineLoginContext('claude', home, { HOME: home, CLAUDE_CONFIG_DIR: './one' });
    const b = engineLoginContext('claude', home, { HOME: home, CLAUDE_CONFIG_DIR: './two', ANTHROPIC_API_KEY: 'private-token' });
    expect(a.supported).toBe(true); expect(a.configDir).toBe(join(realpathSync(home), 'one'));
    expect(a.key).not.toBe(b.key); expect(b.supported).toBe(false);
    expect(JSON.stringify(b)).not.toContain('private-token');
});
it('does not replace custom provider authentication in either engine', () => {
    const home = temp(); const configDir = join(home, '.codex'); mkdirSync(configDir);
    writeFileSync(join(configDir, 'config.toml'), 'model_provider = "company"\n[model_providers.company]\nenv_key = "COMPANY_KEY"');
    expect(engineLoginContext('codex', home, { HOME: home }).supported).toBe(false);
    mkdirSync(join(home, '.claude')); writeFileSync(join(home, '.claude/settings.json'), '{"apiKeyHelper":"private-command"}');
    const context = engineLoginContext('claude', home, { HOME: home });
    expect(context.supported).toBe(false); expect(JSON.stringify(context)).not.toContain('private-command');
});
it('preserves unset and exact config overrides, including the macOS Keychain namespace', () => {
    const home = temp();
    for (const engine of ['claude', 'codex'] as const) {
        const key = engine === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
        const implicit = engineLoginContext(engine, home, { HOME: home });
        const explicit = engineLoginContext(engine, home, { HOME: home, [key]: `.${engine}` });
        expect(implicit.configDir).toBe(explicit.configDir);
        expect(implicit.key).not.toBe(explicit.key);
        expect(Object.hasOwn(engineLoginEnvironment(implicit), key)).toBe(false);
        expect(engineLoginEnvironment(explicit)[key]).toBe(`.${engine}`);
    }
});
