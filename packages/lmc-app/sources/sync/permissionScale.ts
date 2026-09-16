import type { PermissionMode } from '@/components/modelModeOptions';
import type { SwitchableEngine } from './engineSwitch';

/**
 * The permission modes as a scale, loosest last.
 *
 * The composer shows permission as a slider, which needs an order — and the
 * order it needs is not the one `PERMISSION_RANKS` gives. That one ranks modes
 * by how often they are picked, so the everyday choice is easiest to reach; a
 * slider is read as "how far am I letting it go", and a pick order slid along
 * that axis would put the escape hatch next to the safety net.
 *
 * These are ordered by how much the engine may do before it asks. The two
 * engines are listed so their notches line up: each pair is one `PERMISSION_INTENT`
 * entry, so the knob stays where it was when a session changes engine — the
 * same position means the same thing on both sides.
 */
const SCALES: Record<SwitchableEngine, readonly string[]> = {
    claude: ['plan', 'default', 'auto', 'acceptEdits', 'bypassPermissions'],
    codex: ['read-only', 'default', 'auto', 'safe-yolo', 'yolo'],
};

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
    if (flavor !== 'claude' && flavor !== 'codex') return null;
    const order = SCALES[flavor];
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
