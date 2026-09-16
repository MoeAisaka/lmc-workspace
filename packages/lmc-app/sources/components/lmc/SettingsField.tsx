import * as React from 'react';
import { Platform, TextInput } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

/**
 * A settings value you type, edited in place.
 *
 * The alternative was a prompt dialog, and only one modal is on screen at a
 * time: asking for a number closed the settings window the row belonged to, and
 * answering did not bring it back. So the row carries the field itself.
 */

const styles = StyleSheet.create((theme) => ({
    input: {
        minHeight: 30,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.groupped.background,
        textAlign: 'right',
        fontSize: 13.5,
        color: theme.colors.text,
        ...Typography.default(),
        ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
    },
}));

export function SettingsTextField(props: {
    value: string;
    placeholder: string;
    onChangeText: (value: string) => void;
    /** Called when the value is finished — blur, or Enter. */
    onCommit: () => void;
    invalid?: boolean;
    numeric?: boolean;
    accessibilityLabel: string;
    width?: number;
}) {
    const { theme } = useUnistyles();
    return (
        <TextInput
            accessibilityLabel={props.accessibilityLabel}
            value={props.value}
            placeholder={props.placeholder}
            placeholderTextColor={theme.colors.textSecondary}
            onChangeText={props.onChangeText}
            onBlur={props.onCommit}
            onSubmitEditing={props.onCommit}
            returnKeyType="done"
            inputMode={props.numeric ? 'numeric' : 'text'}
            style={[styles.input, { width: props.width ?? 132 }, props.invalid && { borderColor: theme.colors.textDestructive }]}
        />
    );
}
