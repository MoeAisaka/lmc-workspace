import * as React from 'react';
import { View, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming, cancelAnimation } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import type { LmcSessionTone } from '@/utils/lmc/sessionStatusLine';
import { lmcColors } from './lmcColors';
import { t } from '@/text';

interface SessionStatusRingProps {
    tone: LmcSessionTone;
    size?: number;
}

/**
 * The approved status ring: orange breathing ring while the agent waits for
 * the user, a spinning blue arc while it works, a thin grey ring when idle
 * and a dashed grey ring once the session is gone.
 *
 * A finished session you have not opened yet gets a filled green check. It is
 * the one state that is about you rather than the agent — the work is done and
 * nobody has looked — so it is the one state drawn solid.
 */
export const SessionStatusRing = React.memo(({ tone, size = 16 }: SessionStatusRingProps) => {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const pulse = useSharedValue(1);
    const spin = useSharedValue(0);

    React.useEffect(() => {
        cancelAnimation(pulse); cancelAnimation(spin);
        pulse.value = 1; spin.value = 0;
        if (tone === 'attention') {
            pulse.value = withRepeat(withTiming(0.35, { duration: 900, easing: Easing.inOut(Easing.ease) }), -1, true);
        } else if (tone === 'working') {
            spin.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.linear }), -1, false);
        }
    }, [tone, pulse, spin]);

    const pulseStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));
    const spinStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${spin.value * 360}deg` }] }));

    const thick = Math.max(2, Math.round(size * 0.16));
    const thin = Math.max(1.5, Math.round(size * 0.1));
    const base = { width: size, height: size, borderRadius: size / 2 } as const;

    if (tone === 'attention') {
        return <Animated.View accessibilityLabel={t('lmc.ring.awaitingReply')} style={[base, pulseStyle, { borderWidth: thick, borderColor: colors.attention }]} />;
    }
    if (tone === 'working') {
        return (
            <View accessibilityLabel={t('lmc.ring.working')} style={base}>
                <View style={[base, { position: 'absolute', borderWidth: thick, borderColor: colors.idle, opacity: 0.35 }]} />
                <Animated.View style={[base, spinStyle, { borderWidth: thick, borderColor: colors.working, borderTopColor: 'transparent', borderLeftColor: 'transparent' }]} />
            </View>
        );
    }
    if (tone === 'done') {
        return (
            <View
                accessibilityLabel={t('lmc.ring.doneUnread')}
                style={[base, { backgroundColor: theme.colors.status.connected, alignItems: 'center', justifyContent: 'center' }]}
            >
                <Ionicons name="checkmark" size={Math.round(size * 0.72)} color="#FFFFFF" />
            </View>
        );
    }
    if (tone === 'idle') {
        return <View accessibilityLabel={t('lmc.ring.idle')} style={[base, { borderWidth: thin, borderColor: colors.idle }]} />;
    }
    return <View accessibilityLabel={t('lmc.ring.disconnected')} style={[base, { borderWidth: thin, borderColor: colors.offline, borderStyle: Platform.OS === 'web' ? 'dashed' : 'dotted' }]} />;
});
