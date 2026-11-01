import React from 'react';
import { Text as RNText, TextProps as RNTextProps, StyleProp, TextStyle, StyleSheet, Platform } from 'react-native';
import { Typography } from '@/constants/Typography';

interface StyledTextProps extends RNTextProps {
  /**
   * Whether to use the default typography. Set to false to skip default font.
   * Useful when you want to use a different typography style.
   */
  useDefaultTypography?: boolean;
  /**
   * Whether the text should be selectable. Defaults to false.
   */
  selectable?: boolean;
}

const TextTypographyContext = React.createContext(false);

export const BODY_LINE_HEIGHT_RATIO = 1.75;

function flattenStyle(style: unknown): TextStyle | undefined {
  if (StyleSheet?.flatten) return StyleSheet.flatten(style as StyleProp<TextStyle>);
  if (!style) return undefined;
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle).filter(Boolean));
  return style as TextStyle;
}

export const Text = React.forwardRef<RNText, StyledTextProps>(function StyledText({
  style,
  useDefaultTypography = true,
  selectable = false,
  ...props
}, ref) {
  const nested = React.useContext(TextTypographyContext);
  const flat = flattenStyle(style);
  const weight = flat?.fontWeight;
  const face = weight === 'bold' || Number(weight) >= 600 ? 'semiBold' : flat?.fontStyle === 'italic' ? 'italic' : 'regular';
  const fontSize = typeof flat?.fontSize === 'number' ? flat.fontSize : undefined;
  const applyBodyLineHeight = useDefaultTypography
    && !nested
    && flat?.lineHeight == null
    && props.numberOfLines !== 1
    && face !== 'semiBold'
    && (fontSize === undefined || fontSize <= 18);
  const bodyLineHeightStyle = applyBodyLineHeight
    ? { lineHeight: Platform.OS === 'web' ? (String(BODY_LINE_HEIGHT_RATIO) as unknown as number) : Math.round((fontSize ?? 14) * BODY_LINE_HEIGHT_RATIO) }
    : undefined;
  // Nested Web text inherits the parent's code/body face unless explicitly styled.
  const defaultStyle = useDefaultTypography && (!nested || Platform.OS !== 'web') ? Typography.default(face) : {};

  return (
    <TextTypographyContext.Provider value={true}>
    <RNText
      ref={ref}
      style={[defaultStyle, bodyLineHeightStyle, style]}
      selectable={selectable}
      {...props}
    />
    </TextTypographyContext.Provider>
  );
});

// Export the original RNText as well, in case it's needed
export { Text as RNText } from 'react-native';
