import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { EngineLoginContext, LoginEngine } from 'lmc-wire';

function canonical(path: string): string {
    try { return realpathSync(path); }
    catch {
        const parent = dirname(path);
        return parent === path ? path : join(canonical(parent), basename(path));
    }
}

/** Describe credential scope without reading/exporting credentials. */
export function engineLoginContext(engine: LoginEngine, cwd: string, env: NodeJS.ProcessEnv = process.env, args: string[] = []): EngineLoginContext {
    const homeDir = canonical(resolve(env.HOME || homedir()));
    const configOverride = engine === 'claude' ? env.CLAUDE_CONFIG_DIR : env.CODEX_HOME;
    const configDir = canonical(resolve(cwd, configOverride || resolve(homeDir, engine === 'claude' ? '.claude' : '.codex')));
    let supported = true;
    if (engine === 'claude') {
        const authKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
        supported = !authKeys.some(k => !!env[k] && env[k] !== '0') && !args.some(arg => /^--(?:settings|setting-sources)(?:=|$)/.test(arg));
        // API-key helpers and cloud providers must keep their own login path.
        const managedSettings = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : process.platform === 'win32' ? resolve(env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode/managed-settings.json') : '/etc/claude-code/managed-settings.json';
        for (const path of [managedSettings, resolve(configDir, 'settings.json'), resolve(cwd, '.claude/settings.json'), resolve(cwd, '.claude/settings.local.json')]) {
            try {
                const settings = JSON.parse(readFileSync(path, 'utf8'));
                if (settings.apiKeyHelper || authKeys.some(k => !!settings.env?.[k] && settings.env[k] !== '0')) supported = false;
            } catch (error: any) { if (error?.code !== 'ENOENT') supported = false; }
        }
    } else {
        supported = !env.OPENAI_API_KEY && !env.OPENAI_BASE_URL;
        try {
            const config = readFileSync(resolve(configDir, 'config.toml'), 'utf8');
            // Conservative for custom/profile providers: never overwrite their credentials.
            const providers = [...config.matchAll(/^\s*model_provider\s*=\s*["']([^"']+)["']/gm)].map(m => m[1]);
            const login = config.match(/^\s*forced_login_method\s*=\s*["']([^"']+)["']/m)?.[1];
            if (providers.some(provider => provider !== 'openai') || (login && login !== 'chatgpt') || /(?:auth_mode|env_key|api_key|base_url)\s*=/.test(config)) supported = false;
        } catch (error: any) { if (error?.code !== 'ENOENT') supported = false; }
    }
    // Claude's macOS Keychain identity also depends on the exact override.
    // Setting the default directory explicitly is not equivalent to leaving it unset.
    return { engine, cwd, homeDir, configDir, configOverride, supported, key: createHash('sha256').update(JSON.stringify([engine, homeDir, configDir, configOverride ?? null])).digest('hex') };
}

export function engineLoginEnvironment(context: EngineLoginContext): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: context.homeDir, BROWSER: process.platform === 'win32' ? 'cmd /c exit' : '/usr/bin/true' };
    const configKey = context.engine === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
    if (context.configOverride === undefined) delete env[configKey];
    else env[configKey] = context.configOverride;
    for (const key of Object.keys(env)) {
        if (/^(?:ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$|OPENAI_API_KEY$|OPENAI_BASE_URL$|HAPPY_SESSION|LMC_SESSION)/.test(key)) delete env[key];
    }
    return env;
}
