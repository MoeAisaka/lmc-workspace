import React, { useEffect, useRef } from 'react';
import {
    View,
    Modal,
    TouchableWithoutFeedback,
    Animated,
    StyleSheet,
    KeyboardAvoidingView,
    Platform
} from 'react-native';
import { AnimatedBlurBackdrop } from '@/components/AnimatedOverlay';

// On web, stop events from propagating to expo-router's modal overlay
// which intercepts clicks when it applies pointer-events: none to body
const stopPropagation = (e: { stopPropagation: () => void }) => e.stopPropagation();
const webEventHandlers = Platform.OS === 'web'
    ? { onClick: stopPropagation, onPointerDown: stopPropagation, onTouchStart: stopPropagation }
    : {};

interface BaseModalProps {
    visible: boolean;
    onClose?: () => void;
    children: React.ReactNode;
    animationType?: 'fade' | 'slide' | 'none';
    transparent?: boolean;
    closeOnBackdrop?: boolean;
    closeOnRequestClose?: boolean;
    blurBackdrop?: boolean;
    onExitComplete?: () => void;
}

export function BaseModal({
    visible,
    onClose,
    children,
    animationType = 'fade',
    transparent = true,
    closeOnBackdrop = true,
    closeOnRequestClose = true,
    blurBackdrop = false,
    onExitComplete,
}: BaseModalProps) {
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const exitCallback = useRef(onExitComplete);
    exitCallback.current = onExitComplete;

    useEffect(() => {
        const animation = Animated.timing(fadeAnim, {
            toValue: visible ? 1 : 0,
            duration: 200,
            useNativeDriver: true,
        });
        animation.start(({ finished }) => {
            if (finished && !visible) exitCallback.current?.();
        });
        return () => animation.stop();
    }, [visible, fadeAnim]);

    const handleBackdropPress = () => {
        if (visible && closeOnBackdrop && onClose) {
            onClose();
        }
    };

    return (
        <Modal
            visible={visible || !!onExitComplete}
            transparent={transparent}
            animationType={onExitComplete ? 'none' : animationType}
            onRequestClose={closeOnRequestClose ? onClose : () => {}}
        >
            <KeyboardAvoidingView
                style={styles.container}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                {...webEventHandlers}
            >
                {Platform.OS === 'web' ? (
                    <TouchableWithoutFeedback onPress={handleBackdropPress}>
                        <Animated.View
                            style={[
                                styles.backdrop,
                                blurBackdrop && ({ backgroundColor: 'rgba(0, 0, 0, 0.08)', backdropFilter: 'blur(5px)', WebkitBackdropFilter: 'blur(5px)' } as any),
                                {
                                    opacity: fadeAnim.interpolate({
                                        inputRange: [0, 1],
                                        outputRange: [0, blurBackdrop ? 1 : 0.5],
                                    }),
                                },
                            ]}
                        />
                    </TouchableWithoutFeedback>
                ) : (
                    <Animated.View style={[StyleSheet.absoluteFillObject, { opacity: fadeAnim }]}>
                      <AnimatedBlurBackdrop
                        blurIntensity={44}
                        dimColor="rgba(0, 0, 0, 0.42)"
                        onPress={handleBackdropPress}
                      />
                    </Animated.View>
                )}
                
                <Animated.View
                    pointerEvents={visible ? 'auto' : 'none'}
                    style={[
                        styles.content,
                        {
                            opacity: fadeAnim,
                            transform: [{
                                scale: fadeAnim.interpolate({
                                    inputRange: [0, 1],
                                    outputRange: [0.9, 1]
                                })
                            }]
                        }
                    ]}
                >
                    {children}
                </Animated.View>
            </KeyboardAvoidingView>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        // On web, ensure modal can receive pointer events when body has pointer-events: none
        ...Platform.select({ web: { pointerEvents: 'auto' as const } })
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'black',
    },
    content: {
        zIndex: 1
    }
});
