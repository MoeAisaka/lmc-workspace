import { describe, it, expect, vi } from 'vitest';
vi.mock('react-native', () => ({Platform: {OS: 'web', select: (options: Record<string, unknown>) => options.web ?? options.default}}));
import { lightTheme, darkTheme } from '../theme';
import { PERSONALIZATION_PRESETS, PersonalizationSchema } from './personalization';
import { personalizationPalette } from './personalizationPalette';
import { localSettingsParse } from './localSettings';

function contrast(a: string, b: string) {
    const luminance = (hex: string) => hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255)
        .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
        .reduce((total, v, i) => total + v * [0.2126, 0.7152, 0.0722][i], 0);
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
describe('terminal presentation keeps identity and semantic colors unchanged', () => {
    it.each([lightTheme, darkTheme])('restores the complete base palette and preserves safety colors', base => {
        const snapshot = JSON.stringify(base);
        const terminal = personalizationPalette(base, PERSONALIZATION_PRESETS.terminal);
        for (const key of ['status', 'permission', 'permissionButton', 'diff'] as const) expect(terminal[key]).toEqual(base.colors[key]);
        for (const bg of [terminal.surface, terminal.surfaceHigh, terminal.groupped.background]) {
            expect(contrast(terminal.text, bg)).toBeGreaterThanOrEqual(4.5);
            expect(contrast(terminal.textSecondary, bg)).toBeGreaterThanOrEqual(4.5);
        }
        expect(personalizationPalette(base, PERSONALIZATION_PRESETS.classic)).toEqual(base.colors);
        expect(JSON.stringify(base)).toEqual(snapshot);
    });
    it('repairs old or corrupt styles without changing unrelated preferences', () => {
        expect(PersonalizationSchema.parse({accent: 'rose'})).toMatchObject({chrome: 'standard', accent: 'rose'});
        const restored = localSettingsParse({themePreference: 'dark', chatWideMode: true, personalization: {...PERSONALIZATION_PRESETS.terminal, chrome: 'invalid'}});
        expect(restored).toMatchObject({themePreference: 'dark', chatWideMode: true, personalization: {chrome: 'standard', uiFont: 'sarasa', accent: 'green'}});
        expect(localSettingsParse(JSON.parse(JSON.stringify({personalization: PERSONALIZATION_PRESETS.terminal}))).personalization).toEqual(PERSONALIZATION_PRESETS.terminal);
    });
});
