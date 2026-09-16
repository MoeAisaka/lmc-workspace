import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { create } from 'zustand';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { lmcElevation } from './elevation';

/**
 * A line of text that comes and goes.
 *
 * For outcomes that are worth saying and not worth interrupting for: a file
 * that could not be opened, a file that was downloaded instead. A dialog would
 * demand an answer to something already finished, and the previous behaviour —
 * navigating to a whole screen to print an error — cost a reader their place in
 * the transcript to tell them a path was wrong.
 */

export interface ToastAction {
    label: string;
    onPress: () => void;
}

interface ToastMessage {
    id: number;
    text: string;
    tone: 'info' | 'error';
    action?: ToastAction;
}

const DURATION = 3600;
// A toast that offers something to undo stays up longer — the reader has to
// read the action, not just the outcome.
const ACTION_DURATION = 4000;

const useToastStore = create<{ current: ToastMessage | null; show: (message: ToastMessage) => void; clear: (id: number) => void }>((set, get) => ({
    current: null,
    show: (message) => set({ current: message }),
    clear: (id) => { if (get().current?.id === id) set({ current: null }); },
}));

let nextId = 1;

export function showToast(text: string, tone: 'info' | 'error' = 'info', action?: ToastAction) {
    useToastStore.getState().show({ id: nextId++, text, tone, action });
}

const styles = StyleSheet.create((theme) => ({
    layer: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', zIndex: 4000 },
    pill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        maxWidth: 520,
        marginHorizontal: 16,
        marginBottom: 28,
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 999,
        backgroundColor: theme.colors.text,
    },
    label: {
        flexShrink: 1,
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.surface,
        ...Typography.default(),
    },
    action: {
        flexShrink: 0,
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.surface,
        textDecorationLine: 'underline',
        ...Typography.default('semiBold'),
    },
}));

export const ToastLayer = React.memo(() => {
    const { theme } = useUnistyles();
    const current = useToastStore((state) => state.current);
    const clear = useToastStore((state) => state.clear);
    const [shown, setShown] = React.useState<ToastMessage | null>(null);
    const progress = useSharedValue(0);

    React.useEffect(() => {
        if (!current) return;
        setShown(current);
        progress.value = 0;
        progress.value = withTiming(1, { duration: 180, easing: Easing.out(Easing.cubic) });
        const timer = setTimeout(() => {
            progress.value = withTiming(0, { duration: 200, easing: Easing.in(Easing.cubic) }, (done) => {
                if (done) runOnJS(setShown)(null);
            });
            clear(current.id);
        }, current.action ? ACTION_DURATION : DURATION);
        return () => clearTimeout(timer);
    }, [clear, current, progress]);

    const dismiss = React.useCallback(() => {
        if (!shown) return;
        clear(shown.id);
        progress.value = withTiming(0, { duration: 200, easing: Easing.in(Easing.cubic) }, (done) => {
            if (done) runOnJS(setShown)(null);
        });
    }, [clear, progress, shown]);

    const style = useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: [{ translateY: (1 - progress.value) * 10 }],
    }));

    if (!shown) return null;
    return (
        <View style={styles.layer} pointerEvents="box-none">
            <Animated.View style={[styles.pill, lmcElevation(theme, 4), style]} pointerEvents="auto">
                <Ionicons
                    name={shown.tone === 'error' ? 'alert-circle-outline' : 'checkmark-circle-outline'}
                    size={16}
                    color={theme.colors.surface}
                />
                <Text style={styles.label} numberOfLines={2}>{shown.text}</Text>
                {!!shown.action && (
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={shown.action.label}
                        hitSlop={8}
                        onPress={() => { shown.action!.onPress(); dismiss(); }}
                    >
                        <Text style={styles.action}>{shown.action.label}</Text>
                    </Pressable>
                )}
            </Animated.View>
        </View>
    );
});
