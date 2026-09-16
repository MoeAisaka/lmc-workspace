/**
 * Horizontal scrollable strip showing selected image attachment thumbnails.
 * Each thumbnail shows the image with a remove button.
 * Uses thumbhash as a blurry placeholder while the full image loads.
 */
import * as React from 'react';
import { ScrollView, View, Pressable, Text } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { AttachmentPreview } from '@/sync/attachmentTypes';
import { thumbhashToDataUri } from '@/utils/thumbhash';
import { t } from '@/text';

const THUMB_SIZE = 64;
const BORDER_RADIUS = 8;

interface AgentInputAttachmentStripProps {
    images: AttachmentPreview[];
    onRemove: (id: string) => void;
}

export function AgentInputAttachmentStrip({ images, onRemove }: AgentInputAttachmentStripProps) {
    const { theme } = useUnistyles();

    if (images.length === 0) return null;

    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.strip}
            contentContainerStyle={styles.stripContent}
            keyboardShouldPersistTaps="always"
        >
            {images.map((img) => (
                <AttachmentThumbnail
                    key={img.id}
                    image={img}
                    onRemove={onRemove}
                    theme={theme}
                />
            ))}
        </ScrollView>
    );
}

function AttachmentThumbnail({
    image,
    onRemove,
    theme,
}: {
    image: AttachmentPreview;
    onRemove: (id: string) => void;
    theme: any;
}) {
    // Build placeholder from thumbhash if available
    const placeholder = React.useMemo(() => {
        if (!image.thumbhash) return undefined;
        const uri = thumbhashToDataUri(image.thumbhash);
        return uri ? { uri } : undefined;
    }, [image.thumbhash]);

    const isImage = image.mimeType.startsWith('image/');
    if (!isImage) {
        const kb = image.size > 0 ? (image.size >= 1024 * 1024 ? `${(image.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(image.size / 1024))} KB`) : '';
        return (
            <View style={[styles.fileCard, { borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh }]}>
                <Ionicons name="document-outline" size={20} color={theme.colors.textSecondary} />
                <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={{ fontSize: 12, color: theme.colors.text }}>{image.name}</Text>
                    <Text numberOfLines={1} style={{ fontSize: 11, color: theme.colors.textSecondary }}>{kb || t('lmc.common.attachedFile')} · 发到会话所在 Mac</Text>
                </View>
                <Pressable onPress={() => onRemove(image.id)} hitSlop={4} style={(p) => [styles.removeButton, { backgroundColor: theme.colors.surfaceHigh, opacity: p.pressed ? 0.7 : 1 }]}>
                    <Ionicons name="close" size={10} color={theme.colors.text} />
                </Pressable>
            </View>
        );
    }
    return (
        <View style={[
            styles.thumbContainer,
            { borderColor: theme.colors.divider }
        ]}>
            <Image
                source={{ uri: image.uri }}
                placeholder={placeholder}
                style={[{ width: THUMB_SIZE, height: THUMB_SIZE }, styles.thumb]}
                contentFit="cover"
                transition={150}
            />
            {/* Remove button */}
            <Pressable
                onPress={() => onRemove(image.id)}
                hitSlop={4}
                style={(p) => [
                    styles.removeButton,
                    { backgroundColor: theme.colors.surfaceHigh, opacity: p.pressed ? 0.7 : 1 }
                ]}
            >
                <Ionicons name="close" size={10} color={theme.colors.text} />
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    strip: {
        marginBottom: 8,
        marginHorizontal: 8,
    },
    stripContent: {
        flexDirection: 'row',
        gap: 8,
        paddingHorizontal: 4,
    },
    thumbContainer: {
        width: THUMB_SIZE,
        height: THUMB_SIZE,
        borderRadius: BORDER_RADIUS,
        overflow: 'visible',
        borderWidth: 1,
        position: 'relative',
    },
    thumb: {
        borderRadius: BORDER_RADIUS,
    },
    fileCard: {
        height: THUMB_SIZE,
        width: 200,
        borderRadius: BORDER_RADIUS,
        borderWidth: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 10,
        position: 'relative',
    },
    removeButton: {
        position: 'absolute',
        top: -6,
        right: -6,
        width: 18,
        height: 18,
        borderRadius: 9,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10,
    },
}));
