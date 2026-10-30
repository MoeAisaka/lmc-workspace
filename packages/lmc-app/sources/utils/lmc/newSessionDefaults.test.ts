import { describe, expect, it } from 'vitest';
import { creationPath, creationPermission } from './newSessionDefaults';
import { getHardcodedPermissionModes } from '@/components/modelModeOptions';

describe('four-step session defaults', () => {
    it('maps YOLO to supported native modes for all three CLIs', () => {
        const t = ((key: string) => key) as any;
        expect(creationPermission(getHardcodedPermissionModes('codex', t))?.key).toBe('yolo');
        expect(creationPermission(getHardcodedPermissionModes('claude', t))?.key).toBe('bypassPermissions');
        expect(creationPermission(getHardcodedPermissionModes('agy', t))?.key).toBe('bypassPermissions');
        expect(creationPermission([{key:'default'}, {key:'safe-yolo'}])).toBeUndefined();
    });
    it('uses the selected device home, including Windows, without carrying another device path', () => {
        expect(creationPath('/Users/alice')).toBe('/Users/alice');
        expect(creationPath('C:\\Users\\alice')).toBe('C:\\Users\\alice');
        expect(creationPath(undefined)).toBe('~');
    });
});
