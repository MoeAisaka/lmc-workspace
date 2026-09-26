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
 * What the engine taking over starts on, as far as the request says.
 *
 * The permission mode arrives already mapped. The model and effort are the ones
 * picked from the destination's own list together with the switch, so they are
 * already in its vocabulary; carrying them to the launch is what makes the pick
 * the model that answers, on every device, rather than a note one app keeps in
 * memory and applies only if it is still open when the relaunch lands.
 */
export function readSwitchSettings(request: unknown): { permissionMode?: string; model?: string; effort?: string } {
    if (!request || typeof request !== 'object') return {};
    const settings: { permissionMode?: string; model?: string; effort?: string } = {};
    for (const key of ['permissionMode', 'model', 'effort'] as const) {
        const value = (request as Record<string, unknown>)[key];
        if (typeof value === 'string' && value.trim()) settings[key] = value;
    }
    return settings;
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
