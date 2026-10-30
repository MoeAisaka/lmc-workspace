export type PermissionEngine = 'claude' | 'codex';
export type EnginePermissionMode = 'auto' | 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
    | 'safe-yolo' | 'read-only' | 'yolo';

/**
 * Existing LMC engine-switch intent matches, shared by UI and runners.
 * These are approximations: Claude plan/acceptEdits and Codex filesystem
 * sandboxes are different mechanisms, but must not become full access.
 */
export const PERMISSION_INTENT: Record<PermissionEngine, Record<string, EnginePermissionMode>> = {
    claude: {
        auto: 'auto', default: 'default', acceptEdits: 'safe-yolo',
        plan: 'read-only', bypassPermissions: 'yolo',
    },
    codex: {
        auto: 'auto', default: 'default', 'safe-yolo': 'acceptEdits',
        'read-only': 'plan', yolo: 'bypassPermissions',
    },
};

export function normalizePermissionModeForEngine(engine: string | null | undefined, mode: EnginePermissionMode): EnginePermissionMode;
export function normalizePermissionModeForEngine(engine: string | null | undefined, mode: string): string;
export function normalizePermissionModeForEngine(engine: string | null | undefined, mode: string | null | undefined): string | null | undefined;
/**
 * Target-native modes are idempotent; legacy foreign spellings keep their
 * intent. Unset, unknown modes and other engines stay untouched so callers
 * retain their own default/validation rules. Never infer full access.
 */
export function normalizePermissionModeForEngine(engine: string | null | undefined, mode: string | null | undefined): string | null | undefined {
    if (!mode || (engine !== 'claude' && engine !== 'codex')) return mode;
    const foreign = PERMISSION_INTENT[engine === 'codex' ? 'claude' : 'codex'];
    return Object.prototype.hasOwnProperty.call(foreign, mode) ? foreign[mode] : mode;
}
