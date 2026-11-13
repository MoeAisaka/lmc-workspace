import React from 'react';
import { Keyboard } from 'react-native';
import { InteractionPressable as Pressable } from '@/components/InteractionPressable';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

interface PlaceholderContainerViewProps {
    children: React.ReactNode;
    style?: any;
    contentContainerStyle?: any;
}

export const PlaceholderContainerView: React.FC<PlaceholderContainerViewProps> = ({
    children,
    style,
    contentContainerStyle
}) => {
    const { height, progress } = useReanimatedKeyboardAnimation();

    const animatedStyle = useAnimatedStyle(() => {
        // Shift content up by half the keyboard height when keyboard is visible
        const translateY = height.value * progress.value * 0.5;
        
        return {
            transform: [{ translateY }],
        };
    }, []);

    return (
        <Animated.View style={[{ flex: 1 }, style]}>
            <Pressable interaction="none"
                style={[
                    {
                        flex: 1,
                        justifyContent: 'center',
                        alignItems: 'center',
                    },
                    contentContainerStyle
                ]}
                onPress={() => Keyboard.dismiss()}
            >
                <Animated.View style={animatedStyle}>
                    {children}
                </Animated.View>
            </Pressable>
        </Animated.View>
    );
};