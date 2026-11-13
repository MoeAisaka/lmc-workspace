import type { ViewStyle } from 'react-native';

/** A glyph needs space around it for its feedback to remain visible. */
export const iconActionFrame = {
    width: 28, height: 28, borderRadius: 8,
    flexGrow: 0, flexShrink: 0, flexBasis: 'auto',
    alignItems: 'center', justifyContent: 'center', padding: 0,
} satisfies ViewStyle;

/** Removal actions inside a compact chip must fit within the chip's own height. */
export const smallIconActionFrame = {
    ...iconActionFrame, width: 20, height: 20, borderRadius: 6,
} satisfies ViewStyle;

export const textActionFrame = {
    minHeight: 28, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 4,
    justifyContent: 'center',
} satisfies ViewStyle;
