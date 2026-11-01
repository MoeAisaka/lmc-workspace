import { describe, expect, it } from 'vitest';
import { isFullAutonomyPermissionKey, permissionScale, permissionScaleIndex } from './permissionScale';
import { PERMISSION_INTENT } from './engineSwitch';

const modes = (...keys: string[]) => keys.map((key) => ({ key, name: key }));

describe('permissionScale', () => {
    it('orders by how much the engine may do, not by how often a mode is picked', () => {
        const scale = permissionScale('claude', modes('default', 'bypassPermissions', 'plan', 'auto', 'acceptEdits'))!;
        expect(scale.map((mode) => mode.key)).toEqual(['plan', 'default', 'auto', 'acceptEdits', 'bypassPermissions']);
    });

    it('puts the two engines’ notches in the same places, so a switch does not move the knob', () => {
        const claude = permissionScale('claude', modes('plan', 'default', 'auto', 'acceptEdits', 'bypassPermissions'))!;
        const codex = permissionScale('codex', modes('read-only', 'default', 'auto', 'safe-yolo', 'yolo'))!;
        expect(claude.length).toBe(codex.length);
        for (let index = 0; index < claude.length; index += 1) {
            expect(PERMISSION_INTENT.claude[claude[index].key]).toBe(codex[index].key);
        }
    });

    it('orders Antigravity, OpenClaw, Gemini, and Rig modes from strictest to loosest', () => {
        expect(permissionScale('agy', modes('bypassPermissions', 'acceptEdits', 'plan', 'default', 'auto'))?.map((m) => m.key))
            .toEqual(['plan', 'default', 'auto', 'acceptEdits', 'bypassPermissions']);
        expect(permissionScale('openclaw', modes('bypassPermissions', 'default'))?.map((m) => m.key))
            .toEqual(['default', 'bypassPermissions']);
        expect(permissionScale('gemini', modes('yolo', 'default', 'plan'))?.map((m) => m.key))
            .toEqual(['plan', 'default', 'yolo']);
        expect(permissionScale('rig', modes('yolo', 'workspace_write', 'read-only', 'auto'))?.map((m) => m.key))
            .toEqual(['read-only', 'auto', 'workspace_write', 'yolo']);
    });

    it('drops a notch the session does not offer rather than showing one it would reject', () => {
        const scale = permissionScale('claude', modes('plan', 'default', 'acceptEdits', 'bypassPermissions'))!;
        expect(scale.map((mode) => mode.key)).toEqual(['plan', 'default', 'acceptEdits', 'bypassPermissions']);
    });

    it('refuses the scale when a mode it cannot place is on offer', () => {
        expect(permissionScale('claude', modes('plan', 'default', 'workspace_write'))).toBeNull();
        expect(permissionScale('openclaw', modes('default', 'unranked_custom_mode'))).toBeNull();
        expect(permissionScale('claude', modes('default'))).toBeNull();
    });

    it('identifies full-autonomy endpoints accurately', () => {
        expect(isFullAutonomyPermissionKey('yolo')).toBe(true);
        expect(isFullAutonomyPermissionKey('bypassPermissions')).toBe(true);
        expect(isFullAutonomyPermissionKey('full_access')).toBe(true);
        expect(isFullAutonomyPermissionKey('safe-yolo')).toBe(false);
        expect(isFullAutonomyPermissionKey('auto')).toBe(false);
        expect(isFullAutonomyPermissionKey(null)).toBe(false);
    });
});

describe('permissionScaleIndex', () => {
    it('finds the current notch, and says so when there is none', () => {
        const scale = permissionScale('codex', modes('read-only', 'default', 'auto', 'safe-yolo', 'yolo'))!;
        expect(permissionScaleIndex(scale, 'auto')).toBe(2);
        expect(permissionScaleIndex(scale, 'nonsense')).toBe(-1);
    });
});
