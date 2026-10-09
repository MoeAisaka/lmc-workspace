import { resolveUIFont, resolveCodeFont, codeAssetFont } from '@/sync/personalizationFonts';
import { loadUIFont } from '@/utils/personalizationFontAssets';
import * as React from 'react';
import { Platform } from 'react-native';
import { UnistylesRuntime, useUnistyles } from 'react-native-unistyles';
import { readingStyles } from '@/components/markdown/readingStyles';
import { useLocalSetting } from '@/sync/storage';
import { lightTheme, darkTheme } from '@/theme';
import { accentColors, personalizationMetrics } from '@/sync/personalization';
import { usePersonalizationMotion } from '@/hooks/usePersonalizationMotion';
import { personalizationPalette, terminalChromeStyles } from '@/sync/personalizationPalette';

/** One subscription for presentation changes; no session/provider restart. */
export function PersonalizationRuntime() {
    const value = useLocalSetting('personalization');
    const motion = usePersonalizationMotion();
    const { theme } = useUnistyles();
    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web') return;
        const sheet = document.createElement('style');
        sheet.dataset.lmcReadingStyles = 'true';
        sheet.textContent = readingStyles + terminalChromeStyles;
        document.head.appendChild(sheet);
        return () => { sheet.remove(); };
    }, []);
    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web') return;
        const root = document.documentElement;
        const palette = personalizationPalette(theme.dark ? darkTheme : lightTheme, value);
        root.style.setProperty('--lmc-prose-accent', accentColors[value.accent][theme.dark ? 'dark' : 'light']);
        root.style.setProperty('--lmc-prose-divider', palette.divider);
        root.style.setProperty('--lmc-prose-tint', palette.surfaceHigh);
        root.dataset.lmcReadingStyle = value.readingStyle;
        root.style.setProperty('--lmc-terminal-border', palette.divider);
    }, [value.readingStyle, value.accent, value.chrome, theme.dark]);
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        let current = true;
        const publish = (status: string) => {
            if (!current) return;
            document.documentElement.dataset.lmcFontStatus = status;
            window.dispatchEvent(new Event('lmc-font-status'));
        };
        publish('loading');
        void loadUIFont(value.uiFont).then(publish, () => publish('fallback'));
        return () => { current = false; };
    }, [value.uiFont]);
    const codeAsset = codeAssetFont(value.codeFont, value.uiFont);
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        let current = true;
        const publish = (status: string) => {
            if (!current) return;
            document.documentElement.dataset.lmcCodeFontStatus = status;
            window.dispatchEvent(new Event('lmc-font-status'));
        };
        publish('loading');
        void loadUIFont(codeAsset).then(publish, () => publish('fallback'));
        return () => { current = false; };
    }, [codeAsset]);
    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web') return;
        const root = document.documentElement;
        for (const weight of ['regular', 'italic', 'semiBold'] as const) {
            root.style.setProperty(`--lmc-font-${weight}`, resolveUIFont(value.uiFont, weight));
            root.style.setProperty(`--lmc-code-${weight}`, resolveCodeFont(value.codeFont, value.uiFont, weight));
        }
        root.dataset.lmcChrome = value.chrome;
        if (value.chrome === 'terminal') {
            root.style.setProperty('--lmc-elevation', 'none');
            root.style.setProperty('--lmc-surface-border', 'var(--lmc-terminal-border)');
        } else {
            root.style.removeProperty('--lmc-elevation');
            root.style.removeProperty('--lmc-surface-border');
        }
        // Plex uses separate already-weighted faces; other families may only
        // have a regular face and need synthesis to preserve semantic emphasis.
        root.style.setProperty('--lmc-font-synthesis', value.uiFont === 'plex' ? 'none' : 'weight style');
        root.style.setProperty('--lmc-code-synthesis', codeAssetFont(value.codeFont, value.uiFont) === 'plex' ? 'none' : 'weight style');
        root.dataset.lmcMotion = motion;
        root.style.setProperty('--lmc-motion-duration', motion === 'off' ? '0ms' : motion === 'gentle' ? '140ms' : '220ms');
        root.style.setProperty('--lmc-motion-distance', motion === 'gentle' ? '2px' : '8px');
        const metrics = personalizationMetrics(value);
        root.style.setProperty('--lmc-text-scale', String(metrics.textScale));
        root.style.setProperty('--lmc-line-scale', String(metrics.lineScale));
        root.style.setProperty('--lmc-row-padding', `${metrics.rowPadding}px`);
        root.style.setProperty('--lmc-message-padding', `${metrics.messageGap / 2}px`);
        for (const [name, base] of [['light', lightTheme], ['dark', darkTheme]] as const) {
            UnistylesRuntime.updateTheme(name, current => ({
                ...current,
                personalization: metrics,
                colors: personalizationPalette(base, value),
            }));
        }
    }, [value, motion]);
    return null;
}
