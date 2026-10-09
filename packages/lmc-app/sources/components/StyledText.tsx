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

export const Text = React.forwardRef<RNText, StyledTextProps>(function StyledText({
  style,
  useDefaultTypography = true,
  selectable = false,
  ...props
}, ref) {
  const nested = React.useContext(TextTypographyContext);
  const flat = StyleSheet.flatten(style);
  const weight = flat?.fontWeight;
  const face = weight === 'bold' || Number(weight) >= 600 ? 'semiBold' : flat?.fontStyle === 'italic' ? 'italic' : 'regular';
  // Nested Web text inherits the parent's code/body face unless explicitly styled.
  const defaultStyle = useDefaultTypography && (!nested || Platform.OS !== 'web') ? Typography.default(face) : {};

  return (
    <TextTypographyContext.Provider value={true}>
    <RNText
      ref={ref}
      style={[defaultStyle, style]}
      selectable={selectable}
      {...props}
    />
    </TextTypographyContext.Provider>
  );
});

// Export the original RNText as well, in case it's needed
export { Text as RNText } from 'react-native';
