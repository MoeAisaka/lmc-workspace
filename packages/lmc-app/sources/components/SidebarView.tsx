import * as React from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from './StyledText';
import { Typography } from '@/constants/Typography';
import { VoiceAssistantStatusBar } from './VoiceAssistantStatusBar';
import { useRealtimeStatus } from '@/sync/storage';
import { DeviceEngineSessionList, SessionSearchRow } from './lmc/DeviceEngineSessionList';
import { AccountSettingsRow } from './lmc/AccountSettingsRow';
import { lmcElevation, lmcSurfaceBorder } from './lmc/elevation';
import { useSidebarMetrics } from './lmc/sidebarMetrics';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        gap: 8,
        paddingHorizontal: 8,
        paddingBottom: 8,
    },
    // Three cards rather than one panel: what the workspace is, what is running
    // on it, and who is signed in — each reads as its own surface.
    card: {
        borderRadius: 16,
        backgroundColor: theme.colors.surface,
        overflow: 'hidden',
    },
    headerCard: {
        // The search panel overlays this card's own row, so it must not clip.
        overflow: 'visible',
        zIndex: 5,
        paddingHorizontal: 8,
        paddingTop: 6,
        paddingBottom: 8,
        gap: 4,
    },
    brandRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingLeft: 4,
        paddingRight: 2,
        height: 40,
    },
    brandText: {
        flex: 1,
        minWidth: 0,
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    listCard: {
        flex: 1,
        minHeight: 0,
        paddingHorizontal: 8,
        paddingTop: 4,
        paddingBottom: 4,
    },
    accountCard: {
        paddingHorizontal: 8,
        paddingVertical: 4,
    },
}));

export const SidebarView = React.memo(() => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const realtimeStatus = useRealtimeStatus();

    const [query, setQuery] = React.useState('');
    const setHeaderCardHeight = useSidebarMetrics((state) => state.setHeaderCardHeight);

    return (
        <View style={[styles.container, { paddingTop: safeArea.top + 8 }]}>
            <View
                onLayout={(event) => setHeaderCardHeight(event.nativeEvent.layout.height)}
                style={[styles.card, styles.headerCard, lmcSurfaceBorder(theme), lmcElevation(theme, 1)]}
            >
                <View style={styles.brandRow}>
                    <Image source={require('@/assets/images/lmc-logo.png')} style={{ width: 26, height: 26, borderRadius: 8 }} />
                    <Text numberOfLines={1} style={styles.brandText}>Link my Cli</Text>
                </View>
                <SessionSearchRow query={query} onQueryChange={setQuery} />
            </View>

            {realtimeStatus !== 'disconnected' && (
                <VoiceAssistantStatusBar variant="sidebar" />
            )}

            <View style={[styles.card, styles.listCard, lmcSurfaceBorder(theme), lmcElevation(theme, 1)]}>
                <DeviceEngineSessionList hideSearch hideAccount query={query} />
            </View>

            <View style={[styles.card, styles.accountCard, lmcSurfaceBorder(theme), lmcElevation(theme, 1)]}>
                <AccountSettingsRow />
            </View>
        </View>
    );
});
