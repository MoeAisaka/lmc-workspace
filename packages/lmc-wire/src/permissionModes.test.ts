import { describe, expect, it } from 'vitest';
import { normalizePermissionModeForEngine } from './permissionModes';

describe('permission compatibility without inferred access', () => {
    it.each(['claude', 'codex', 'rig', undefined])('preserves unset and unknown picks for %s', (engine) => {
        for (const mode of [undefined, null, '', 'new-mode', '__proto__', 'constructor']) {
            expect(normalizePermissionModeForEngine(engine, mode)).toBe(mode);
        }
    });

    it.each([
        ['bypassPermissions', 'yolo'], ['plan', 'read-only'], ['acceptEdits', 'safe-yolo'],
        ['auto', 'auto'], ['default', 'default'],
    ])('keeps %s → %s stable across repeated restores and both switches', (claude, codex) => {
        expect(normalizePermissionModeForEngine('codex', claude)).toBe(codex);
        expect(normalizePermissionModeForEngine('codex', codex)).toBe(codex);
        expect(normalizePermissionModeForEngine('claude', codex)).toBe(claude);
        expect(normalizePermissionModeForEngine('claude', claude)).toBe(claude);
        expect(normalizePermissionModeForEngine('rig', claude)).toBe(claude);
    });
});
