import * as React from 'react';
import { View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import { revealJustPlayed } from './useSessionReveal';

/** How a session's transcript arrives when you switch to it. Tuned in one place. */
export const SESSION_ENTER = { durationMs: 180, offsetPx: 8 } as const;

/**
 * The transcript fades in and settles up by a few pixels when it first
 * appears — on switching sessions, or when a not-yet-loaded session's
 * messages arrive. The header and composer stay put; only the body moves.
 * With reduced motion it is a plain fade.
 */
export const SessionContentEnter = React.memo(function SessionContentEnter({ children }: { children: React.ReactNode }) {
    const reduceMotion = useReducedMotion();
    // The circular reveal already carries the pane in; fading underneath it
    // would only blur the edge of the circle.
    const [revealing] = React.useState(revealJustPlayed);
    const progress = useSharedValue(revealing ? 1 : 0);
    React.useEffect(() => {
        if (revealing) return;
        progress.value = withTiming(1, { duration: SESSION_ENTER.durationMs, easing: Easing.out(Easing.cubic) });
    }, [progress, revealing]);
    const style = useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: [{ translateY: reduceMotion ? 0 : (1 - progress.value) * SESSION_ENTER.offsetPx }],
    }));
    return <Animated.View testID="session-content-enter" style={[{ flex: 1 }, style]}>{children}</Animated.View>;
});

/**
 * Stand-in rows while a session's messages load, instead of a spinner that
 * blinks and is then replaced wholesale: one reply-shaped block of lines and
 * one prompt bubble, pulsing gently.
 */
export const SessionContentSkeleton = React.memo(function SessionContentSkeleton() {
    const { theme } = useUnistyles();
    const reduceMotion = useReducedMotion();
    const pulse = useSharedValue(1);
    React.useEffect(() => {
        if (reduceMotion) return;
        pulse.value = withRepeat(withSequence(
            withTiming(0.55, { duration: 700, easing: Easing.inOut(Easing.quad) }),
            withTiming(1, { duration: 700, easing: Easing.inOut(Easing.quad) }),
        ), -1);
    }, [pulse, reduceMotion]);
    const style = useAnimatedStyle(() => ({ opacity: pulse.value }));
    const fill = theme.dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.055)';
    const bar = (width: number | `${number}%`, height = 12) => ({ width, height, borderRadius: 6, backgroundColor: fill });
    // Chat is bottom-anchored, so the stand-in sits where the latest
    // messages will land rather than in the middle of the pane.
    return (
        <View style={{ flex: 1, alignSelf: 'stretch', justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 20 }}>
        <Animated.View testID="session-content-skeleton" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
            style={[{ alignSelf: 'center', width: '100%', maxWidth: 760, paddingHorizontal: 20, gap: 22 }, style]}>
            <View style={{ alignItems: 'flex-end' }}>
                <View style={{ width: '46%', height: 38, borderRadius: 18, backgroundColor: fill }} />
            </View>
            <View style={{ gap: 10 }}>
                <View style={bar('92%')} />
                <View style={bar('84%')} />
                <View style={bar('63%')} />
            </View>
            <View style={{ gap: 10 }}>
                <View style={bar('88%')} />
                <View style={bar('41%')} />
            </View>
        </Animated.View>
        </View>
    );
});
