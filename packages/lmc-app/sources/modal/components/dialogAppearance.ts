import { Platform } from 'react-native';
import type { Theme } from '@/theme';
import { lmcElevation, lmcSurfaceBorder } from '@/components/lmc/elevation';

/** Same spacing, radius and elevation as LMC's settings and menus. */
export function dialogAppearance(theme: Theme) {
    if (Platform.OS !== 'web') return {};
    return {
        container: { width: 400, maxWidth: 'calc(100vw - 32px)' as any, borderRadius: 20, ...lmcElevation(theme, 4), ...lmcSurfaceBorder(theme) },
        content: { paddingHorizontal: 24, paddingTop: 24, paddingBottom: 20, alignItems: 'stretch' as const },
        title: { fontSize: 18, lineHeight: 26, textAlign: 'left' as const, marginBottom: 4 },
        message: { fontSize: 14, lineHeight: 22, textAlign: 'left' as const, color: theme.colors.textSecondary },
        input: { minHeight: 44, height: 44, borderRadius: 10, paddingHorizontal: 12 },
        buttonContainer: { borderTopWidth: 0, paddingHorizontal: 16, paddingBottom: 16, gap: 8, justifyContent: 'flex-end' as const, flexWrap: 'wrap' as const },
        button: { flex: 0, minHeight: 44, minWidth: 76, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, backgroundColor: theme.colors.surfaceHigh },
        buttonText: { fontSize: 14, lineHeight: 20, color: theme.colors.text },
        buttonSeparator: { display: 'none' as const },
    };
}
