import { UI_FONT_CHOICES, CODE_FONT_CHOICES, resolveCodeFont, resolveUIFont } from './personalizationFonts';
import { describe, it, expect } from 'vitest';
import { PersonalizationSchema, personalizationDefaults, PERSONALIZATION_PRESETS, matchingPersonalizationPreset, personalizationMetrics, effectiveMotion, motionDuration } from './personalization';
import { localSettingsParse, applyLocalSettings } from './localSettings';

describe('device-local personalization compatibility', () => {
    it('migrates old settings without resetting existing layout preferences', () => {
        const old = localSettingsParse({ themePreference: 'dark', chatWideMode: true, zenMode: true });
        expect(old.personalization).toEqual(personalizationDefaults);
        expect(old).toMatchObject({ themePreference: 'dark', chatWideMode: true, zenMode: true });
    });
    it('repairs an invalid field without losing the remaining preferences', () => {
        const saved = localSettingsParse({ themePreference: 'dark', personalization: { ...PERSONALIZATION_PRESETS.soft, textSize: 999, motion: 'unknown' } });
        expect(saved.themePreference).toBe('dark');
        expect(saved.personalization).toMatchObject({ accent: 'purple', lineHeight: 'relaxed', textSize: 'normal', motion: 'full' });
        expect(localSettingsParse({ zenMode: true, personalization: null })).toMatchObject({ zenMode: true, personalization: personalizationDefaults });
    });
    it('round-trips a preset and a custom override through persistence', () => {
        const settings = applyLocalSettings(localSettingsParse({}), { personalization: { ...PERSONALIZATION_PRESETS.soft, uiFont: 'serif' } });
        const restored = localSettingsParse(JSON.parse(JSON.stringify(settings)));
        expect(restored.personalization).toEqual(settings.personalization);
        expect(matchingPersonalizationPreset(restored.personalization)).toBe('custom');
    });
    it('keeps preset values valid and identifies restored defaults', () => {
        for (const [key, value] of Object.entries(PERSONALIZATION_PRESETS)) {
            expect(PersonalizationSchema.parse(value)).toEqual(value);
            expect(matchingPersonalizationPreset(value)).toBe(key);
            const metrics = personalizationMetrics(value);
            expect(metrics.sidebarWidth).toBeGreaterThanOrEqual(300);
            expect(metrics.sidebarWidth).toBeLessThanOrEqual(400);
            expect(metrics.textScale * metrics.lineScale).toBeGreaterThan(0.7);
        }
        expect(matchingPersonalizationPreset({ ...personalizationDefaults })).toBe('classic');
    });
    it('persists all new font choices without falling back to Plex', () => {
        for (const uiFont of UI_FONT_CHOICES) {
            const saved = localSettingsParse({ personalization: { ...personalizationDefaults, uiFont } });
            expect(localSettingsParse(JSON.parse(JSON.stringify(saved))).personalization.uiFont).toBe(uiFont);
        }
    });
    it('adds reading layouts to existing preferences without replacing fonts or spacing', () => {
        const old = { uiFont: 'magazine', codeFont: 'songti', lineHeight: 'relaxed', textSize: 'large' };
        expect(localSettingsParse({ personalization: old }).personalization).toMatchObject({ ...old, readingStyle: 'standard' });
        for (const readingStyle of ['standard', 'editorial', 'academic']) {
            const saved = localSettingsParse({ personalization: { ...old, readingStyle } });
            expect(localSettingsParse(JSON.parse(JSON.stringify(saved))).personalization).toMatchObject({ ...old, readingStyle });
        }
        expect(localSettingsParse({ personalization: { ...old, readingStyle: 'unknown' } }).personalization).toMatchObject({ ...old, readingStyle: 'standard' });
    });
    it('respects reduced motion even with the full preset selected', () => {
        for (const motion of ['off', 'gentle', 'full'] as const) {
            expect(motionDuration(effectiveMotion(motion, true), 260)).toBe(0);
        }
        expect(motionDuration(effectiveMotion('gentle', false), 260)).toBe(140);
        expect(motionDuration(effectiveMotion('full', false), 260)).toBe(260);
    });
});

it('persists code fonts independently and resolves live inheritance for every weight', () => {
    for (const codeFont of CODE_FONT_CHOICES) {
        const saved = localSettingsParse({ personalization: { codeFont, uiFont: 'songti' } });
        expect(localSettingsParse(JSON.parse(JSON.stringify(saved))).personalization.codeFont).toBe(codeFont);
    }
    for (const weight of ['regular', 'italic', 'semiBold'] as const) {
        expect(resolveCodeFont('inherit', 'songti', weight)).toBe(resolveUIFont('songti', weight));
        expect(resolveCodeFont('inherit', 'magazine', weight)).toBe(resolveUIFont('magazine', weight));
        expect(resolveCodeFont('songti', 'plex', weight)).toBe(resolveCodeFont('songti', 'magazine', weight));
        expect(resolveCodeFont('plex', 'songti', weight)).toContain('IBMPlexMono');
    }
});
