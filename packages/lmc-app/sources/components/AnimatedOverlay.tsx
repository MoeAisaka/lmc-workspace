import * as React from 'react';
import { Platform, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { InteractionPressable as Pressable } from '@/components/InteractionPressable';
import { BlurView } from 'expo-blur';
import MaskedView from '@react-native-masked-view/masked-view';
import Animated, {
    Easing,
    FadeIn,
    FadeInDown,
    FadeOut,
    ReduceMotion,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import { usePersonalizationMotion } from '@/hooks/usePersonalizationMotion';
import { motionDuration } from '@/sync/personalization';

const enterEasing = Easing.out(Easing.cubic);
const exitEasing = Easing.in(Easing.cubic);

function useOverlayTransitions() {
    const motion = usePersonalizationMotion();
    return React.useMemo(() => ({
        backdropEntering: FadeIn.duration(motionDuration(motion, 180)).easing(enterEasing).reduceMotion(ReduceMotion.System),
        backdropExiting: FadeOut.duration(motionDuration(motion, 140)).easing(exitEasing).reduceMotion(ReduceMotion.System),
        popupEntering: FadeInDown.duration(motionDuration(motion, 200)).easing(enterEasing)
            .withInitialValues({ opacity: 0, transform: [{ translateY: motion === 'full' ? 6 : 0 }] })
            .reduceMotion(ReduceMotion.System),
        popupExiting: FadeOut.duration(motionDuration(motion, 140)).easing(exitEasing).reduceMotion(ReduceMotion.System),
    }), [motion]);
}

export function AnimatedBlurBackdrop({
    blurIntensity = 42,
    dimColor,
    interactive = true,
    onPress,
    style,
}: {
    blurIntensity?: number;
    dimColor?: string;
    interactive?: boolean;
    onPress?: () => void;
    style?: StyleProp<ViewStyle>;
}) {
    const { theme } = useUnistyles();
    const { backdropEntering, backdropExiting } = useOverlayTransitions();

    return (
        <Animated.View
            entering={backdropEntering}
            exiting={backdropExiting}
            pointerEvents="box-none"
            style={[StyleSheet.absoluteFill, style]}
        >
            <BlurView
                blurMethod={Platform.OS === 'android' ? 'dimezisBlurViewSdk31Plus' : undefined}
                blurReductionFactor={2}
                intensity={blurIntensity}
                pointerEvents="none"
                tint={theme.dark ? 'systemMaterialDark' : 'systemMaterialLight'}
                style={StyleSheet.absoluteFill}
            />
            <View
                pointerEvents="none"
                style={[
                    StyleSheet.absoluteFill,
                    {
                        backgroundColor: dimColor ?? (theme.dark
                            ? 'rgba(0, 0, 0, 0.34)'
                            : 'rgba(255, 255, 255, 0.18)'),
                    },
                ]}
            />
            <Pressable
                interaction="none"
                accessible={false}
                tabIndex={-1}
                onPress={onPress}
                pointerEvents={interactive ? 'auto' : 'none'}
                style={StyleSheet.absoluteFill}
            />
        </Animated.View>
    );
}

export function AnimatedClickAwayBackdrop({
    dimColor = 'transparent',
    exitImmediately = false,
    onPress,
    style,
}: {
    dimColor?: string;
    /** Unmount without running the backdrop exit animation. */
    exitImmediately?: boolean;
    onPress?: () => void;
    style?: StyleProp<ViewStyle>;
}) {
    const { backdropEntering, backdropExiting } = useOverlayTransitions();
    return (
        <Animated.View
            entering={backdropEntering}
            exiting={exitImmediately ? undefined : backdropExiting}
            pointerEvents="box-none"
            style={[StyleSheet.absoluteFill, style]}
        >
            {dimColor !== 'transparent' && (
                <View
                    pointerEvents="none"
                    style={[StyleSheet.absoluteFill, { backgroundColor: dimColor }]}
                />
            )}
            <Pressable interaction="none" accessible={false} tabIndex={-1} onPress={onPress} style={StyleSheet.absoluteFill} />
        </Animated.View>
    );
}

export function LocalBlurHalo({
    blurIntensity = 34,
    borderRadius = 30,
    dimColor,
    expansion = 14,
    style,
}: {
    blurIntensity?: number;
    borderRadius?: number;
    dimColor?: string;
    expansion?: number;
    style?: StyleProp<ViewStyle>;
}) {
    const { theme } = useUnistyles();
    const maskExpansion = expansion * 2.5;
    const maskShadowRadius = expansion * 1.35;

    return (
        <MaskedView
            androidRenderingMode="software"
            maskElement={(
                <View style={StyleSheet.absoluteFill}>
                    <View
                        style={[
                            styles.localBlurMaskCore,
                            {
                                top: maskExpansion,
                                right: maskExpansion,
                                bottom: maskExpansion,
                                left: maskExpansion,
                                borderRadius,
                                shadowRadius: maskShadowRadius,
                                boxShadow: `0 0 ${maskShadowRadius * 2}px rgba(255, 255, 255, 1)`,
                            },
                        ]}
                    />
                </View>
            )}
            pointerEvents="none"
            style={[
                styles.localBlurHalo,
                {
                    top: -maskExpansion,
                    right: -maskExpansion,
                    bottom: -maskExpansion,
                    left: -maskExpansion,
                },
                style,
            ]}
        >
            <BlurView
                blurMethod={Platform.OS === 'android' ? 'dimezisBlurViewSdk31Plus' : undefined}
                blurReductionFactor={2}
                intensity={blurIntensity}
                tint={theme.dark ? 'systemUltraThinMaterialDark' : 'systemUltraThinMaterialLight'}
                style={StyleSheet.absoluteFill}
            />
            <View
                pointerEvents="none"
                style={[
                    StyleSheet.absoluteFill,
                    {
                        backgroundColor: dimColor ?? (theme.dark
                            ? 'rgba(0, 0, 0, 0.10)'
                            : 'rgba(255, 255, 255, 0.08)'),
                    },
                ]}
            />
        </MaskedView>
    );
}

export function AnimatedPopup({
    children,
    exitImmediately = false,
    style,
}: {
    children: React.ReactNode;
    /** Unmount without leaving an interactive popup during its exit animation. */
    exitImmediately?: boolean;
    style?: StyleProp<ViewStyle>;
}) {
    const { popupEntering, popupExiting } = useOverlayTransitions();
    return (
        <Animated.View
            entering={popupEntering}
            exiting={exitImmediately ? undefined : popupExiting}
            style={style}
        >
            {children}
        </Animated.View>
    );
}

/** Opacity-only. Stays in layout so nothing around it jumps. */
export function AnimatedFade({
    visible,
    children,
    style,
}: {
    visible: boolean;
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
}) {
    const motion = usePersonalizationMotion();
    const opacity = useSharedValue(visible ? 1 : 0);
    React.useEffect(() => {
        opacity.value = withTiming(visible ? 1 : 0, {
            duration: motionDuration(motion, visible ? 180 : 140),
            easing: visible ? enterEasing : exitEasing,
            reduceMotion: ReduceMotion.System,
        });
    }, [opacity, visible, motion]);
    const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
    return (
        <Animated.View
            pointerEvents={visible ? 'auto' : 'none'}
            style={[animatedStyle, style]}
        >
            {children}
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    localBlurHalo: {
        position: 'absolute',
    },
    localBlurMaskCore: {
        position: 'absolute',
        backgroundColor: '#FFFFFF',
        shadowColor: '#FFFFFF',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 1,
    },
});
