import * as React from 'react';
import { Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { create } from 'zustand';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useAuth } from '@/auth/AuthContext';
import { lmcElevation, lmcSurfaceBorder } from './elevation';
import { openLmcSettings, type LmcSettingsSection } from './settings/LmcSettingsDialog';
import { t } from '@/text';
import { AccountQuotaCards } from './AccountQuotaCards';
import { useAccountQuota } from '@/sync/useAccountQuota';

export interface AccountMenuAnchor {
    x: number;
    y: number;
    width: number;
    /** When measured from the surrounding card, match its outer width and corners. */
    cardRadius?: number;
    /** Close the parent drawer only after choosing a destination, not while browsing this bubble. */
    onNavigate?: () => void;
    /** Padding between the measured row and the card around it, so the menu can
     *  line up with that card's edges instead of the row's. */
    inset?: number;
    /** Vertical counterpart; cards rarely pad both axes equally. */
    insetY?: number;
}

/** Open/closed state of the desktop account popover; any row can open it, the layer renders it. */
export const useAccountMenu = create<{ anchor: AccountMenuAnchor | null; open: (anchor: AccountMenuAnchor) => void; close: () => void }>((set) => ({
    anchor: null,
    open: (anchor) => set({ anchor }),
    close: () => set({ anchor: null }),
}));

const styles = StyleSheet.create((theme) => ({
    menu: { position: 'absolute', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 24, overflow: 'hidden', backgroundColor: theme.colors.surface, ...lmcSurfaceBorder(theme), ...lmcElevation(theme, 3) },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.divider, marginVertical: 6 },
    item: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 7, minHeight: 34, borderRadius: 10 },
    itemText: { fontSize: 14, lineHeight: 20, color: theme.colors.text, ...Typography.default() },
}));

/**
 * The account popover behind the sidebar avatar row (desktop). Shown through
 * the modal layer so the backdrop closes it; positioned just above the row.
 */
export function AccountMenu({ anchor, onClose }: { anchor: AccountMenuAnchor; onClose?: () => void }) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const auth = useAuth();
    const quota = useAccountQuota();
    const { width: windowWidth, height } = useWindowDimensions();
    // Measured, not guessed: the menu's bottom edge lines up with the top of the
    // card it belongs to, so the two rounded corners meet instead of drifting.
    const [menuHeight, setMenuHeight] = React.useState(296);
    const gap = 8;
    const menuWidth = Math.min(anchor.width, windowWidth - 16);
    const left = Math.max(8, Math.min(anchor.x - (anchor.inset ?? 0), windowWidth - menuWidth - 8));
    const cardTop = anchor.y - (anchor.insetY ?? anchor.inset ?? 0);
    const spaceAbove = cardTop - gap - 8;
    const maxHeight = spaceAbove >= 120 ? Math.min(height - 16, spaceAbove) : height - 16;
    const top = Math.max(8, Math.min(cardTop - menuHeight - gap, height - menuHeight - 8));

    const go = (fn: () => void) => () => { onClose?.(); anchor.onNavigate?.(); fn(); };
    const open = (section: LmcSettingsSection) => go(() => {
        if (windowWidth < 768) {
            router.push(section === 'devices' ? '/settings/devices' : section === 'account' ? '/settings/account' : '/settings');
        } else setTimeout(() => openLmcSettings(section), 0);
    });
    const logout = go(async () => {
        if (!await Modal.confirm(t('lmc.menu.signOut'), t('lmc.menu.signOutConfirm'), { cancelText: t('common.cancel'), confirmText: t('lmc.menu.signOut') })) return;
        try { await auth.logout(); } catch { Modal.alert(t('lmc.menu.signOutFailed'), t('lmc.menu.retryHint')); }
    });
    const Item = ({ icon, label, onPress, destructive }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void; destructive?: boolean }) => (
        <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.item, pressed && { backgroundColor: theme.colors.surfacePressed }]}>
            <Ionicons name={icon} size={18} color={destructive ? theme.colors.textDestructive : theme.colors.text} />
            <Text style={[styles.itemText, destructive && { color: theme.colors.textDestructive }]}>{label}</Text>
        </Pressable>
    );

    // The modal layer centres its child; a window-sized root makes absolute coordinates match the screen.
    return (
        <View style={{ width: windowWidth, height }} pointerEvents="box-none">
            <View
                onLayout={(event) => {
                    const next = Math.ceil(event.nativeEvent.layout.height);
                    setMenuHeight((current) => (Math.abs(current - next) < 1 ? current : next));
                }}
                style={[styles.menu, { left, width: menuWidth, maxHeight, top, borderRadius: anchor.cardRadius ?? 24 }]}
            >
                <ScrollView showsVerticalScrollIndicator contentContainerStyle={{ paddingBottom: 2 }}>
                <AccountQuotaCards {...quota} onRefresh={quota.refresh} />
                <View style={styles.divider} />
                <Item icon="laptop-outline" label={t('lmc.menu.devices')} onPress={open('devices')} />
                <Item icon="person-circle-outline" label={t('lmc.menu.profile')} onPress={open('account')} />
                <Item icon="settings-outline" label={t('lmc.menu.settings')} onPress={open('general')} />
                <View style={styles.divider} />
                <Item icon="sparkles-outline" label={t('lmc.menu.changelog')} onPress={go(() => router.push('/changelog'))} />
                <Item icon="log-out-outline" label={t('lmc.menu.signOut')} onPress={logout} destructive />
                </ScrollView>
            </View>
        </View>
    );
}

export function openAccountMenu(anchor: AccountMenuAnchor) {
    useAccountMenu.getState().open(anchor);
}

/**
 * Hosts the popover above everything on desktop: a transparent scrim that
 * closes on click, and the menu sliding up from the avatar row.
 */
export function AccountMenuLayer() {
    const anchor = useAccountMenu((s) => s.anchor);
    const close = useAccountMenu((s) => s.close);
    const [shown, setShown] = React.useState<AccountMenuAnchor | null>(null);
    const progress = useSharedValue(0);
    React.useEffect(() => {
        if (anchor) {
            setShown(anchor);
            progress.value = 0;
            progress.value = withTiming(1, { duration: 180, easing: Easing.out(Easing.cubic) });
        } else if (shown) {
            progress.value = withTiming(0, { duration: 140, easing: Easing.in(Easing.cubic) }, (done) => { if (done) runOnJS(setShown)(null); });
        }
    }, [anchor]);
    const style = useAnimatedStyle(() => ({ opacity: progress.value, transform: [{ translateY: (1 - progress.value) * 12 }] }));
    if (!shown) return null;
    return (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 3000 }}>
            <Pressable accessibilityRole="button" accessibilityLabel={t('lmc.menu.close')} onPress={close} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
            <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }, style]} pointerEvents="box-none">
                <AccountMenu anchor={shown} onClose={close} />
            </Animated.View>
        </View>
    );
}
