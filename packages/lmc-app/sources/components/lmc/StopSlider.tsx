import * as React from 'react';
import { Platform, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import { InteractionPressable as Pressable } from '@/components/InteractionPressable';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';

/**
 * A scale with named notches — effort, permission — shown as a filled slider.
 *
 * These are the two settings that are actually ordered, and a list of radio
 * rows says nothing about that order: five rows of text give no clue which way
 * is further. Filled left of the knob and empty right of it says how far along
 * you are before any label is read, and the ramp deepening toward blue (or
 * warming toward amber at full autonomy) says which direction "further" points.
 */

const BAR_HEIGHT = 30;
const KNOB_SIZE = 38;
/** The knob overhangs the bar: inside it, it is too small to grab on a phone. */
const ROW_HEIGHT = KNOB_SIZE;
const DOT_SIZE = 5;
const CORE_DOT_SIZE = 7;

const RAMP = ['#BCC6D4', '#6E9AE4', '#0060F0'] as const;
const RAMP_DARK = ['#3A4453', '#2F5FA8', '#0060F0'] as const;

const PERMISSION_RAMP = ['#94A3B8', '#3B82F6', '#0060F0'] as const;
const PERMISSION_RAMP_DARK = ['#3B4758', '#3566D6', '#2574F5'] as const;

const PERMISSION_CAUTION_RAMP = ['#94A3B8', '#3B82F6', '#F59E0B', '#EA580C'] as const;
const PERMISSION_CAUTION_RAMP_DARK = ['#3B4758', '#3566D6', '#D97706', '#EA580C'] as const;

const spring = { damping: 22, stiffness: 280, mass: 0.68 } as const;
const pressSpring = { damping: 18, stiffness: 340, mass: 0.55 } as const;
// The description changes under the knob as it moves, so it arrives rather
// than snapping — the same 160ms cubic-out every other surface here uses.
const DESCRIBE = { duration: 160, easing: Easing.out(Easing.cubic) } as const;

export type StopSliderProps = {
    title: string;
    /** The current notch's own name, shown beside the title. */
    valueLabel: string;
    /** What this notch means, in one line. Worth the space for permission. */
    description?: string | null;
    leftLabel?: string;
    rightLabel?: string;
    /** Optional per-stop short labels rendered as clickable pills beneath the bar. */
    stepLabels?: string[];
    /** Semantic palette: permission warms toward amber when the last notch is full autonomy. */
    tone?: 'effort' | 'permission';
    /** True when the rightmost stop grants unprompted execution (Yolo / Bypass). */
    cautionAtEnd?: boolean;
    /** Optional leading icon before the title (used in settings & creation cards). */
    leadingIcon?: React.ReactNode;
    /** Optional trailing element beside the active value (e.g. Reset to default). */
    headerRight?: React.ReactNode;
    /** Removes outer menu horizontal inset when embedded inside a card or settings row. */
    compact?: boolean;
    disabled?: boolean;
    count: number;
    index: number;
    onChange: (index: number) => void;
};

export function StopSlider(props: StopSliderProps) {
    const { theme } = useUnistyles();
    const [width, setWidth] = React.useState(0);
    const widthRef = React.useRef(0);
    const trackNodeRef = React.useRef<View>(null);
    const draggingRef = React.useRef(false);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        widthRef.current = event.nativeEvent.layout.width;
        setWidth(event.nativeEvent.layout.width);
    }, []);

    const {
        count,
        index,
        onChange,
        tone = 'effort',
        cautionAtEnd = false,
        disabled = false,
    } = props;

    const clampedIndex = Math.max(0, Math.min(Math.max(0, count - 1), index));
    const isCautionActive = cautionAtEnd && count > 1 && clampedIndex === count - 1;

    // First notch at the left end, last at the right, knob always fully inside.
    const travel = Math.max(0, width - KNOB_SIZE);
    const centerOf = React.useCallback(
        (at: number) => KNOB_SIZE / 2 + (count > 1 ? (travel * at) / (count - 1) : 0),
        [count, travel],
    );

    const center = useSharedValue(0);
    const knobScale = useSharedValue(1);
    React.useEffect(() => {
        const next = centerOf(clampedIndex);
        if (width <= 0) return;
        // The first layout places the knob; every move after that animates.
        center.value = center.value === 0 ? next : withSpring(next, spring);
    }, [center, centerOf, clampedIndex, width]);

    const fillStyle = useAnimatedStyle(() => ({ width: center.value }));
    const describeOpacity = useSharedValue(1);
    React.useEffect(() => {
        describeOpacity.value = 0;
        describeOpacity.value = withTiming(1, DESCRIBE);
    }, [describeOpacity, props.description]);
    const describeStyle = useAnimatedStyle(() => ({ opacity: describeOpacity.value }));
    const knobStyle = useAnimatedStyle(() => ({
        transform: [
            { translateX: center.value - KNOB_SIZE / 2 },
            { scale: knobScale.value },
        ],
    }));

    const lastRef = React.useRef(clampedIndex);
    React.useEffect(() => { lastRef.current = clampedIndex; }, [clampedIndex]);

    const commitAtX = React.useCallback((localX: number, measuredWidth?: number) => {
        if (disabled) return;
        const measured = measuredWidth && measuredWidth > 0 ? measuredWidth : widthRef.current;
        if (measured <= 0 || count < 2) return;
        const span = Math.max(1, measured - KNOB_SIZE);
        const at = (localX - KNOB_SIZE / 2) / span;
        const next = Math.max(0, Math.min(count - 1, Math.round(at * (count - 1))));
        if (next === lastRef.current) return;
        lastRef.current = next;
        onChange(next);
    }, [count, disabled, onChange]);

    const handleNativeResponder = React.useCallback((event: GestureResponderEvent) => {
        commitAtX(event.nativeEvent.locationX);
    }, [commitAtX]);

    const webTrackProps = React.useMemo(() => {
        if (Platform.OS !== 'web') return {};
        const resolveClientX = (event: any) => {
            const rect = event.currentTarget?.getBoundingClientRect?.();
            if (!rect) return;
            commitAtX(event.clientX - rect.left, rect.width);
        };
        return {
            role: 'slider',
            'aria-valuemin': 1,
            'aria-valuemax': count,
            'aria-valuenow': clampedIndex + 1,
            'aria-valuetext': props.valueLabel,
            'aria-disabled': disabled ? 'true' : undefined,
            tabIndex: disabled ? -1 : 0,
            onPointerDown: (event: any) => {
                if (disabled || (typeof event.button === 'number' && event.button !== 0)) return;
                draggingRef.current = true;
                knobScale.value = withSpring(1.06, pressSpring);
                try {
                    event.currentTarget?.setPointerCapture?.(event.pointerId);
                } catch {
                    // Synthetic events in unit tests may omit pointer capture.
                }
                resolveClientX(event);
            },
            onPointerMove: (event: any) => {
                if (!draggingRef.current || disabled) return;
                resolveClientX(event);
            },
            onPointerUp: (event: any) => {
                if (!draggingRef.current) return;
                draggingRef.current = false;
                knobScale.value = withSpring(1, pressSpring);
                try {
                    event.currentTarget?.releasePointerCapture?.(event.pointerId);
                } catch {}
            },
            onPointerCancel: () => {
                draggingRef.current = false;
                knobScale.value = withSpring(1, pressSpring);
            },
            onKeyDown: (event: any) => {
                if (disabled || count < 2) return;
                let next: number | null = null;
                if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
                    next = Math.max(0, lastRef.current - 1);
                } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
                    next = Math.min(count - 1, lastRef.current + 1);
                } else if (event.key === 'Home') {
                    next = 0;
                } else if (event.key === 'End') {
                    next = count - 1;
                }
                if (next !== null && next !== lastRef.current) {
                    event.preventDefault?.();
                    lastRef.current = next;
                    onChange(next);
                }
            },
        };
    }, [clampedIndex, commitAtX, count, disabled, knobScale, onChange, props.valueLabel]);

    const rampColors = tone === 'permission'
        ? (cautionAtEnd
            ? (theme.dark ? PERMISSION_CAUTION_RAMP_DARK : PERMISSION_CAUTION_RAMP)
            : (theme.dark ? PERMISSION_RAMP_DARK : PERMISSION_RAMP))
        : (theme.dark ? RAMP_DARK : RAMP);

    const cautionTextColor = theme.dark ? '#FBBF24' : '#D97706';
    const cautionBadgeBg = theme.dark ? 'rgba(245, 158, 11, 0.16)' : 'rgba(245, 158, 11, 0.12)';
    const activeBadgeBg = isCautionActive
        ? cautionBadgeBg
        : (theme.dark ? 'rgba(59, 130, 246, 0.16)' : 'rgba(0, 96, 240, 0.09)');
    const activeTextColor = isCautionActive ? cautionTextColor : theme.colors.radio.active;

    const coreDotColor = isCautionActive
        ? '#F59E0B'
        : clampedIndex === 0
            ? (theme.dark ? '#7C8B9E' : '#8A99AD')
            : theme.colors.radio.active;

    const hasStepPills = Array.isArray(props.stepLabels)
        && props.stepLabels.length === count
        && count >= 2
        && count <= 6;

    return (
        <View style={[styles.container, props.compact && styles.containerCompact, disabled && styles.containerDisabled]}>
            <View style={styles.header}>
                <View style={styles.titleGroup}>
                    {props.leadingIcon}
                    <Text style={styles.title} numberOfLines={1}>{props.title}</Text>
                </View>
                <View style={styles.headerRightGroup}>
                    {props.headerRight}
                    <View style={[styles.valueBadge, { backgroundColor: activeBadgeBg }]}>
                        <Text style={[styles.value, { color: activeTextColor }]} numberOfLines={1}>
                            {props.valueLabel}
                        </Text>
                    </View>
                </View>
            </View>
            <View
                ref={trackNodeRef}
                style={[styles.row, Platform.OS === 'web' && !disabled && styles.rowWebInteractive]}
                onLayout={onLayout}
                accessibilityRole="adjustable"
                accessibilityLabel={props.title}
                accessibilityState={{ disabled }}
                accessibilityValue={{ min: 1, max: count, now: clampedIndex + 1, text: props.valueLabel }}
                onStartShouldSetResponder={Platform.OS === 'web' ? undefined : () => !disabled}
                onMoveShouldSetResponder={Platform.OS === 'web' ? undefined : () => !disabled}
                onResponderGrant={Platform.OS === 'web' ? undefined : (e) => {
                    knobScale.value = withSpring(1.06, pressSpring);
                    handleNativeResponder(e);
                }}
                onResponderMove={Platform.OS === 'web' ? undefined : handleNativeResponder}
                onResponderRelease={Platform.OS === 'web' ? undefined : () => {
                    knobScale.value = withSpring(1, pressSpring);
                }}
                onResponderTerminate={Platform.OS === 'web' ? undefined : () => {
                    knobScale.value = withSpring(1, pressSpring);
                }}
                {...(webTrackProps as object)}
            >
                <View pointerEvents="none" style={[styles.bar, { backgroundColor: theme.colors.surfaceHighest }]}>
                    {width > 0 && Array.from({ length: count }, (_, at) => at).map((at) => (
                        <View
                            key={at}
                            pointerEvents="none"
                            style={[
                                styles.dot,
                                {
                                    left: centerOf(at) - DOT_SIZE / 2,
                                    backgroundColor: cautionAtEnd && at === count - 1
                                        ? (theme.dark ? 'rgba(245, 158, 11, 0.55)' : 'rgba(217, 119, 6, 0.45)')
                                        : theme.colors.radio.inactive,
                                },
                            ]}
                        />
                    ))}
                    <Animated.View pointerEvents="none" style={[styles.fillClip, fillStyle]}>
                        {width > 0 && (
                            <LinearGradient
                                colors={rampColors}
                                start={{ x: 0, y: 0.5 }}
                                end={{ x: 1, y: 0.5 }}
                                style={{ width, height: BAR_HEIGHT }}
                            />
                        )}
                    </Animated.View>
                </View>
                {width > 0 && (
                    <Animated.View
                        pointerEvents="none"
                        style={[
                            styles.knob,
                            knobStyle,
                            {
                                backgroundColor: theme.dark ? '#F4F6F9' : '#FFFFFF',
                                borderColor: isCautionActive
                                    ? (theme.dark ? 'rgba(245, 158, 11, 0.65)' : 'rgba(217, 119, 6, 0.36)')
                                    : (theme.dark ? 'rgba(255, 255, 255, 0.88)' : theme.colors.divider),
                            },
                        ]}
                    >
                        <View style={[styles.knobCore, { backgroundColor: coreDotColor }]} />
                    </Animated.View>
                )}
            </View>
            {hasStepPills ? (
                <View style={styles.stepRow}>
                    {props.stepLabels!.map((label, at) => {
                        const selected = at === clampedIndex;
                        const stepIsCaution = cautionAtEnd && at === count - 1;
                        return (
                            <Pressable
                                key={`${at}-${label}`}
                                disabled={disabled}
                                hitSlop={{ top: 4, bottom: 6, left: 2, right: 2 }}
                                accessibilityRole="button"
                                accessibilityState={{ selected, disabled }}
                                accessibilityLabel={label}
                                onPress={() => {
                                    if (disabled || at === lastRef.current) return;
                                    lastRef.current = at;
                                    onChange(at);
                                }}
                                style={({ pressed }) => [
                                    styles.stepPill,
                                    selected && {
                                        backgroundColor: stepIsCaution
                                            ? cautionBadgeBg
                                            : theme.colors.surfaceHighest,
                                    },
                                    pressed && !disabled && { opacity: 0.68 },
                                ]}
                            >
                                <Text
                                    numberOfLines={1}
                                    style={[
                                        styles.stepPillText,
                                        selected && {
                                            color: stepIsCaution ? cautionTextColor : theme.colors.text,
                                            ...Typography.default('semiBold'),
                                        },
                                    ]}
                                >
                                    {label}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>
            ) : (props.leftLabel || props.rightLabel) ? (
                <View style={styles.ends}>
                    <Text style={styles.endLabel}>{props.leftLabel ?? ''}</Text>
                    <Text style={styles.endLabel}>{props.rightLabel ?? ''}</Text>
                </View>
            ) : null}
            {!!props.description && (
                <Animated.Text style={[styles.description, describeStyle]}>
                    {props.description}
                </Animated.Text>
            )}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    // Inset to the same 16 as every row in the menu around it: the model name,
    // the section labels and these titles all start on one line.
    container: { marginHorizontal: 6, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 6 },
    containerCompact: { marginHorizontal: 0, paddingHorizontal: 0, paddingTop: 4, paddingBottom: 2 },
    containerDisabled: { opacity: 0.45 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    titleGroup: { flexDirection: 'row', alignItems: 'center', gap: 7, flexShrink: 1, minWidth: 0 },
    headerRightGroup: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
    title: { fontSize: 13, lineHeight: 18, color: theme.colors.text, ...Typography.default('semiBold') },
    valueBadge: {
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 999,
        maxWidth: 180,
    },
    value: { fontSize: 12, lineHeight: 16, flexShrink: 1, textAlign: 'right', ...Typography.default('semiBold') },
    row: { height: ROW_HEIGHT, marginTop: 6, justifyContent: 'center' },
    rowWebInteractive: Platform.select({
        web: { cursor: 'pointer', touchAction: 'none', userSelect: 'none', outlineStyle: 'none' } as any,
        default: {},
    }),
    bar: {
        height: BAR_HEIGHT,
        borderRadius: BAR_HEIGHT / 2,
        overflow: 'hidden',
        justifyContent: 'center',
    },
    fillClip: { position: 'absolute', left: 0, top: 0, bottom: 0, overflow: 'hidden' },
    dot: { position: 'absolute', width: DOT_SIZE, height: DOT_SIZE, borderRadius: DOT_SIZE / 2 },
    knob: {
        position: 'absolute',
        left: 0,
        width: KNOB_SIZE,
        height: KNOB_SIZE,
        borderRadius: KNOB_SIZE / 2,
        borderWidth: StyleSheet.hairlineWidth,
        alignItems: 'center',
        justifyContent: 'center',
        ...Platform.select({
            web: { boxShadow: '0 2px 8px rgba(0,0,0,0.15), 0 0.5px 1.5px rgba(0,0,0,0.08)' },
            default: { shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 6, shadowOffset: { width: 0, height: 1.5 }, elevation: 3 },
        }),
    },
    knobCore: {
        width: CORE_DOT_SIZE,
        height: CORE_DOT_SIZE,
        borderRadius: CORE_DOT_SIZE / 2,
    },
    stepRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 2,
        marginTop: 5,
    },
    stepPill: {
        paddingHorizontal: 6,
        paddingVertical: 2.5,
        borderRadius: 7,
        flexShrink: 1,
        minWidth: 0,
        ...Platform.select({
            web: { cursor: 'pointer', userSelect: 'none' } as any,
            default: {},
        }),
    },
    stepPillText: {
        fontSize: 11,
        lineHeight: 15,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default(),
    },
    ends: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 },
    endLabel: { fontSize: 11, lineHeight: 15, color: theme.colors.textSecondary, ...Typography.default() },
    description: { fontSize: 11.5, lineHeight: 16, color: theme.colors.textSecondary, marginTop: 5, ...Typography.default() },
}));
