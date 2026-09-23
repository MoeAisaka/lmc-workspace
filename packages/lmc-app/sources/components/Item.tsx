import * as React from 'react';
import { 
    View, 
    Text, 
    StyleProp, 
    ViewStyle, 
    TextStyle,
    Platform,
    ActivityIndicator
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import * as Clipboard from 'expo-clipboard';
import { Modal } from '@/modal';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useFlatSettings } from './lmc/settings/flatSettings';
import { BubblePressable } from './BubblePressable';

export interface ItemProps {
    title: string;
    subtitle?: string;
    subtitleLines?: number; // defaults to 2; set 0 for unlimited
    detail?: string;
    icon?: React.ReactNode;
    leftElement?: React.ReactNode;
    rightElement?: React.ReactNode;
    onPress?: () => void;
    onLongPress?: () => void;
    disabled?: boolean;
    loading?: boolean;
    selected?: boolean;
    destructive?: boolean;
    style?: StyleProp<ViewStyle>;
    titleStyle?: StyleProp<TextStyle>;
    subtitleStyle?: StyleProp<TextStyle>;
    detailStyle?: StyleProp<TextStyle>;
    showChevron?: boolean;
    showDivider?: boolean;
    dividerInset?: number;
    pressableStyle?: StyleProp<ViewStyle>;
    copy?: boolean | string;
}

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        minHeight: Platform.select({ ios: 44, default: 56 }),
    },
    containerWithSubtitle: {
        paddingVertical: Platform.select({ ios: 11, default: 16 }),
    },
    containerWithoutSubtitle: {
        paddingVertical: Platform.select({ ios: 12, default: 16 }),
    },
    iconContainer: {
        marginRight: 12,
        width: Platform.select({ ios: 29, default: 32 }),
        height: Platform.select({ ios: 29, default: 32 }),
        alignItems: 'center',
        justifyContent: 'center',
    },
    centerContent: {
        flex: 1,
        justifyContent: 'center',
    },
    title: {
        ...Typography.default('regular'),
        fontSize: Platform.select({ ios: 17, default: 16 }),
        lineHeight: Platform.select({ ios: 22, default: 24 }),
        letterSpacing: Platform.select({ ios: -0.41, default: 0.15 }),
    },
    titleNormal: {
        color: theme.colors.text,
    },
    titleSelected: {
        color: theme.colors.text,
    },
    titleDestructive: {
        color: theme.colors.textDestructive,
    },
    subtitle: {
        ...Typography.default('regular'),
        color: theme.colors.textSecondary,
        fontSize: Platform.select({ ios: 15, default: 14 }),
        lineHeight: 20,
        letterSpacing: Platform.select({ ios: -0.24, default: 0.1 }),
        marginTop: Platform.select({ ios: 2, default: 0 }),
    },
    rightSection: {
        flexDirection: 'row',
        alignItems: 'center',
        marginLeft: 8,
    },
    detail: {
        ...Typography.default('regular'),
        color: theme.colors.textSecondary,
        fontSize: 17,
        letterSpacing: -0.41,
    },
    divider: {
        height: Platform.select({ ios: 0.33, default: 0 }),
        backgroundColor: Platform.select({ web: theme.colors.divider, default: theme.colors.glass.divider }),
    },
    pressablePressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    flatContainer: { paddingHorizontal: 0, minHeight: 56, paddingVertical: 8 },
    flatCenter: { minWidth: 0 },
    flatRight: { flexShrink: 1, maxWidth: '50%', marginLeft: 16 },
    flatIcon: { width: 24, height: 24, marginRight: 12, transform: [{ scale: 0.8 }] },
    flatTitle: { fontSize: 15, lineHeight: 22, letterSpacing: 0 },
    flatSubtitle: { fontSize: 13, lineHeight: 19, letterSpacing: 0, marginTop: 4 },
    flatDetail: { fontSize: 15, letterSpacing: 0 },
    flatDivider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.divider, opacity: 0.55 },
}));

export const Item = React.memo<ItemProps>((props) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const flat = useFlatSettings();
    
    // Platform-specific measurements
    const isIOS = Platform.OS === 'ios';
    const isAndroid = Platform.OS === 'android';
    const isWeb = Platform.OS === 'web';
    
    // Timer ref for long press copy functionality
    const longPressTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    
    const {
        title,
        subtitle,
        subtitleLines,
        detail,
        icon,
        leftElement,
        rightElement,
        onPress,
        onLongPress,
        disabled,
        loading,
        selected,
        destructive,
        style,
        titleStyle,
        subtitleStyle,
        detailStyle,
        showChevron = true,
        showDivider = true,
        dividerInset = isIOS ? 15 : 16,
        pressableStyle,
        copy
    } = props;

    // Handle copy functionality
    const handleCopy = React.useCallback(async () => {
        if (!copy || isWeb) return;
        
        let textToCopy: string;
        
        if (typeof copy === 'string') {
            // If copy is a string, use it directly
            textToCopy = copy;
        } else {
            // If copy is true, try to figure out what to copy
            // Priority: detail > subtitle > title
            textToCopy = detail || subtitle || title;
        }
        
        try {
            await Clipboard.setStringAsync(textToCopy);
            Modal.alert(t('common.copied'), t('items.copiedToClipboard', { label: title }));
        } catch (error) {
            console.error('Failed to copy:', error);
        }
    }, [copy, isWeb, title, subtitle, detail]);
    
    // Handle long press for copy functionality
    const handlePressIn = React.useCallback(() => {
        if (copy && !isWeb && !onPress) {
            longPressTimer.current = setTimeout(() => {
                handleCopy();
            }, 500); // 500ms delay for long press
        }
    }, [copy, isWeb, onPress, handleCopy]);
    
    const handlePressOut = React.useCallback(() => {
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    }, []);
    
    // Clean up timer on unmount
    React.useEffect(() => {
        return () => {
            if (longPressTimer.current) {
                clearTimeout(longPressTimer.current);
            }
        };
    }, []);
    
    // If copy is enabled and no onPress is provided, don't set a regular press handler
    // The copy will be handled by long press instead
    const handlePress = onPress;
    
    const isInteractive = handlePress || onLongPress || (copy && !isWeb);
    const showAccessory = isInteractive && showChevron && !rightElement;
    const chevronSize = (isIOS && !isWeb) ? 17 : 24;

    const titleColor = destructive ? styles.titleDestructive : (selected ? styles.titleSelected : styles.titleNormal);
    const containerPadding = subtitle ? styles.containerWithSubtitle : styles.containerWithoutSubtitle;
    
    const content = (
        <>
            <View style={[styles.container, containerPadding, flat && styles.flatContainer, style]}>
                {/* Left Section */}
                {/* The settings dialog reads as a list of labels: coloured glyphs
                    in every row competed with the values on the right. */}
                {(leftElement || (icon && !flat)) && (
                    <View style={[styles.iconContainer, flat && styles.flatIcon]}>
                        {leftElement || icon}
                    </View>
                )}

                {/* Center Section */}
                <View style={[styles.centerContent, flat && styles.flatCenter]}>
                    <Text 
                        style={[styles.title, titleColor, flat && styles.flatTitle, titleStyle]}
                        numberOfLines={flat ? undefined : subtitle ? 1 : 2}
                    >
                        {title}
                    </Text>
                    {subtitle && (() => {
                        // Settings descriptions frequently need a second line, especially in
                        // translated copy. The row already sizes to its content, so keep short
                        // subtitles compact and allow longer ones to grow by one line.
                        const effectiveLines = subtitleLines !== undefined
                            ? (subtitleLines <= 0 ? undefined : subtitleLines)
                            : (flat || (typeof subtitle === 'string' && subtitle.indexOf('\n') !== -1) ? undefined : 2);
                        return (
                            <Text
                                style={[styles.subtitle, flat && styles.flatSubtitle, subtitleStyle]}
                                numberOfLines={effectiveLines}
                            >
                                {subtitle}
                            </Text>
                        );
                    })()}
                </View>

                {/* Right Section */}
                <View style={[styles.rightSection, flat && styles.flatRight]}>
                    {detail && !rightElement && (
                        <Text 
                            style={[
                                styles.detail, 
                                flat && styles.flatDetail,
                                { marginRight: showAccessory ? 6 : 0 },
                                detailStyle
                            ]}
                            numberOfLines={1}
                        >
                            {detail}
                        </Text>
                    )}
                    {loading && (
                        <ActivityIndicator 
                            size="small" 
                            color={theme.colors.textSecondary}
                            style={{ marginRight: showAccessory ? 6 : 0 }}
                        />
                    )}
                    {rightElement}
                    {showAccessory && (
                        <Ionicons 
                            name="chevron-forward" 
                            size={flat ? 16 : chevronSize} 
                            color={theme.colors.groupped.chevron}
                            style={{ marginLeft: 4 }}
                        />
                    )}
                </View>
            </View>

            {/* Divider */}
            {showDivider && (
                <View 
                    style={[
                        styles.divider,
                        flat && styles.flatDivider,
                        { 
                            marginLeft: flat ? 0 : (isAndroid || isWeb) ? 0 : (dividerInset + (icon || leftElement ? (16 + ((isIOS && !isWeb) ? 29 : 32) + 15) : 16))
                        }
                    ]}
                />
            )}
        </>
    );

    if (isInteractive) {
        return (
            <BubblePressable
                onPress={handlePress}
                onLongPress={onLongPress}
                onPressIn={handlePressIn}
                onPressOut={handlePressOut}
                disabled={disabled || loading}
                bubbleScale={1.012}
                style={[
                    {
                        backgroundColor: 'transparent',
                        opacity: disabled ? 0.5 : 1
                    },
                    pressableStyle
                ]}
                pressedStyle={isIOS && !isWeb ? styles.pressablePressed : undefined}
                android_ripple={(isAndroid || isWeb) ? {
                    color: theme.colors.surfaceRipple,
                    borderless: false,
                    foreground: true
                } : undefined}
            >
                {content}
            </BubblePressable>
        );
    }

    return <View style={[{ opacity: disabled ? 0.5 : 1 }, pressableStyle]}>{content}</View>;
});
