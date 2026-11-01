import type { PermissionMode } from '@/components/modelModeOptions';

/**
 * The permission modes as a scale, loosest last.
 *
 * Every CLI's modes are ordered strictly by how much the engine may do before
 * it asks — from read-only / plan-first on the left to full autonomy on the
 * right. Claude and Codex keep their 5 notches aligned 1:1 with
 * `PERMISSION_INTENT` so switching engine leaves the knob at the same position;
 * Antigravity, OpenClaw, Gemini and Rig map onto the same cautious-to-autonomous
 * progression so every CLI uses a stepped slider rather than a dropdown list.
 */
const SCALES: Record<string, readonly string[]> = {
    claude: ['plan', 'default', 'auto', 'acceptEdits', 'bypassPermissions'],
    codex: ['read-only', 'default', 'auto', 'safe-yolo', 'yolo'],
    agy: ['plan', 'default', 'auto', 'acceptEdits', 'bypassPermissions'],
    openclaw: ['default', 'bypassPermissions'],
    gemini: ['plan', 'default', 'yolo'],
    rig: [
        'read_only',
        'read-only',
        'plan',
        'ask',
        'default',
        'auto',
        'acceptEdits',
        'workspace_write',
        'safe-yolo',
        'full_access',
        'bypassPermissions',
        'yolo',
    ],
};

const FULL_AUTONOMY_KEYS = new Set(['bypassPermissions', 'yolo', 'full_access']);

/** True when the mode key represents unrestricted / never-ask autonomy. */
export function isFullAutonomyPermissionKey(key: string | null | undefined): boolean {
    return Boolean(key && FULL_AUTONOMY_KEYS.has(key));
}

/**
 * The modes to show on the slider, in scale order.
 *
 * Only modes the session actually offers survive: `auto` is filtered out for a
 * CLI too old to parse it, and a harness publishing its own catalog has modes
 * this table has never heard of. Anything unranked is dropped from the slider
 * rather than guessed at a position — a mode whose strictness we cannot place
 * would put the user somewhere they did not ask to be.
 *
 * Returns null when the scale cannot describe this session, and the caller
 * should fall back to a plain list.
 */
export function permissionScale(
    flavor: string | null | undefined,
    available: PermissionMode[],
): PermissionMode[] | null {
    if (!flavor || available.length < 2) return null;
    const order = SCALES[flavor] ?? SCALES.rig;
    const scaled = order
        .map((key) => available.find((mode) => mode.key === key))
        .filter((mode): mode is PermissionMode => mode != null);
    // Every offered mode has to be on the scale, or the slider would silently
    // remove a mode the session supports and the user may already be in.
    if (scaled.length !== available.length || scaled.length < 2) return null;
    return scaled;
}

/** Where the current mode sits, or -1 when it is not on the scale. */
export function permissionScaleIndex(scale: PermissionMode[], current: string | null | undefined): number {
    return scale.findIndex((mode) => mode.key === current);
}
