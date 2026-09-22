/** Ephemeral, encrypted RPC only. Never put these values in session metadata. */
export type LoginEngine = 'claude' | 'codex';
export type EngineLoginState = 'checking' | 'starting' | 'waiting' | 'submitting' | 'verifying' | 'recovering' | 'complete' | 'failed' | 'expired' | 'cancelled';
export type EngineLoginError = 'required' | 'unknown' | 'unsupported' | 'offline' | 'upgrade' | 'busy' | 'invalidCode' | 'loginFailed' | 'stale' | 'cancelled' | 'expired';
export type LoginRecovery = { sessionId: string; state: 'waiting' | 'restored' | 'failed' | 'upgrade'; requestedAt: number; previousPid?: number };
export type EngineLoginSnapshot = {
    id: string;
    sourceSessionId: string;
    engine: LoginEngine;
    method: 'authorizationCode' | 'deviceCode';
    state: EngineLoginState;
    expiresAt: number;
    authorizationUrl?: string;
    userCode?: string;
    error?: EngineLoginError;
    sessions: LoginRecovery[];
};
export type EngineLoginReply = { flow: EngineLoginSnapshot | null; error?: EngineLoginError };
export type EngineLoginContext = { engine: LoginEngine; cwd: string; homeDir: string; configDir: string; configOverride?: string; key: string; supported: boolean };
export function loginIsTerminal(state: EngineLoginState): boolean {
    return ['complete', 'failed', 'expired', 'cancelled'].includes(state);
}
/** Only native provider authorization endpoints may be opened or encoded in QR. */
export function isEngineLoginUrl(engine: LoginEngine, value: string): boolean {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
        return engine === 'claude'
            ? ['claude.ai', 'claude.com', 'console.anthropic.com', 'platform.claude.com'].includes(url.hostname) && ['/oauth/authorize', '/cai/oauth/authorize'].includes(url.pathname)
            : url.hostname === 'auth.openai.com' && url.pathname === '/codex/device';
    } catch { return false; }
}
