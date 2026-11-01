import React from 'react';
// @ts-expect-error local renderer has no declarations
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const { flatten } = vi.hoisted(() => {
    const fn = (style: any): any => {
        if (!style) return {};
        if (Array.isArray(style)) return Object.assign({}, ...style.map(fn));
        return style;
    };
    return { flatten: fn };
});

vi.mock('react-native', () => ({
    Text: 'RNText',
    TextInput: 'TextInput',
    View: 'View',
    Platform: { OS: 'web', select: (map: Record<string, unknown>) => map.web ?? map.default },
    StyleSheet: { flatten, hairlineWidth: 1 },
}));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { input: { text: '#111', placeholder: '#888' } } } }),
}));

import { BODY_LINE_HEIGHT_RATIO, Text } from './StyledText';
import { MULTI_TEXT_INPUT_FONT_SIZE, MULTI_TEXT_INPUT_LINE_HEIGHT } from './MultiTextInput';
import {
    MULTI_TEXT_INPUT_FONT_SIZE as WEB_FONT_SIZE,
    MULTI_TEXT_INPUT_LINE_HEIGHT as WEB_LINE_HEIGHT,
} from './MultiTextInput.web';
import { readingStyles } from './markdown/readingStyles';

describe('LMC 1.75 body line-height baseline', () => {
    it('sets composer and prose reading layouts to 1.75 line-height', () => {
        expect(BODY_LINE_HEIGHT_RATIO).toBe(1.75);
        expect(MULTI_TEXT_INPUT_LINE_HEIGHT / MULTI_TEXT_INPUT_FONT_SIZE).toBe(1.75);
        expect(WEB_LINE_HEIGHT / WEB_FONT_SIZE).toBe(1.75);
        expect(readingStyles).toContain('[data-lmc-prose] { min-width: 0; overflow-wrap: anywhere; line-height: 1.75; }');
        expect(readingStyles).toContain('font-size: calc(16px * var(--lmc-text-scale, 1)); line-height: calc(28px * var(--lmc-text-scale, 1) * var(--lmc-line-scale, 1));');
    });

    it('applies 1.75 default line-height to regular body Text without bloating headings, KPIs, or single-line labels', () => {
        let root!: { root: any };
        act(() => {
            root = create(
                React.createElement(
                    React.Fragment,
                    null,
                    React.createElement(Text, { testID: 'body', style: { fontSize: 16 } }, 'Body paragraph'),
                    React.createElement(Text, { testID: 'single-line', numberOfLines: 1, style: { fontSize: 14 } }, 'Truncated label'),
                    React.createElement(Text, { testID: 'bold', style: { fontSize: 14, fontWeight: '600' } }, 'Button label'),
                    React.createElement(Text, { testID: 'kpi', style: { fontSize: 34 } }, '99%'),
                    React.createElement(Text, { testID: 'explicit', style: { fontSize: 14, lineHeight: 18 } }, 'Explicit line-height'),
                ),
            );
        });

        const lineHeightOf = (testID: string) =>
            flatten(root.root.find((node: any) => node.type === 'RNText' && node.props.testID === testID).props.style)?.lineHeight;
        expect([28, '1.75']).toContain(lineHeightOf('body'));
        expect(lineHeightOf('single-line')).toBeUndefined();
        expect(lineHeightOf('bold')).toBeUndefined();
        expect(lineHeightOf('kpi')).toBeUndefined();
        expect(lineHeightOf('explicit')).toBe(18);
    });
});
