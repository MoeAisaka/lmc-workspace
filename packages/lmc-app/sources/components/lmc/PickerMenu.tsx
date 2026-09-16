import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';

/**
 * The composer's model / effort / permission menu.
 *
 * Written to match the settings dialog rather than a form: a small caps
 * section label, flat rows that carry their own hover, and a check on the
 * selected one. Selection is marked by the check alone — colouring the label
 * blue as well made a five-item list look like five different states.
 */

const styles = StyleSheet.create((theme) => ({
    sectionTitle: {
        fontSize: 11,
        lineHeight: 15,
        letterSpacing: 0.4,
        color: theme.colors.textSecondary,
        // 16 is where every row's label starts (6 margin + 10 padding); the
        // section label used to sit 2pt inside them, which read as a wobble
        // down the left edge of the menu.
        paddingHorizontal: 16,
        paddingTop: 10,
        paddingBottom: 4,
        ...Typography.default('semiBold'),
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: 32,
        paddingHorizontal: 10,
        paddingVertical: 5,
        marginHorizontal: 6,
        borderRadius: 10,
    },
    label: {
        fontSize: 13.5,
        lineHeight: 18,
        color: theme.colors.text,
        ...Typography.default(),
    },
    description: {
        fontSize: 11,
        lineHeight: 15,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    meta: {
        fontSize: 11.5,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        flexShrink: 0,
        ...Typography.default(),
    },
    check: { width: 16, alignItems: 'center' },
    sectionNameRow: {
        flexDirection: 'row',
        // Centred, not baseline-aligned: a mark has no baseline to sit on.
        alignItems: 'center',
        gap: 6,
        flexShrink: 1,
        minWidth: 0,
    },
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 4,
    },
    sectionName: {
        fontSize: 12,
        lineHeight: 16,
        letterSpacing: 0.2,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    sectionHint: {
        fontSize: 11,
        lineHeight: 16,
        color: theme.colors.textSecondary,
        flexShrink: 1,
        ...Typography.default(),
    },
    divider: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
        // Flush with the labels and the slider bars rather than 4pt wider than
        // both, which left the rule looking like it belonged to nothing.
        marginHorizontal: 16,
        marginTop: 6,
    },
    empty: {
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.textSecondary,
        paddingHorizontal: 16,
        paddingVertical: 8,
        ...Typography.default(),
    },
}));

export const PickerMenuTitle = React.memo((props: { children: React.ReactNode }) => (
    <Text style={styles.sectionTitle}>{props.children}</Text>
));

export const PickerMenuDivider = React.memo(() => <View style={styles.divider} />);

/**
 * A section that owns the rows under it — an engine, in the model list.
 *
 * The name carries the section's own weight on the left; whatever qualifies it
 * sits on the right, so a long qualifier cannot push the name off the line or
 * turn a label into a sentence.
 */
export const PickerMenuSectionHeader = React.memo((props: { title: string; hint?: string | null; icon?: React.ReactNode }) => (
    <View style={styles.sectionHeader}>
        <View style={styles.sectionNameRow}>
            {props.icon}
            <Text style={styles.sectionName} numberOfLines={1}>{props.title}</Text>
        </View>
        {!!props.hint && <Text style={styles.sectionHint} numberOfLines={1}>{props.hint}</Text>}
    </View>
));

export const PickerMenuEmpty = React.memo((props: { children: React.ReactNode }) => (
    <Text style={styles.empty}>{props.children}</Text>
));

export const PickerMenuRow = React.memo((props: {
    label: string;
    description?: string | null;
    /**
     * A word or two about the row, kept on its line instead of under it. A
     * second line makes one row taller than its neighbours, which is the whole
     * of what a list of nine models looks ragged for.
     */
    meta?: string | null;
    selected: boolean;
    disabled?: boolean;
    leading?: React.ReactNode;
    onPress: () => void;
}) => {
    const { theme } = useUnistyles();
    const [hovered, setHovered] = React.useState(false);
    const hoverProps = Platform.OS === 'web'
        ? { onHoverIn: () => setHovered(true), onHoverOut: () => setHovered(false) }
        : {};
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: props.selected, disabled: !!props.disabled }}
            disabled={props.disabled}
            onPress={props.onPress}
            {...hoverProps}
            style={({ pressed }) => [
                styles.row,
                (pressed || hovered) && !props.disabled && { backgroundColor: theme.colors.surfacePressed },
                props.disabled && { opacity: 0.45 },
            ]}
        >
            {props.leading}
            <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.label} numberOfLines={1}>{props.label}</Text>
                {!!props.description && (
                    <Text style={styles.description} numberOfLines={1}>{props.description}</Text>
                )}
            </View>
            {!!props.meta && <Text style={styles.meta} numberOfLines={1}>{props.meta}</Text>}
            <View style={styles.check}>
                {props.selected && (
                    <Ionicons name="checkmark" size={15} color={theme.colors.radio.active} />
                )}
            </View>
        </Pressable>
    );
});
