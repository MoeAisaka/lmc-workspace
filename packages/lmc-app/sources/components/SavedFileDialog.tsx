import React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { InteractionPressable as Pressable } from '@/components/InteractionPressable';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Modal } from '@/modal';
import { Text } from '@/components/StyledText';
import { SavedFileDetails } from '@/components/SavedFileDetails';
import { lmcElevation } from '@/components/lmc/elevation';
import { t } from '@/text';

export function SavedFileDialog({ id, onClose }: { id: string; onClose?: () => void }) {
    const { theme } = useUnistyles();
    const { width, height } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    return <View testID="saved-file-dialog" style={{
        width: Math.min(800, width - insets.left - insets.right - 24),
        height: Math.min(760, (height - insets.top - insets.bottom) * 0.88),
        borderRadius: 16, overflow: 'hidden', backgroundColor: theme.colors.surface,
        borderWidth: 1, borderColor: theme.colors.divider, ...lmcElevation(theme, 3),
    }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 20, paddingRight: 8, minHeight: 56, borderBottomWidth: 1, borderBottomColor: theme.colors.divider }}>
            <Text accessibilityRole="header" style={{ fontSize: 16, fontWeight: '600', color: theme.colors.text }}>{t('lmc.dialogs.file')}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={t('lmc.dialogs.closeFileDialog')} onPress={onClose}
                style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? theme.colors.surfaceHigh : 'transparent' })}>
                <Ionicons name="close" size={22} color={theme.colors.text} />
            </Pressable>
        </View>
        <SavedFileDetails id={id} />
    </View>;
}

export function openSavedFile(id: string) {
    Modal.show({ component: SavedFileDialog, props: { id }, blurBackdrop: true });
}
