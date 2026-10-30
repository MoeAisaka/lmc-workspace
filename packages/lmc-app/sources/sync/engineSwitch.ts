/**
 * Moving one session from one engine to another.
 *
 * A session is bound to its engine for life today: the metadata carries a
 * native thread id per engine, and a relaunch resumes whichever one the flavor
 * names. Switching means starting a fresh native thread on the other engine and
 * carrying the conversation across as text, because neither engine can read the
 * other's transcript store.
 *
 * The app and runners share the same permission intent table: restored
 * metadata and messages from older apps can still carry the departed engine's
 * spelling, so conversion cannot live only in the switch button.
 */

import { normalizePermissionModeForEngine, PERMISSION_INTENT } from 'lmc-wire';
export { PERMISSION_INTENT } from 'lmc-wire';

export type SwitchableEngine = 'claude' | 'codex' | 'agy';

export function isSwitchableEngine(value: unknown): value is SwitchableEngine {
    return value === 'claude' || value === 'codex' || value === 'agy';
}

/**
 * The mode to start the target engine in. Falls back to that engine's own
 * default rather than guessing: an unmapped mode is one this table has not been
 * taught, and starting stricter than asked is the safe direction to be wrong in.
 */
export function mapPermissionMode(
    from: SwitchableEngine,
    to: SwitchableEngine,
    mode: string | null | undefined,
): string {
    if (!mode) return 'default';
    const target = to === 'agy' ? 'claude' : to;
    const normalized = normalizePermissionModeForEngine(target, mode);
    if (from === to) return normalized;
    return Object.prototype.hasOwnProperty.call(PERMISSION_INTENT[target], normalized) ? normalized : 'default';
}

/**
 * Model and effort are named per engine — "Opus 5" means nothing to Codex — so
 * a switch cannot carry them. The target engine starts on its own defaults and
 * the user picks again.
 */
export interface EngineSwitchRequest {
    /** Which engine to continue on. */
    engine: SwitchableEngine;
    /** Already mapped by `mapPermissionMode`; runners also accept legacy aliases. */
    permissionMode?: string;
    model?: string;
    effort?: string;
}

export function isEngineSwitchRequest(value: unknown): value is EngineSwitchRequest {
    if (!value || typeof value !== 'object') return false;
    const request = value as Record<string, unknown>;
    if (!isSwitchableEngine(request.engine)) return false;
    for (const key of ['permissionMode', 'model', 'effort']) {
        if (request[key] !== undefined && typeof request[key] !== 'string') return false;
    }
    return Object.keys(request).every((key) => ['engine', 'permissionMode', 'model', 'effort'].includes(key));
}
