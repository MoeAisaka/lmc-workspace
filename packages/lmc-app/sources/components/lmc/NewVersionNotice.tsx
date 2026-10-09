import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { countAttachmentDrafts } from '@/hooks/useImagePicker';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { startWebReleaseWatch, useReleaseNoticeVisible, useWebRelease } from '@/utils/lmc/webRelease';
import { t } from '@/text';
import { lmcColors } from './lmcColors';
import { lmcElevation, lmcSurfaceBorder } from './elevation';

/**
 * "A new version is available": a pill floating at the top of the transcript,
 * the same on desktop and phone (D28; the owner tried the sidebar and came back).
 *
 * It never reloads on its own: a reload drops unsent attachments, which live
 * only in this page, so the pill says how many there are and leaves the moment
 * to the reader. Typed text is a synced draft and survives.
 */
export const NewVersionNotice = React.memo(function NewVersionNotice() {
    const visible = useReleaseNoticeVisible();
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const [unsent, setUnsent] = React.useState(0);
    React.useEffect(() => { startWebReleaseWatch(); }, []);
    React.useEffect(() => {
        if (!visible) return;
        const read = () => setUnsent(countAttachmentDrafts() + useNewSessionDraft.getState().attachments.length);
        read();
        const timer = setInterval(read, 2000);
        return () => clearInterval(timer);
    }, [visible]);
    if (Platform.OS !== 'web' || !visible) return null;
    return (
        <View testID="new-version-notice" accessibilityLiveRegion="polite" style={[{
            flexDirection: 'row', alignItems: 'center', alignSelf: 'center', maxWidth: '100%', gap: 10,
            borderRadius: 20, paddingLeft: 14, paddingRight: 6, paddingVertical: 6, backgroundColor: theme.colors.surface,
        }, lmcSurfaceBorder(theme), lmcElevation(theme, 3)]}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.working }} />
            <Text testID="new-version-text" numberOfLines={2} style={{ flexShrink: 1, fontSize: 13, lineHeight: 18, color: theme.colors.text, ...Typography.default() }}>
                {unsent > 0 ? t('lmc.list.newVersionUnsent', { count: unsent }) : t('lmc.list.newVersion')}
            </Text>
            <Pressable
                testID="new-version-refresh"
                accessibilityRole="button"
                onPress={() => window.location.reload()}
                style={({ pressed }) => ({ borderRadius: 14, paddingHorizontal: 12, paddingVertical: 5, backgroundColor: colors.brand, opacity: pressed ? 0.85 : 1 })}
            >
                <Text style={{ fontSize: 13, lineHeight: 18, color: '#FFFFFF', ...Typography.default('semiBold') }}>{t('lmc.list.newVersionRefresh')}</Text>
            </Pressable>
            <Pressable
                testID="new-version-later"
                accessibilityRole="button"
                accessibilityLabel={t('lmc.list.newVersionLater')}
                onPress={() => useWebRelease.getState().snooze(Date.now())}
                hitSlop={6}
                style={({ pressed }) => ({ width: 28, height: 28, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}
            >
                <Ionicons name="close" size={15} color={theme.colors.textSecondary} />
            </Pressable>
        </View>
    );
});
