import * as React from 'react';
import { Pressable, useWindowDimensions, View, Platform } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming, runOnJS } from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { DeviceEngineSessionList } from './DeviceEngineSessionList';
import { useSessionDrawer } from './sessionDrawerStore';
import { lmcElevation, lmcSurfaceBorder } from './elevation';
import { t } from '@/text';

const DRAWER_MARGIN = 12;
const DRAWER_MAX_WIDTH = 326;
const OPEN_MS = 260;

const styles = StyleSheet.create((theme) => ({
    layer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 2000 },
    scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.32)' },
    panel: {
        position: 'absolute',
        left: DRAWER_MARGIN,
        borderRadius: 24,
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 10,
        paddingTop: 12,
        paddingBottom: 10,
        overflow: 'hidden',
        ...lmcElevation(theme, 4),
        ...lmcSurfaceBorder(theme),
    },
}));

/**
 * The approved phone session list: a floating, fully rounded card over the
 * current screen rather than an edge-anchored drawer or a separate page.
 * Opens from the header menu button; closes on scrim tap, swipe left, or
 * after navigating.
 */
export const FloatingSessionDrawer = React.memo(() => {
    const open = useSessionDrawer((s) => s.open);
    const setOpen = useSessionDrawer((s) => s.setOpen);
    const { width, height } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const { theme } = useUnistyles();
    const panelWidth = Math.min(DRAWER_MAX_WIDTH, width - DRAWER_MARGIN * 2 - 40);
    const top = Math.max(insets.top, 12) + 40;
    const bottom = Math.max(insets.bottom, 12) + 28;
    const panelHeight = Math.max(240, height - top - bottom);

    const progress = useSharedValue(0);
    const [mounted, setMounted] = React.useState(open);
    React.useEffect(() => {
        if (open) {
            setMounted(true);
            progress.value = withTiming(1, { duration: OPEN_MS, easing: Easing.out(Easing.cubic) });
        } else {
            progress.value = withTiming(0, { duration: OPEN_MS - 40, easing: Easing.in(Easing.cubic) }, (finished) => {
                if (finished) runOnJS(setMounted)(false);
            });
        }
    }, [open, progress]);

    const close = React.useCallback(() => setOpen(false), [setOpen]);
    const swipeClose = React.useMemo(() => Gesture.Pan()
        .activeOffsetX([-16, 16])
        .onEnd((event) => { if (event.translationX < -48 || event.velocityX < -600) runOnJS(close)(); }), [close]);

    const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
    const panelStyle = useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: [{ translateX: (1 - progress.value) * -(panelWidth + DRAWER_MARGIN) }],
    }));

    if (!mounted) return null;
    return (
        <View style={styles.layer} pointerEvents={open ? 'auto' : 'none'}>
            <Animated.View style={[styles.scrim, scrimStyle]}>
                <Pressable accessibilityRole="button" accessibilityLabel={t('lmc.list.closeDrawer')} onPress={close} style={{ flex: 1 }} />
            </Animated.View>
            <GestureDetector gesture={swipeClose}>
                <Animated.View style={[styles.panel, panelStyle, { top, width: panelWidth, height: panelHeight, backgroundColor: theme.colors.surface }]}>
                    <DeviceEngineSessionList onNavigate={close} />
                </Animated.View>
            </GestureDetector>
        </View>
    );
});
