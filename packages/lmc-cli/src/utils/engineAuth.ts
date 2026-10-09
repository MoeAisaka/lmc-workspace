import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { projectPath } from '@/projectPath';
import { claudeExecutable, codexExecutable, runtimeVersion } from '@/runtime/managedRuntime';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import type { ApiSessionClient } from '@/api/apiSession';
import { engineLoginContext } from './engineLoginContext';

const agentBuild = (() => {try{return createHash('sha256').update(readFileSync(join(projectPath(),'dist','index.mjs'))).digest('hex');}catch{return undefined;}})();

export type EngineAuthStatus = 'ready' | 'required' | 'unknown';
export type Engine = 'claude' | 'codex';

export function parseEngineAuth(engine: Engine, code: number | null, output: string): EngineAuthStatus {
    if (engine === 'claude') {
        try {
            const data = JSON.parse(output);
            if (code === 0 && data.loggedIn === true) return 'ready';
            if (code === 1 && data.loggedIn === false) return 'required';
        } catch { /* Unknown output is not proof of logout. */ }
    } else {
        if (code === 0 && /logged in/i.test(output)) return 'ready';
        if (code === 1 && /not logged in/i.test(output)) return 'required';
    }
    return 'unknown';
}

export function isEngineAuthError(message: string): boolean {
    return /not logged in|please run \/login|authentication_error|invalid[_ ]api[_ ]key|unauthorized|(?:token|oauth session).*(?:expired|revoked)/i.test(message);
}

/** Resolve relative to the installed SDK, including its nested optional dependency. */
export function claudeSdkExecutable(): string {
    return claudeExecutable();
}

/**
 * The Codex provider whose API key lives in an environment variable, if that is
 * how this CODEX_HOME is set up. Only the two strings that answer the question
 * are read — the selected `model_provider`, and that provider's `env_key` — so
 * no TOML dependency is pulled in to look up a pair of values.
 */
export function readCodexEnvKey(configText: string): string | undefined {
    let section = '';
    let provider: string | undefined;
    const envKeys = new Map<string, string>();
    for (const raw of configText.split(/\r?\n/)) {
        const line = raw.replace(/(^|\s)#.*$/, '').trim();
        if (!line) continue;
        const table = /^\[([^\]]+)\]$/.exec(line);
        if (table) { section = table[1].replace(/["']/g, '').trim(); continue; }
        const pair = /^([A-Za-z0-9_.-]+)\s*=\s*["']([^"']*)["']\s*$/.exec(line);
        if (!pair) continue;
        const [, key, value] = pair;
        if (!section && key === 'model_provider') provider = value;
        else if (key === 'env_key' && section.startsWith('model_providers.')) {
            envKeys.set(section.slice('model_providers.'.length), value);
        }
    }
    return provider ? envKeys.get(provider) : undefined;
}

/**
 * `codex login status` only knows about a ChatGPT login: on a machine that
 * authenticates through a custom provider's API key it prints "Not logged in"
 * and exits 1 even while every real request succeeds. Taken at face value that
 * false negative fails the refresh, switch and rollout preflights, which throw
 * on anything that is not 'ready'. So before trusting a 'required' verdict,
 * check whether the selected provider authenticates from the environment and
 * that its variable actually carries a value. Credentials are never read, only
 * whether one is present, and the value never leaves this function.
 */
function codexEnvKeyAuthReady(env: NodeJS.ProcessEnv): boolean {
    try {
        const home = env.CODEX_HOME?.trim() || join(homedir(), '.codex');
        const key = readCodexEnvKey(readFileSync(join(home, 'config.toml'), 'utf8'));
        return !!key && !!env[key]?.trim();
    } catch { return false; }
}

export async function checkEngineAuth(engine: Engine, cwd: string, env?: Record<string, string>, inheritEnvironment = true): Promise<EngineAuthStatus> {
    try {
        const command = engine === 'claude' ? claudeSdkExecutable() : codexExecutable();
        const args = engine === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'];
        const merged = inheritEnvironment ? { ...process.env, ...env } : { ...env };
        return await new Promise(resolve => {
            execFile(command, args, { cwd, env: merged, timeout: 10_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
                const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
                const status = parseEngineAuth(engine, code, engine === 'claude' ? stdout : `${stdout}\n${stderr}`);
                resolve(engine === 'codex' && status === 'required' && codexEnvKeyAuthReady(merged) ? 'ready' : status);
            });
        });
    } catch { return 'unknown'; }
}

export function registerEngineAuth(client: ApiSessionClient, engine: Engine, cwd: string, env?: Record<string, string>, args?: string[]) {
    let checking: Promise<{ status: EngineAuthStatus; checkedAt: number }> | undefined;
    void runtimeVersion(engine).then(engineRuntime => client.updateMetadata(m => ({...m,engineRuntime,agentBuild}))).catch(() => {});
    const check = () => checking ??= (async () => {
        const result = { status: await checkEngineAuth(engine, cwd, env), checkedAt: Date.now() };
        await client.updateMetadata(m => ({ ...m, engineAuth: result }));
        return result;
    })().finally(() => { checking = undefined; });
    client.rpcHandlerManager.registerHandler('check-engine-auth', check);
    client.rpcHandlerManager.registerHandler('engine-login-context', async () => engineLoginContext(engine, cwd, { ...process.env, ...env }, args));
    return check;
}
