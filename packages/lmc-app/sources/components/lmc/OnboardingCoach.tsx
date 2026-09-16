import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useAllMachines, useLocalSettingMutable } from '@/sync/storage';
import { lmcColors } from './lmcColors';
import { lmcElevation, lmcSurfaceBorder } from './elevation';
import { t } from '@/text';

const STEPS = ['device', 'session'] as const;
type Step = (typeof STEPS)[number];

const styles = StyleSheet.create((theme) => ({
    layer: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', zIndex: 1200 },
    bubble: {
        width: '100%',
        maxWidth: 420,
        marginHorizontal: 16,
        marginBottom: 16,
        padding: 16,
        borderRadius: 20,
        backgroundColor: theme.colors.surface,
    },
    head: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
    step: { fontSize: 11, letterSpacing: 0.4, ...Typography.default('semiBold') },
    title: { flex: 1, minWidth: 0, fontSize: 16, lineHeight: 22, color: theme.colors.text, ...Typography.default('semiBold') },
    body: { fontSize: 13, lineHeight: 19, color: theme.colors.textSecondary, ...Typography.default() },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 },
    action: { flex: 1, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
    actionLabel: { fontSize: 14, color: '#FFFFFF', ...Typography.default('semiBold') },
    skip: { height: 40, paddingHorizontal: 14, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
    skipLabel: { fontSize: 13, ...Typography.default() },
    dots: { flexDirection: 'row', gap: 5, alignItems: 'center' },
    dot: { width: 6, height: 6, borderRadius: 3 },
}));

/**
 * The first-run tour: one floating bubble at a time, above the composer, for
 * the two things a fresh center cannot do anything without — a paired device
 * and a first session.
 *
 * It advances by watching for the thing to actually happen rather than by
 * trusting the button: pairing a device from a terminal, or from another
 * browser, moves the tour on just the same.
 */
export const OnboardingCoach = React.memo(({ bottomInset = 0 }: { bottomInset?: number }) => {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const router = useRouter();
    const [step, setStep] = useLocalSettingMutable('onboardingStep');
    const machines = useAllMachines({ includeOffline: true });

    // A device that paired while the bubble was on screen finishes step one.
    React.useEffect(() => {
        if (step === 'device' && machines.length > 0) setStep('session');
    }, [machines.length, setStep, step]);

    const progress = useSharedValue(0);
    React.useEffect(() => {
        progress.value = withTiming(step ? 1 : 0, { duration: 240, easing: Easing.out(Easing.cubic) });
    }, [progress, step]);
    const style = useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: [{ translateY: (1 - progress.value) * 12 }],
    }));

    if (!step) return null;
    const index = STEPS.indexOf(step as Step) + 1;
    const isDevice = step === 'device';

    return (
        <View style={[styles.layer, { bottom: bottomInset }]} pointerEvents="box-none">
            <Animated.View style={[styles.bubble, style, lmcSurfaceBorder(theme), lmcElevation(theme, 4)]}>
                <View style={styles.head}>
                    <Ionicons name={isDevice ? 'laptop-outline' : 'create-outline'} size={18} color={colors.brand} />
                    <Text style={styles.title}>{t(isDevice ? 'lmc.onboarding.deviceTitle' : 'lmc.onboarding.sessionTitle')}</Text>
                    <Text style={[styles.step, { color: colors.tertiary }]}>
                        {t('lmc.onboarding.step', { index, total: STEPS.length })}
                    </Text>
                </View>
                <Text style={styles.body}>
                    {t(isDevice ? 'lmc.onboarding.deviceBody' : 'lmc.onboarding.sessionBody')}
                </Text>
                <View style={styles.row}>
                    <View style={styles.dots}>
                        {STEPS.map((candidate) => (
                            <View
                                key={candidate}
                                style={[styles.dot, { backgroundColor: candidate === step ? colors.brand : colors.border }]}
                            />
                        ))}
                    </View>
                    <Pressable
                        accessibilityRole="button"
                        onPress={() => setStep(null)}
                        style={({ pressed }) => [styles.skip, pressed && { opacity: 0.6 }]}
                    >
                        <Text style={[styles.skipLabel, { color: colors.tertiary }]}>{t('lmc.onboarding.skip')}</Text>
                    </Pressable>
                    <Pressable
                        accessibilityRole="button"
                        onPress={() => {
                            if (isDevice) router.push('/settings/account');
                            else { setStep(null); router.push('/new'); }
                        }}
                        style={({ pressed }) => [styles.action, { backgroundColor: colors.brand, opacity: pressed ? 0.85 : 1 }]}
                    >
                        <Text style={styles.actionLabel}>
                            {t(isDevice ? 'lmc.onboarding.deviceAction' : 'lmc.onboarding.sessionAction')}
                        </Text>
                    </Pressable>
                </View>
            </Animated.View>
        </View>
    );
});

/** Marks the tour finished once a session exists, wherever it was started. */
export function useFinishOnboardingOnFirstSession(hasSession: boolean) {
    const [step, setStep] = useLocalSettingMutable('onboardingStep');
    React.useEffect(() => {
        if (step && hasSession) setStep(null);
    }, [hasSession, setStep, step]);
}

export const ONBOARDING_SUPPORTED = Platform.OS === 'web' || Platform.OS === 'ios' || Platform.OS === 'android';
