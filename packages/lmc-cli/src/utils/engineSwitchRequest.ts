import type { SwitchableEngine } from '@/daemon/sessionRefresh';

/**
 * Reads a `configure-session` request as a request to change engine.
 *
 * Both runners accept the same shape, and both have to tell it apart from the
 * plain `{refreshCli:true}` they already handle — a request naming an engine is
 * a switch, anything else is not. The permission mode arrives already mapped to
 * the target engine's vocabulary: the app owns that table, because the app is
 * where a mode is chosen.
 */
const ALLOWED = ['engine', 'permissionMode', 'model', 'effort', 'fallbackBriefing'];

export function readSwitchEngine(request: unknown): SwitchableEngine | null {
    if (!request || typeof request !== 'object') return null;
    const engine = (request as Record<string, unknown>).engine;
    if (engine !== 'claude' && engine !== 'codex') return null;
    if (Object.keys(request).some((key) => !ALLOWED.includes(key))) return null;
    for (const key of ALLOWED.slice(1)) {
        const value = (request as Record<string, unknown>)[key];
        if (value !== undefined && typeof value !== 'string') return null;
    }
    return engine;
}

/**
 * The briefing to hand over if the engine does not write one of its own.
 *
 * It arrives with the request rather than being assembled at the last moment,
 * which is what makes every failure mode land in the same place: an engine that
 * crashes, refuses, or simply ignores the request still hands over something,
 * and there is no timer to get wrong.
 */
export function readFallbackBriefing(request: unknown): string | null {
    if (!request || typeof request !== 'object') return null;
    const value = (request as Record<string, unknown>).fallbackBriefing;
    return typeof value === 'string' && value.trim() ? value : null;
}
