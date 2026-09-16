import * as React from 'react';
import { Platform, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
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
 * you are before any label is read, and the ramp deepening toward blue says
 * which direction "further" points.
 */

const BAR_HEIGHT = 30;
const KNOB_SIZE = 40;
/** The knob overhangs the bar: inside it, it is too small to grab on a phone. */
const ROW_HEIGHT = KNOB_SIZE;
const DOT_SIZE = 5;

/**
 * The ramp: a cool grey at the cautious end, the interface's own blue at the
 * committed end. It is painted at the bar's full width and revealed by the
 * fill, so the colour under the knob depends on where the knob is standing and
 * not on how wide the fill happens to be.
 */
const RAMP = ['#BCC6D4', '#6E9AE4', '#0060F0'] as const;
const RAMP_DARK = ['#3A4453', '#2F5FA8', '#0060F0'] as const;

const spring = { damping: 22, stiffness: 260, mass: 0.7 } as const;
// The description changes under the knob as it moves, so it arrives rather
// than snapping — the same 160ms cubic-out every other surface here uses.
// Driven by a shared value on one long-lived node, not by remounting a keyed
// node with an entering animation: on web each such mount registers a layout
// animation that outlives it, and a slider is dragged many times.
const DESCRIBE = { duration: 160, easing: Easing.out(Easing.cubic) } as const;

export type StopSliderProps = {
    title: string;
    /** The current notch's own name, shown beside the title. */
    valueLabel: string;
    /** What this notch means, in one line. Worth the space for permission. */
    description?: string | null;
    leftLabel: string;
    rightLabel: string;
    count: number;
    index: number;
    onChange: (index: number) => void;
};

export function StopSlider(props: StopSliderProps) {
    const { theme } = useUnistyles();
    const [width, setWidth] = React.useState(0);
    const widthRef = React.useRef(0);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        widthRef.current = event.nativeEvent.layout.width;
        setWidth(event.nativeEvent.layout.width);
    }, []);

    const { count, index, onChange } = props;

    // First notch at the left end, last at the right, knob always fully inside.
    const travel = Math.max(0, width - KNOB_SIZE);
    const centerOf = React.useCallback(
        (at: number) => KNOB_SIZE / 2 + (count > 1 ? (travel * at) / (count - 1) : 0),
        [count, travel],
    );

    const center = useSharedValue(0);
    React.useEffect(() => {
        const next = centerOf(index);
        // The first layout places the knob; every move after that animates.
        center.value = center.value === 0 ? next : withSpring(next, spring);
    }, [center, centerOf, index]);

    const fillStyle = useAnimatedStyle(() => ({ width: center.value }));
    const describeOpacity = useSharedValue(1);
    React.useEffect(() => {
        describeOpacity.value = 0;
        describeOpacity.value = withTiming(1, DESCRIBE);
    }, [describeOpacity, props.description]);
    const describeStyle = useAnimatedStyle(() => ({ opacity: describeOpacity.value }));
    const knobStyle = useAnimatedStyle(() => ({ transform: [{ translateX: center.value - KNOB_SIZE / 2 }] }));

    // The gesture reports a position, not a notch; the notch is whichever stop
    // the finger is nearest, clamped so dragging past either end simply stops.
    const lastRef = React.useRef(index);
    React.useEffect(() => { lastRef.current = index; }, [index]);
    const handleAt = React.useCallback((event: GestureResponderEvent) => {
        const measured = widthRef.current;
        if (measured <= 0 || count < 2) return;
        const span = Math.max(1, measured - KNOB_SIZE);
        const at = (event.nativeEvent.locationX - KNOB_SIZE / 2) / span;
        const next = Math.max(0, Math.min(count - 1, Math.round(at * (count - 1))));
        if (next === lastRef.current) return;
        lastRef.current = next;
        onChange(next);
    }, [count, onChange]);

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.title}>{props.title}</Text>
                <Text style={styles.value} numberOfLines={1}>{props.valueLabel}</Text>
            </View>
            <View
                style={styles.row}
                onLayout={onLayout}
                accessibilityRole="adjustable"
                accessibilityLabel={props.title}
                accessibilityValue={{ min: 1, max: count, now: index + 1, text: props.valueLabel }}
                onStartShouldSetResponder={() => true}
                onMoveShouldSetResponder={() => true}
                onResponderGrant={handleAt}
                onResponderMove={handleAt}
            >
                <View style={[styles.bar, { backgroundColor: theme.colors.surfaceHighest }]}>
                    {/* Notches still ahead of the knob. Behind it the fill says
                        the same thing, and the fill is drawn over them. */}
                    {width > 0 && Array.from({ length: count }, (_, at) => at).map((at) => (
                        <View
                            key={at}
                            style={[styles.dot, { left: centerOf(at) - DOT_SIZE / 2, backgroundColor: theme.colors.radio.inactive }]}
                        />
                    ))}
                    <Animated.View style={[styles.fillClip, fillStyle]}>
                        {width > 0 && (
                            <LinearGradient
                                colors={theme.dark ? RAMP_DARK : RAMP}
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
                            { backgroundColor: theme.colors.surface, borderColor: theme.colors.divider },
                        ]}
                    />
                )}
            </View>
            <View style={styles.ends}>
                <Text style={styles.endLabel}>{props.leftLabel}</Text>
                <Text style={styles.endLabel}>{props.rightLabel}</Text>
            </View>
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
    container: { marginHorizontal: 6, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 4 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    title: { fontSize: 13, lineHeight: 18, color: theme.colors.text, ...Typography.default('semiBold') },
    value: { fontSize: 13, lineHeight: 18, color: theme.colors.radio.active, flexShrink: 1, textAlign: 'right', ...Typography.default('semiBold') },
    row: { height: ROW_HEIGHT, marginTop: 6, justifyContent: 'center' },
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
        ...Platform.select({
            web: { boxShadow: '0 1px 6px rgba(0,0,0,0.13)' },
            default: { shadowColor: '#000', shadowOpacity: 0.13, shadowRadius: 5, shadowOffset: { width: 0, height: 1 }, elevation: 3 },
        }),
    },
    ends: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 },
    endLabel: { fontSize: 11, lineHeight: 15, color: theme.colors.textSecondary, ...Typography.default() },
    description: { fontSize: 11.5, lineHeight: 16, color: theme.colors.textSecondary, marginTop: 6, ...Typography.default() },
}));
