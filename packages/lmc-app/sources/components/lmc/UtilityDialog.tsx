import React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { InteractionPressable as Pressable } from '@/components/InteractionPressable';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/StyledText';
import { lmcElevation } from './elevation';
import { useSettingsNavigation } from './settings/settingsNavigation';
import { t } from '@/text';

/** Auxiliary tasks keep the underlying workspace mounted and its scroll position intact. */
export function UtilityDialog({ title, onClose, children, maxWidth = 900, testID }: {
    title: string; onClose?: () => void; children: React.ReactNode; maxWidth?: number; testID?: string;
}) {
    const settingsNav = useSettingsNavigation();
    const { theme } = useUnistyles();
    const { width, height } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    if (settingsNav?.isEmbeddedInSettings) {
        return <View testID={testID} style={{ flex: 1, minHeight: 0 }}>{children}</View>;
    }
    return <View testID={testID} style={{ width: Math.min(maxWidth, Math.max(0, width - insets.left - insets.right - 24)),
        height: Math.min(860, (height - insets.top - insets.bottom) * 0.9), borderRadius: 16,
        overflow: 'hidden', backgroundColor: theme.colors.surface, borderWidth: 1,
        borderColor: theme.colors.divider, ...lmcElevation(theme, 3) }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 8,
            minHeight: 56, borderBottomWidth: 1, borderBottomColor: theme.colors.divider }}>
            <Text accessibilityRole="header" numberOfLines={1} style={{ flex: 1, fontSize: 16, fontWeight: '600', color: theme.colors.text }}>{title}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={t('lmc.dialogs.closeDialog', { title })} onPress={onClose}
                style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? theme.colors.surfaceHigh : 'transparent' })}>
                <Ionicons name="close" size={22} color={theme.colors.text} />
            </Pressable>
        </View>
        <View style={{ flex: 1, minHeight: 0 }}>{children}</View>
    </View>;
}
