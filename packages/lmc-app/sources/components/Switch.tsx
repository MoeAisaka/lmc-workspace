import * as React from 'react';
import { Pressable, SwitchProps, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useDerivedValue, withTiming } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';

const TRACK_WIDTH = 40;
const TRACK_HEIGHT = 24;
const KNOB = 20;
const PADDING = 2;

/**
 * One switch on every platform.
 *
 * The platform control was iOS-green on the phone and 51×31 on the web, so the
 * same setting looked like two different products depending on where it was
 * read. This draws the track and knob directly: the brand blue, sized to sit in
 * a settings row without towering over its label.
 */
export const Switch = (props: SwitchProps) => {
    const { theme } = useUnistyles();
    const on = !!props.value;
    const progress = useDerivedValue(() => withTiming(on ? 1 : 0, { duration: 160, easing: Easing.out(Easing.cubic) }), [on]);
    const knobStyle = useAnimatedStyle(() => ({ transform: [{ translateX: progress.value * (TRACK_WIDTH - KNOB - PADDING * 2) }] }));

    return (
        <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: on, disabled: !!props.disabled }}
            disabled={props.disabled}
            hitSlop={8}
            onPress={() => props.onValueChange?.(!on)}
            style={({ pressed }) => ({ opacity: props.disabled ? 0.4 : pressed ? 0.8 : 1 })}
        >
            <View style={{
                width: TRACK_WIDTH,
                height: TRACK_HEIGHT,
                borderRadius: TRACK_HEIGHT / 2,
                justifyContent: 'center',
                paddingHorizontal: PADDING,
                backgroundColor: on ? theme.colors.switch.track.active : theme.colors.switch.track.inactive,
            }}>
                <Animated.View style={[{
                    width: KNOB,
                    height: KNOB,
                    borderRadius: KNOB / 2,
                    backgroundColor: theme.colors.switch.thumb.active,
                    shadowColor: '#101828',
                    shadowOpacity: 0.2,
                    shadowRadius: 2,
                    shadowOffset: { width: 0, height: 1 },
                    elevation: 2,
                }, knobStyle]} />
            </View>
        </Pressable>
    );
};
