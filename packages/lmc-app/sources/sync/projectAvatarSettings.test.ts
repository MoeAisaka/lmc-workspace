import { describe, it, expect } from 'vitest';
import { applySettings, settingsDefaults, settingsParse } from './settings';

describe('ordinary project avatars', () => {
    const avatar = { uri: 'data:image/png;base64,AQID', thumbhash: 'preview' };
    it('preserves other project images when editing and removing one project', () => {
        const initial = applySettings(settingsDefaults, { projectAvatarOverrides: { mini: avatar, book: avatar } } as any);
        const removed = applySettings(initial, { projectAvatarOverrides: { mini: null } } as any) as any;
        expect(removed.projectAvatarOverrides).toEqual({ mini: null, book: avatar });
    });
    it('rejects remote and oversized image records, preserving valid local thumbnails', () => {
        expect((settingsParse({projectAvatarOverrides:{mini:avatar}}) as any).projectAvatarOverrides.mini).toEqual(avatar);
        for (const uri of ['https://example.test/private.png', 'data:image/png;base64,' + 'A'.repeat(200000)]) {
            expect((settingsParse({projectAvatarOverrides:{mini:{...avatar,uri}}}) as any).projectAvatarOverrides).toEqual({});
        }
    });
});
