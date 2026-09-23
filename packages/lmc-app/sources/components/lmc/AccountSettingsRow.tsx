import * as React from 'react';
import { View, Pressable, Image, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { openAccountMenu } from './AccountMenu';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useAllMachines, useIsDataReady, useProfile } from '@/sync/storage';
import { getAvatarUrl, getDisplayName } from '@/sync/profile';
import { lmcColors } from './lmcColors';
import { machineAgentVersion } from '@/utils/lmc/deviceEngineGroups';
import { t } from '@/text';

const styles = StyleSheet.create((theme) => ({
    row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 8, paddingRight: 6, paddingVertical: 8, borderRadius: 12 },
    rowPressed: { backgroundColor: theme.colors.surfacePressed },
    avatar: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
    avatarText: { fontSize: 13, color: '#fff', ...Typography.default('semiBold') },
    name: { fontSize: 13, color: theme.colors.text, ...Typography.default('semiBold') },
    sub: { fontSize: 11, lineHeight: 14, color: theme.colors.textSecondary, ...Typography.default() },
}));

/**
 * The single account + settings entry at the bottom of the session list.
 * The user asked for settings to live behind the avatar row instead of a
 * separate item, so the subtitle says what is behind it.
 */
export const AccountSettingsRow = React.memo(({ onNavigate, menuCardRef }: { onNavigate?: () => void; menuCardRef?: React.RefObject<View | null> }) => {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const router = useRouter();
    const rowRef = React.useRef<View>(null);
    const profile = useProfile();
    const machines = useAllMachines({ includeOffline: true });
    const isDataReady = useIsDataReady();
    const online = machines.filter((m) => m.active);
    const displayName = getDisplayName(profile) || 'Link my Cli';
    const avatarUrl = getAvatarUrl(profile);
    const versions = new Set(online.map(machineAgentVersion).filter(Boolean) as string[]);
    const versionText = versions.size === 1 ? `Agent ${[...versions][0]}` : versions.size > 1 ? `Agent 版本不一致` : null;
    // "0 devices online" during hydration reads as a failure; say nothing yet.
    const subtitle = isDataReady
        ? [t('lmc.menu.settings'), versionText, `${online.length} 台设备在线`].filter(Boolean).join(' · ')
        : t('lmc.menu.settings');

    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('lmc.list.accountAndSettings')}
            ref={rowRef}
            onPress={() => {
                // The same quota menu is available from the phone drawer and desktop sidebar.
                if (Platform.OS === 'web') {
                    (menuCardRef?.current ?? rowRef.current)?.measureInWindow((x, y, width) => {
                        openAccountMenu(menuCardRef?.current
                            ? { x, y, width, cardRadius: 16, onNavigate }
                            : { x, y, width, inset: 8, insetY: 4, onNavigate });
                    });
                    return;
                }
                onNavigate?.(); router.push('/settings');
            }}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        >
            <View style={[styles.avatar, { backgroundColor: colors.brand }]}>
                {avatarUrl
                    ? <Image source={{ uri: avatarUrl }} style={{ width: 30, height: 30 }} />
                    : <Text style={styles.avatarText}>{displayName.trim().charAt(0).toUpperCase()}</Text>}
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={styles.name}>{displayName}</Text>
                <Text numberOfLines={1} style={styles.sub}>{subtitle}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />
        </Pressable>
    );
});
