import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers';

type CredentialEngine = 'claude' | 'codex';

function isCredentialVariable(engine: CredentialEngine, key: string): boolean {
    const name = key.toUpperCase();
    return engine === 'codex'
        ? ['CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'].includes(name)
        : name.startsWith('ANTHROPIC_') || ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CONFIG_DIR'].includes(name);
}

/** Legacy same-account token launch only. This is NOT an OS isolation boundary. */
export function suppliedCredentialEngine(options: Pick<SpawnSessionOptions, 'agent' | 'token' | 'environmentVariables'>): CredentialEngine | null {
    if (options.token === undefined) return null;
    if (typeof options.token !== 'string' || !options.token.trim()) throw new Error('The selected model credential is empty. Sign in again.');
    const engine = options.agent ?? 'claude';
    if (engine !== 'claude' && engine !== 'codex') {
        throw new Error('This engine does not support supplied model credentials. Use its own native login.');
    }
    // Match Windows environment keys case-insensitively. A selected identity must
    // not silently become another profile's key, endpoint or config directory.
    if (Object.keys(options.environmentVariables ?? {}).some(key => isCredentialVariable(engine, key))) {
        throw new Error('The selected model credential conflicts with the session environment. Remove the authentication overrides.');
    }
    return engine;
}

/** Remove competing ambient authentication before adding the selected credential. */
export function withoutAmbientCredentials(env: NodeJS.ProcessEnv, engine: CredentialEngine | null): NodeJS.ProcessEnv {
    if (!engine) return { ...env };
    return Object.fromEntries(Object.entries(env).filter(([key]) => !isCredentialVariable(engine, key)));
}

/** Never stringify incoming token, environment values or unknown RPC fields. */
export function spawnLogSummary(options: Partial<SpawnSessionOptions>) {
    const allowedEngine = ['claude', 'codex', 'gemini', 'openclaw', 'agy'].includes(options.agent ?? 'claude');
    return {
        engine: allowedEngine ? (options.agent ?? 'claude') : 'unsupported',
        hasSuppliedCredential: options.token !== undefined,
        environmentVariableCount: Object.keys(options.environmentVariables ?? {}).length,
        resume: !!(options.sessionId || options.resumeClaudeSessionId || options.resumeCodexThreadId),
        fork: !!options.parentSessionId,
    };
}
