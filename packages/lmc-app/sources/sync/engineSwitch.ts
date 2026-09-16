/**
 * Moving one session from one engine to another.
 *
 * A session is bound to its engine for life today: the metadata carries a
 * native thread id per engine, and a relaunch resumes whichever one the flavor
 * names. Switching means starting a fresh native thread on the other engine and
 * carrying the conversation across as text, because neither engine can read the
 * other's transcript store.
 *
 * The table lives here, on the app side, because this is where a permission
 * mode is chosen. The CLI is handed an already-mapped mode and forwards it to
 * the engine — it never needs to know the mapping, so there is no second copy
 * of it to drift.
 */

export type SwitchableEngine = 'claude' | 'codex';

export function isSwitchableEngine(value: unknown): value is SwitchableEngine {
    return value === 'claude' || value === 'codex';
}

/**
 * Permission modes by what they let the agent do, not by name.
 *
 * The two engines share two spellings (`auto`, `default`) and agree on neither
 * of the others, so carrying a mode across unchanged would either be rejected
 * or — worse — silently accepted as a different policy. These are the closest
 * intent matches, and they are approximations: Claude's `plan` is "think, do
 * not edit" while Codex's `read-only` is "read, do not write", which are the
 * same restraint arrived at differently.
 */
export const PERMISSION_INTENT: Record<SwitchableEngine, Record<string, string>> = {
    claude: {
        auto: 'auto',
        acceptEdits: 'safe-yolo',
        plan: 'read-only',
        bypassPermissions: 'yolo',
        default: 'default',
    },
    codex: {
        auto: 'auto',
        'safe-yolo': 'acceptEdits',
        'read-only': 'plan',
        yolo: 'bypassPermissions',
        default: 'default',
    },
};

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
    if (from === to) return mode ?? 'default';
    if (!mode) return 'default';
    return PERMISSION_INTENT[from][mode] ?? 'default';
}

/**
 * Model and effort are named per engine — "Opus 5" means nothing to Codex — so
 * a switch cannot carry them. The target engine starts on its own defaults and
 * the user picks again.
 */
export interface EngineSwitchRequest {
    /** Which engine to continue on. */
    engine: SwitchableEngine;
    /** Already mapped by `mapPermissionMode`; the CLI does not re-map. */
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
