import { describe, expect, it } from 'vitest';
import { permissionScale, permissionScaleIndex } from './permissionScale';
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

    it('drops a notch the session does not offer rather than showing one it would reject', () => {
        const scale = permissionScale('claude', modes('plan', 'default', 'acceptEdits', 'bypassPermissions'))!;
        expect(scale.map((mode) => mode.key)).toEqual(['plan', 'default', 'acceptEdits', 'bypassPermissions']);
    });

    it('refuses the scale when a mode it cannot place is on offer', () => {
        expect(permissionScale('claude', modes('plan', 'default', 'workspace-write'))).toBeNull();
        expect(permissionScale('openclaw', modes('default', 'bypassPermissions'))).toBeNull();
        expect(permissionScale('claude', modes('default'))).toBeNull();
    });
});

describe('permissionScaleIndex', () => {
    it('finds the current notch, and says so when there is none', () => {
        const scale = permissionScale('codex', modes('read-only', 'default', 'auto', 'safe-yolo', 'yolo'))!;
        expect(permissionScaleIndex(scale, 'auto')).toBe(2);
        expect(permissionScaleIndex(scale, 'nonsense')).toBe(-1);
    });
});
