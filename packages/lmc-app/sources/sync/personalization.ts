import * as z from 'zod';

// Device-local presentation only. Never sent to an Agent or used as execution settings.
export const PersonalizationSchema = z.object({
    chrome: z.enum(['standard', 'terminal']).catch('standard'),
    motion: z.enum(['off', 'gentle', 'full']).catch('full'),
    uiFont: z.enum(['plex', 'system', 'serif', 'songti', 'magazine', 'claude', 'misans', 'wenkai', 'newsreader', 'sourceSerif', 'sarasa']).catch('plex'),
    codeFont: z.enum(['plex', 'system', 'inherit', 'serif', 'songti', 'magazine', 'claude', 'misans', 'wenkai', 'newsreader', 'sourceSerif', 'sarasa', 'jetbrains']).catch('plex'),
    readingStyle: z.enum(['standard', 'editorial', 'academic']).catch('standard'),
    textSize: z.enum(['small', 'normal', 'large']).catch('normal'),
    lineHeight: z.enum(['compact', 'normal', 'relaxed']).catch('normal'),
    accent: z.enum(['blue', 'green', 'purple', 'rose', 'amber']).catch('blue'),
    density: z.enum(['compact', 'comfortable']).catch('comfortable'),
    sidebarWidth: z.enum(['narrow', 'normal', 'wide']).catch('normal'),
    contentWidth: z.enum(['reading', 'standard']).catch('standard'),
});
export type Personalization = z.infer<typeof PersonalizationSchema>;
export const personalizationDefaults = Object.freeze(PersonalizationSchema.parse({}));
export const PERSONALIZATION_PRESETS = {
    classic: { ...personalizationDefaults },
    focus: { ...personalizationDefaults, motion: 'off', uiFont: 'system', density: 'compact', sidebarWidth: 'narrow' },
    soft: { ...personalizationDefaults, motion: 'gentle', accent: 'purple', lineHeight: 'relaxed' },
    clear: { ...personalizationDefaults, motion: 'gentle', uiFont: 'system', textSize: 'large', lineHeight: 'relaxed', sidebarWidth: 'wide', contentWidth: 'reading' },
    journal: { ...personalizationDefaults, motion: 'gentle', uiFont: 'newsreader', codeFont: 'jetbrains', readingStyle: 'editorial', contentWidth: 'reading' },
    scholar: { ...personalizationDefaults, motion: 'gentle', uiFont: 'sourceSerif', codeFont: 'sarasa', readingStyle: 'academic', contentWidth: 'reading' },
    terminal: { ...personalizationDefaults, chrome: 'terminal', motion: 'off', uiFont: 'sarasa', codeFont: 'sarasa', accent: 'green', density: 'compact' },
} as const satisfies Record<string, Personalization>;
export type PersonalizationPreset = keyof typeof PERSONALIZATION_PRESETS;
export function matchingPersonalizationPreset(value: Personalization): PersonalizationPreset | 'custom' {
    return (Object.keys(PERSONALIZATION_PRESETS) as PersonalizationPreset[]).find(key =>
        Object.keys(personalizationDefaults).every(field => value[field as keyof Personalization] === PERSONALIZATION_PRESETS[key][field as keyof Personalization])
    ) ?? 'custom';
}
export function personalizationMetrics(value: Personalization) {
    return {
        textScale: { small: 0.875, normal: 1, large: 1.125 }[value.textSize],
        lineScale: { compact: 0.9, normal: 1, relaxed: 1.2 }[value.lineHeight],
        rowPadding: value.density === 'compact' ? 4 : 8,
        messageGap: value.density === 'compact' ? 0 : 4,
        sidebarWidth: { narrow: 300, normal: 360, wide: 400 }[value.sidebarWidth],
        contentWidth: value.contentWidth === 'reading' ? 720 : 910,
    };
}
export const accentColors = {
    blue: { light: '#0060F0', dark: '#70A7FF' },
    green: { light: '#167047', dark: '#6DD6A4' },
    purple: { light: '#7047C6', dark: '#BDA0FF' },
    rose: { light: '#B33566', dark: '#FF9ABD' },
    amber: { light: '#946200', dark: '#EFC36C' },
} as const;
export function effectiveMotion(motion: Personalization['motion'], reduced: boolean): Personalization['motion'] {
    return reduced ? 'off' : motion;
}
export function motionDuration(motion: Personalization['motion'], fullDuration: number) {
    return motion === 'off' ? 0 : motion === 'gentle' ? Math.min(140, fullDuration) : fullDuration;
}
