import { Platform } from 'react-native';

// Unistyles CSSVars tracks string colors, but numeric theme tokens are baked
// into web styles. Keep adjustable lengths as CSS expressions so already
// mounted (including memoized/virtualized) content updates without a remount.
// RN's numeric length type does not describe the web CSS calc()/var() values.
export const conversationFontSize = (base: number): number => Platform.OS === 'web'
    ? `calc(${base}px * var(--lmc-text-scale, 1))` as unknown as number : base;
export const conversationLineHeight = (base: number): number => Platform.OS === 'web'
    ? `calc(${base}px * var(--lmc-text-scale, 1) * var(--lmc-line-scale, 1))` as unknown as number : base;
export const conversationRowPadding = (): number => Platform.OS === 'web'
    ? 'var(--lmc-row-padding, 8px)' as unknown as number : 8;
export const conversationMessagePadding = (): number => Platform.OS === 'web'
    ? 'var(--lmc-message-padding, 0px)' as unknown as number : 0;
