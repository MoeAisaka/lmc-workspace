import React from 'react';
// @ts-expect-error local renderer has no declarations
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
    View: 'View',
    ScrollView: 'ScrollView',
    Pressable: 'Pressable',
    Platform: {
        OS: 'web',
        select: (map: Record<string, unknown>) => map.web ?? map.default,
    },
}));

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('react-native-reanimated', () => ({
    default: { View: 'AnimatedView' },
    Easing: { out: (fn: any) => fn, in: (fn: any) => fn, cubic: {} },
    runOnJS: (fn: any) => fn,
    useSharedValue: (v: any) => ({ value: v }),
    useAnimatedStyle: (fn: () => any) => fn(),
    withTiming: (v: any, _cfg?: any, cb?: (done: boolean) => void) => {
        cb?.(true);
        return v;
    },
}));

vi.mock('react-native-unistyles', () => {
    const theme = {
        dark: false,
        personalization: { messageGap: 8 },
        colors: {
            surface: '#ffffff',
            surfaceHigh: '#f8f8f8',
            surfacePressed: '#f0f0f2',
            divider: '#e5e7eb',
            text: '#111827',
            textSecondary: '#6b7280',
            textLink: '#0060F0',
            radio: { active: '#0060F0' },
            groupped: { chevron: '#9ca3af', background: '#f9fafb', sectionTitle: '#6b7280' },
        },
    };
    return {
        useUnistyles: () => ({ theme }),
        StyleSheet: {
            hairlineWidth: 1,
            absoluteFillObject: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
            create: (styles: any) => (typeof styles === 'function' ? styles(theme, {}) : styles),
        },
    };
});

vi.mock('@/hooks/usePersonalizationMotion', () => ({
    usePersonalizationMotion: () => 'gentle',
}));

vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { FlatSettingsContext } from './settings/flatSettings';
import { SettingsMenuHost, SettingsSelect } from './SettingsSelect';

function flattenStyle(styleProp: unknown): Record<string, unknown> {
    if (!styleProp) return {};
    if (Array.isArray(styleProp)) {
        return styleProp.reduce<Record<string, unknown>>((acc, item) => ({ ...acc, ...flattenStyle(item) }), {});
    }
    if (typeof styleProp === 'object') {
        return styleProp as Record<string, unknown>;
    }
    return {};
}

describe('SettingsSelect button layer & menu interaction', () => {
    it('renders generous horizontal padding and pill border in flat settings mode', () => {
        const onChange = vi.fn();
        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(
                React.createElement(
                    FlatSettingsContext.Provider,
                    { value: true },
                    React.createElement(SettingsMenuHost, {
                        children: React.createElement(SettingsSelect, {
                            title: '外观',
                            value: 'adaptive',
                            options: [
                                { value: 'adaptive', label: '自适应' },
                                { value: 'light', label: '浅色' },
                                { value: 'dark', label: '深色' },
                            ],
                            onChange,
                        }),
                    }),
                ),
            );
        });

        const trigger = renderer.root.findByProps({ accessibilityLabel: '外观: 自适应' });
        const restingStyle = flattenStyle(
            typeof trigger.props.style === 'function' ? trigger.props.style({ pressed: false }) : trigger.props.style,
        );

        expect(Number(restingStyle.paddingLeft)).toBeGreaterThanOrEqual(12);
        expect(Number(restingStyle.paddingRight)).toBeGreaterThanOrEqual(10);
        expect(Number(restingStyle.gap)).toBeGreaterThanOrEqual(6);
        expect(restingStyle.borderWidth).toBe(1);
        expect(restingStyle.borderRadius).toBe(10);
        expect(trigger.props.accessibilityState).toEqual({ expanded: false, disabled: false });
    });

    it('tracks expanded state and selects an option cleanly', () => {
        vi.stubGlobal('document', {
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        });
        const onChange = vi.fn();
        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(
                React.createElement(
                    FlatSettingsContext.Provider,
                    { value: true },
                    React.createElement(SettingsMenuHost, {
                        children: React.createElement(SettingsSelect, {
                            title: '外观',
                            value: 'adaptive',
                            options: [
                                { value: 'adaptive', label: '自适应' },
                                { value: 'dark', label: '深色' },
                            ],
                            onChange,
                        }),
                    }),
                ),
            );
        });

        const getTrigger = () => renderer.root.findByProps({ accessibilityLabel: '外观: 自适应' });
        act(() => {
            getTrigger().props.onPress();
        });

        expect(getTrigger().props.accessibilityState.expanded).toBe(true);
        expect(renderer.root.findAllByProps({ testID: 'settings-select-menu' }).length).toBeGreaterThan(0);

        const darkRow = renderer.root.findAllByType('Pressable' as any).find((node: any) => {
            const textChildren = node.findAllByType('Text' as any);
            return textChildren.some((textNode: any) => textNode.props.children === '深色');
        });
        expect(darkRow).toBeDefined();

        act(() => {
            darkRow!.props.onPress();
        });

        expect(onChange).toHaveBeenCalledWith('dark');
        expect(getTrigger().props.accessibilityState.expanded).toBe(false);
        vi.unstubAllGlobals();
    });
});
