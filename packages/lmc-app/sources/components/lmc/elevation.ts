import { Platform } from 'react-native';
import type { Theme } from '@/theme';

/**
 * One elevation scale for every floating surface, so a menu never reads as
 * heavier than the dialog above it. Levels map to how far a surface sits from
 * the page: 1 resting cards, 2 the composer and chips, 3 popovers and menus,
 * 4 modals and the phone drawer.
 *
 * Each level is two shadows — a tight contact shadow that anchors the edge and
 * a wide ambient one that gives depth — which is what makes a flat rectangle
 * read as a physical surface. Dark themes get stronger, larger shadows plus a
 * hairline border, since a shadow alone is nearly invisible on a dark ground.
 */
export type LmcElevationLevel = 1 | 2 | 3 | 4;

const LIGHT: Record<LmcElevationLevel, string> = {
    1: '0 1px 2px rgba(16,24,40,0.05), 0 1px 3px rgba(16,24,40,0.04)',
    2: '0 2px 4px rgba(16,24,40,0.05), 0 8px 24px rgba(16,24,40,0.08)',
    3: '0 4px 10px rgba(16,24,40,0.07), 0 16px 40px rgba(16,24,40,0.13)',
    4: '0 8px 20px rgba(16,24,40,0.10), 0 32px 64px rgba(16,24,40,0.20)',
};

const DARK: Record<LmcElevationLevel, string> = {
    1: '0 1px 2px rgba(0,0,0,0.40), 0 1px 4px rgba(0,0,0,0.30)',
    2: '0 2px 6px rgba(0,0,0,0.45), 0 10px 28px rgba(0,0,0,0.45)',
    3: '0 6px 14px rgba(0,0,0,0.50), 0 20px 48px rgba(0,0,0,0.55)',
    4: '0 10px 28px rgba(0,0,0,0.55), 0 36px 72px rgba(0,0,0,0.65)',
};

const NATIVE: Record<LmcElevationLevel, { height: number; radius: number; opacity: number; elevation: number }> = {
    1: { height: 1, radius: 2, opacity: 0.06, elevation: 1 },
    2: { height: 4, radius: 12, opacity: 0.10, elevation: 3 },
    3: { height: 10, radius: 24, opacity: 0.16, elevation: 8 },
    4: { height: 18, radius: 40, opacity: 0.24, elevation: 16 },
};

export function lmcElevation(theme: Theme, level: LmcElevationLevel) {
    if (Platform.OS === 'web') {
        return { boxShadow: (theme.dark ? DARK : LIGHT)[level] } as any;
    }
    const spec = NATIVE[level];
    return {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: spec.height },
        shadowRadius: spec.radius,
        shadowOpacity: theme.dark ? Math.min(1, spec.opacity * 2.4) : spec.opacity,
        elevation: spec.elevation,
    };
}

/** Hairline that keeps a raised surface legible where a shadow cannot carry the edge. */
export function lmcSurfaceBorder(theme: Theme) {
    return { borderWidth: 1, borderColor: theme.dark ? 'rgba(255,255,255,0.10)' : 'rgba(16,24,40,0.08)' };
}
