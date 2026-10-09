import type { Personalization } from './personalization';

export const UI_FONT_CHOICES = ['plex', 'system', 'serif', 'songti', 'magazine', 'claude', 'misans', 'wenkai', 'newsreader', 'sourceSerif', 'sarasa'] as const;
export const CODE_FONT_CHOICES = ['inherit', 'plex', 'system', 'sarasa', 'jetbrains', ...UI_FONT_CHOICES.filter(font => font !== 'plex' && font !== 'system' && font !== 'sarasa')] as const;
export type AssetFont = Exclude<Personalization['codeFont'], 'inherit'>;
export type FontWeight = 'regular' | 'italic' | 'semiBold';
export const FONT_HINT_KEYS = {
    songti: 'songtiHint', magazine: 'magazineHint', claude: 'claudeHint',
    misans: 'misansHint', wenkai: 'wenkaiHint', newsreader: 'newsreaderHint',
    sourceSerif: 'sourceSerifHint', sarasa: 'sarasaHint', jetbrains: 'jetbrainsHint',
} as const;
const songti = '"LMC Songti", "Songti SC", "Noto Serif CJK SC", SimSun, serif';
export function resolveUIFont(font: Personalization['uiFont'], weight: FontWeight): string {
    switch (font) {
        case 'sarasa': return '"LMC Sarasa Mono", ui-monospace, "SFMono-Regular", Menlo, monospace';
        case 'system': return '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
        case 'serif': return 'Georgia, "Songti SC", "Noto Serif CJK SC", serif';
        case 'songti': return songti;
        case 'magazine': return '"LMC Magazine", "FangSong", "STFangsong", ' + songti;
        // Match the named Desktop font when locally installed, without copying
        // proprietary application resources. The fallback is explicitly labelled.
        case 'claude': return '"LMC Claude Serif", Georgia, ' + songti;
        case 'misans': return '"LMC MiSans", "PingFang SC", "Microsoft YaHei", sans-serif';
        case 'wenkai': return '"LMC WenKai", "Kaiti SC", "STKaiti", ' + songti;
        case 'newsreader': return '"LMC Newsreader", ' + songti;
        case 'sourceSerif': return '"LMC Source Serif", ' + songti;
        default: return `"IBMPlexSans-${{ regular: 'Regular', italic: 'Italic', semiBold: 'SemiBold' }[weight]}"`;
    }
}

export function codeAssetFont(codeFont: Personalization['codeFont'], uiFont: Personalization['uiFont']): AssetFont {
    return codeFont === 'inherit' ? uiFont : codeFont;
}
export function resolveCodeFont(codeFont: Personalization['codeFont'], uiFont: Personalization['uiFont'], weight: FontWeight): string {
    if (codeFont === 'plex') return `"IBMPlexMono-${{ regular: 'Regular', italic: 'Italic', semiBold: 'SemiBold' }[weight]}"`;
    if (codeFont === 'system') return 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';
    if (codeFont === 'sarasa') return '"LMC Sarasa Mono", ui-monospace, Menlo, monospace';
    if (codeFont === 'jetbrains') return '"LMC JetBrains Mono", "LMC Sarasa Mono", ui-monospace, Menlo, monospace';
    return resolveUIFont(codeFont === 'inherit' ? uiFont : codeFont, weight);
}
