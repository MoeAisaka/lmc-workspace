import * as React from 'react';
import { Image, Platform, Pressable, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { Modal } from '@/modal';
import { Text } from './StyledText';
import { t } from '@/text';

/** Reuse the already resolved/decrypted image; opening a preview never reads another session. */
export function openImagePreview(uri: string, label: string) {
    Modal.show({ component: ImagePreviewModal, props: { uri, label } });
}

type Pose = { scale: number; x: number; y: number };
const initialPose: Pose = { scale: 1, x: 0, y: 0 };

export function ImagePreviewModal({ uri, label, onClose }: { uri: string; label: string; onClose: () => void }) {
    const window = useWindowDimensions();
    const width = Math.max(1, Math.min(1400, window.width - 24));
    const height = Math.max(1, Math.min(1000, window.height - 32));
    const frameHeight = Math.max(1, height - 100);
    const [size, setSize] = React.useState({ width: 1, height: 1 });
    const [pose, setPose] = React.useState(initialPose);
    const current = React.useRef(initialPose);
    const panOrigin = React.useRef(initialPose);
    const pinchOrigin = React.useRef(1);
    const fit = Math.min(width / size.width, frameHeight / size.height);
    const imageWidth = size.width * fit;
    const imageHeight = size.height * fit;

    React.useEffect(() => {
        let active = true;
        Image.getSize(uri, (w, h) => { if (active && w > 0 && h > 0) setSize({ width: w, height: h }); }, () => {});
        return () => { active = false; };
    }, [uri]);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            onClose();
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
    }, [onClose]);

    const update = React.useCallback((next: Pose) => {
        const scale = Math.max(1, Math.min(5, next.scale));
        const limitX = Math.max(0, (imageWidth * scale - width) / 2);
        const limitY = Math.max(0, (imageHeight * scale - frameHeight) / 2);
        const value = { scale, x: Math.max(-limitX, Math.min(limitX, next.x)), y: Math.max(-limitY, Math.min(limitY, next.y)) };
        current.current = value;
        setPose(value);
    }, [imageWidth, imageHeight, width, frameHeight]);

    React.useEffect(() => { update(initialPose); }, [uri, update]);

    const gesture = React.useMemo(() => Gesture.Simultaneous(
        Gesture.Pan().maxPointers(1).runOnJS(true)
            .onStart(() => { panOrigin.current = current.current; })
            .onUpdate(event => update({ ...current.current, x: panOrigin.current.x + event.translationX, y: panOrigin.current.y + event.translationY })),
        Gesture.Pinch().runOnJS(true)
            .onStart(() => { pinchOrigin.current = current.current.scale; })
            .onUpdate(event => update({ ...current.current, scale: pinchOrigin.current * event.scale })),
        Gesture.Tap().numberOfTaps(2).runOnJS(true)
            .onEnd((_event, success) => { if (success) update({ ...initialPose, scale: current.current.scale > 1 ? 1 : 2 }); }),
    ), [update]);

    return (
        <View testID="image-preview" style={[styles.container, { width, height }]}>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <View style={styles.toolbar}>
                <Text numberOfLines={1} style={styles.title}>{label}</Text>
                <Pressable testID="image-preview-close" accessibilityRole="button" accessibilityLabel={t('lmc.common.close')} onPress={onClose} style={styles.button}>
                    <Ionicons name="close" size={24} color="white" />
                </Pressable>
            </View>
            <GestureDetector gesture={gesture}>
                <View style={[styles.frame, { height: frameHeight }]}
                    {...(Platform.OS === 'web' ? { onWheel: (event: any) => {
                        event.stopPropagation();
                        update({ ...current.current, scale: current.current.scale * Math.exp(-Math.max(-500, Math.min(500, event.deltaY)) * 0.002) });
                    } } as any : {})}
                >
                    <Image source={{ uri }} accessibilityLabel={label} resizeMode="contain"
                        style={{ width: imageWidth, height: imageHeight, transform: [{ translateX: pose.x }, { translateY: pose.y }, { scale: pose.scale }] }} />
                </View>
            </GestureDetector>
            <View style={styles.controls}>
                <Text numberOfLines={2} style={styles.hint}>{t('projectAvatar.cropInstructions')}</Text>
                <Pressable testID="image-preview-zoom-out" accessibilityRole="button" accessibilityLabel="−" onPress={() => update({ ...current.current, scale: current.current.scale - 0.5 })} style={styles.button}>
                    <Text style={styles.controlText}>−</Text>
                </Pressable>
                <Pressable testID="image-preview-reset" accessibilityRole="button" accessibilityLabel={t('common.reset')} onPress={() => update(initialPose)} style={styles.button}>
                    <Text style={styles.controlText}>{Math.round(pose.scale * 100)}%</Text>
                </Pressable>
                <Pressable testID="image-preview-zoom-in" accessibilityRole="button" accessibilityLabel="+" onPress={() => update({ ...current.current, scale: current.current.scale + 0.5 })} style={styles.button}>
                    <Text style={styles.controlText}>+</Text>
                </Pressable>
            </View>
          </GestureHandlerRootView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: { backgroundColor: '#141414', borderRadius: 16, overflow: 'hidden' },
    toolbar: { height: 50, flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 4 },
    title: { color: 'white', flex: 1, fontSize: 14 },
    button: { minWidth: 44, height: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
    frame: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
    controls: { height: 50, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
    hint: { color: '#bdbdbd', fontSize: 11, flex: 1, paddingHorizontal: 8 },
    controlText: { color: 'white', fontSize: 15 },
});
