import React from 'react';
import {
    ActivityIndicator,
    Platform,
    Pressable,
    useWindowDimensions,
    View,
} from 'react-native';
import { Image } from 'expo-image';
import type { ImagePickerAsset } from 'expo-image-picker';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import {
    clampCropScale,
    clampTranslation,
    computeBaseScale,
    computeCropRect,
    scaleFromWheel,
    type CropRect,
} from '@/utils/avatarCrop';
import { createAvatarBlobUrlReleaser } from '@/utils/projectAvatarImage';

interface ProjectAvatarCropModalProps {
    asset: Pick<ImagePickerAsset, 'uri' | 'width' | 'height'>;
    onSave: (crop: CropRect) => Promise<void>;
    onClose: () => void;
}

export function ProjectAvatarCropModal({ asset, onSave, onClose }: ProjectAvatarCropModalProps) {
    const { theme } = useUnistyles();
    const window = useWindowDimensions();
    const styles = stylesheet;
    const frameSize = Math.floor(Math.max(
        140,
        Math.min(360, window.width - 56, window.height - 220),
    ));
    const modalWidth = Math.min(440, window.width - 32);
    const baseScale = computeBaseScale(asset.width, asset.height, frameSize);
    const baseWidth = asset.width * baseScale;
    const baseHeight = asset.height * baseScale;

    const scale = useSharedValue(1);
    const translateX = useSharedValue(0);
    const translateY = useSharedValue(0);
    const panOriginX = useSharedValue(0);
    const panOriginY = useSharedValue(0);
    const pinchOriginScale = useSharedValue(1);
    const [saving, setSaving] = React.useState(false);
    const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
    const releaseSourceUrl = React.useMemo(
        () => createAvatarBlobUrlReleaser(asset.uri),
        [asset.uri],
    );
    const closeAndRelease = React.useCallback(() => {
        releaseSourceUrl();
        onClose();
    }, [onClose, releaseSourceUrl]);

    React.useEffect(() => {
        scale.value = 1;
        translateX.value = 0;
        translateY.value = 0;
    }, [asset.uri, frameSize, scale, translateX, translateY]);

    const gesture = React.useMemo(() => {
        const pan = Gesture.Pan()
            .maxPointers(1)
            .onStart(() => {
                panOriginX.value = translateX.value;
                panOriginY.value = translateY.value;
            })
            .onUpdate((event) => {
                translateX.value = clampTranslation(
                    panOriginX.value + event.translationX,
                    baseWidth * scale.value,
                    frameSize,
                );
                translateY.value = clampTranslation(
                    panOriginY.value + event.translationY,
                    baseHeight * scale.value,
                    frameSize,
                );
            });
        const pinch = Gesture.Pinch()
            .onStart(() => {
                pinchOriginScale.value = scale.value;
            })
            .onUpdate((event) => {
                const nextScale = clampCropScale(pinchOriginScale.value * event.scale);
                scale.value = nextScale;
                translateX.value = clampTranslation(
                    translateX.value,
                    baseWidth * nextScale,
                    frameSize,
                );
                translateY.value = clampTranslation(
                    translateY.value,
                    baseHeight * nextScale,
                    frameSize,
                );
            });
        return Gesture.Simultaneous(pan, pinch);
    }, [
        baseHeight,
        baseWidth,
        frameSize,
        panOriginX,
        panOriginY,
        pinchOriginScale,
        scale,
        translateX,
        translateY,
    ]);

    const translationStyle = useAnimatedStyle(() => ({
        transform: [
            { translateX: translateX.value },
            { translateY: translateY.value },
        ],
    }));
    const scaleStyle = useAnimatedStyle(() => ({
        transform: [{ scale: scale.value }],
    }));

    const handleWheel = React.useCallback((event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        const deltaY = event.nativeEvent?.deltaY ?? event.deltaY ?? 0;
        const nextScale = scaleFromWheel(scale.value, deltaY);
        scale.value = nextScale;
        translateX.value = clampTranslation(
            translateX.value,
            baseWidth * nextScale,
            frameSize,
        );
        translateY.value = clampTranslation(
            translateY.value,
            baseHeight * nextScale,
            frameSize,
        );
    }, [baseHeight, baseWidth, frameSize, scale, translateX, translateY]);

    const handleSave = React.useCallback(async () => {
        if (saving) return;
        setSaving(true);
        setErrorMessage(null);
        const crop = computeCropRect({
            imageWidth: asset.width,
            imageHeight: asset.height,
            frame: frameSize,
            scale: scale.value,
            translateX: translateX.value,
            translateY: translateY.value,
        });
        try {
            await onSave(crop);
            closeAndRelease();
        } catch {
            setSaving(false);
            setErrorMessage(t('projectAvatar.saveFailedMessage'));
        }
    }, [asset.height, asset.width, closeAndRelease, frameSize, onSave, saving, scale, translateX, translateY]);

    const wheelProps = Platform.OS === 'web'
        ? ({ onWheel: handleWheel } as any)
        : {};

    return (
        <View style={[styles.modal, { width: modalWidth }]}>
            <Text style={styles.title}>{t('projectAvatar.cropTitle')}</Text>
            <Text style={styles.instructions}>{t('projectAvatar.cropInstructions')}</Text>

            <View
                testID="project-avatar-crop-frame"
                style={[styles.cropFrame, { width: frameSize, height: frameSize }]}
                {...wheelProps}
            >
                <GestureDetector gesture={gesture}>
                    <Animated.View style={styles.gestureSurface}>
                        <Animated.View
                            style={[
                                styles.imagePosition,
                                {
                                    left: (frameSize - baseWidth) / 2,
                                    top: (frameSize - baseHeight) / 2,
                                    width: baseWidth,
                                    height: baseHeight,
                                },
                                translationStyle,
                            ]}
                        >
                            <Animated.View style={[styles.imageScale, scaleStyle]}>
                                <Image
                                    source={{ uri: asset.uri }}
                                    style={{ width: baseWidth, height: baseHeight }}
                                    contentFit="fill"
                                    transition={100}
                                />
                            </Animated.View>
                        </Animated.View>
                    </Animated.View>
                </GestureDetector>
                <View pointerEvents="none" style={styles.squareGuide} />
                <View
                    pointerEvents="none"
                    style={[
                        styles.circleGuide,
                        { borderRadius: frameSize / 2 },
                    ]}
                />
            </View>

            {errorMessage && (
                <Text accessibilityRole="alert" style={styles.errorText}>
                    {errorMessage}
                </Text>
            )}

            <View style={styles.actions}>
                <Pressable
                    accessibilityRole="button"
                    disabled={saving}
                    onPress={closeAndRelease}
                    style={({ pressed }) => [
                        styles.button,
                        styles.cancelButton,
                        pressed && styles.buttonPressed,
                        saving && styles.buttonDisabled,
                    ]}
                >
                    <Text style={styles.cancelText}>{t('common.cancel')}</Text>
                </Pressable>
                <Pressable
                    accessibilityRole="button"
                    disabled={saving}
                    onPress={handleSave}
                    style={({ pressed }) => [
                        styles.button,
                        styles.saveButton,
                        pressed && styles.buttonPressed,
                        saving && styles.buttonDisabled,
                    ]}
                >
                    {saving ? (
                        <View style={styles.savingRow}>
                            <ActivityIndicator size="small" color={theme.colors.textLink} />
                            <Text style={styles.saveText}>{t('projectAvatar.saving')}</Text>
                        </View>
                    ) : (
                        <Text style={styles.saveText}>{t('common.save')}</Text>
                    )}
                </Pressable>
            </View>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    modal: {
        backgroundColor: theme.colors.surface,
        borderRadius: 20,
        padding: 16,
        alignItems: 'center',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.28,
        shadowRadius: 24,
        elevation: 8,
    },
    title: {
        color: theme.colors.text,
        fontSize: 18,
        lineHeight: 24,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    instructions: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
        marginTop: 4,
        marginBottom: 14,
        textAlign: 'center',
        ...Typography.default('regular'),
    },
    cropFrame: {
        position: 'relative',
        overflow: 'hidden',
        backgroundColor: '#111111',
        borderRadius: 14,
        ...Platform.select({
            web: {
                cursor: 'grab',
                touchAction: 'none',
                userSelect: 'none',
            } as any,
        }),
    },
    gestureSurface: {
        ...StyleSheet.absoluteFillObject,
    },
    imagePosition: {
        position: 'absolute',
    },
    imageScale: {
        width: '100%',
        height: '100%',
    },
    squareGuide: {
        ...StyleSheet.absoluteFillObject,
        borderWidth: 2,
        borderRadius: 14,
        borderColor: 'rgba(255, 255, 255, 0.78)',
    },
    circleGuide: {
        ...StyleSheet.absoluteFillObject,
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.45)',
    },
    errorText: {
        color: theme.colors.textDestructive,
        fontSize: 12,
        lineHeight: 17,
        marginTop: 10,
        textAlign: 'center',
        ...Typography.default('regular'),
    },
    actions: {
        flexDirection: 'row',
        width: '100%',
        gap: 10,
        marginTop: 14,
    },
    button: {
        flex: 1,
        minHeight: 42,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 12,
    },
    cancelButton: {
        backgroundColor: theme.colors.surfaceHighest,
    },
    saveButton: {
        backgroundColor: theme.colors.surfaceHighest,
    },
    buttonPressed: {
        opacity: 0.62,
    },
    buttonDisabled: {
        opacity: 0.5,
    },
    cancelText: {
        color: theme.colors.text,
        fontSize: 15,
        ...Typography.default('regular'),
    },
    saveText: {
        color: theme.colors.textLink,
        fontSize: 15,
        ...Typography.default('semiBold'),
    },
    savingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
}));
