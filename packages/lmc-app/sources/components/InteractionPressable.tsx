import * as React from 'react';
import {
    Platform,
    Pressable as NativePressable,
    TouchableOpacity as NativeTouchableOpacity,
    type PressableProps,
    type TouchableOpacityProps,
    type View,
    type GestureResponderEvent,
} from 'react-native';

type Feedback = 'surface' | 'control' | 'none';
type WebFeedbackProps = {
    /** Surfaces keep their position; compact controls also respond to pressure. */
    interaction?: Feedback;
    dataSet?: Record<string, string | number | undefined>;
};

function usePressFeedback(disabled: boolean, onPressIn?: ((event: GestureResponderEvent) => void) | null, onPressOut?: ((event: GestureResponderEvent) => void) | null) {
    const [pressed, setPressed] = React.useState(false);
    React.useEffect(() => { if (disabled) setPressed(false); }, [disabled]);
    const pressIn = React.useCallback((event: GestureResponderEvent) => {
        if (!disabled) setPressed(true);
        onPressIn?.(event);
    }, [disabled, onPressIn]);
    const pressOut = React.useCallback((event: GestureResponderEvent) => {
        setPressed(false);
        onPressOut?.(event);
    }, [onPressOut]);
    return { pressed, onPressIn: pressIn, onPressOut: pressOut };
}

/** One web feedback contract, with the original native events, styles and ref. */
export const InteractionPressable = React.memo(React.forwardRef<
    View, PressableProps & WebFeedbackProps
>(function InteractionPressable({ interaction = 'surface', dataSet, ...props }, ref) {
    const disabled = !!(props.disabled || props.accessibilityState?.disabled);
    const feedback = usePressFeedback(disabled, props.onPressIn, props.onPressOut);
    return <NativePressable {...props} ref={ref}
        {...(Platform.OS === 'web' ? { onPressIn: feedback.onPressIn, onPressOut: feedback.onPressOut, dataSet: {
            ...dataSet,
            'yulor-interaction': interaction,
            'yulor-disabled': disabled ? 'true' : undefined,
            'yulor-pressed': feedback.pressed ? 'true' : undefined,
        } } : {})} />;
}));

/** Keep legacy opacity controls on the same hover/focus system without changing actions. */
export const InteractionTouchableOpacity = React.memo(React.forwardRef<
    React.ElementRef<typeof NativeTouchableOpacity>, TouchableOpacityProps & WebFeedbackProps
>(function InteractionTouchableOpacity({ interaction = 'surface', dataSet, ...props }, ref) {
    const disabled = !!(props.disabled || props.accessibilityState?.disabled);
    const feedback = usePressFeedback(disabled, props.onPressIn, props.onPressOut);
    return <NativeTouchableOpacity {...props} ref={ref}
        {...(Platform.OS === 'web' ? { onPressIn: feedback.onPressIn, onPressOut: feedback.onPressOut, dataSet: {
            ...dataSet,
            'yulor-interaction': interaction,
            'yulor-disabled': disabled ? 'true' : undefined,
            'yulor-pressed': feedback.pressed ? 'true' : undefined,
        } } : {})} />;
}));
