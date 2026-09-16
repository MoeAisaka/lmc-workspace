import type { Theme } from '@/theme';

/**
 * LMC status palette from the approved Figma tokens. Kept beside the
 * components that use it rather than in the shared theme so the redesign
 * can ship without touching every screen's colours.
 */
export function lmcColors(theme: Theme) {
    const dark = theme.dark;
    return {
        attention: '#E8590C',
        attentionSoft: dark ? 'rgba(232, 89, 12, 0.16)' : '#FFF1E8',
        working: '#0060F0',
        idle: dark ? '#6B6B70' : '#B4B4B4',
        offline: dark ? '#4A4A4F' : '#D6D6D6',
        rowSelected: dark ? 'rgba(255,255,255,0.08)' : '#ECECEC',
        subtle: dark ? 'rgba(255,255,255,0.06)' : '#F3F3F3',
        border: dark ? 'rgba(255,255,255,0.12)' : '#E5E5E5',
        brand: '#0060F0',
        inverse: dark ? '#FFFFFF' : '#0D0D0D',
        onInverse: dark ? '#0D0D0D' : '#FFFFFF',
        tertiary: dark ? '#9A9A9F' : '#8F8F8F',
        placeholder: dark ? '#6F6F74' : '#AFAFAF',
    };
}
