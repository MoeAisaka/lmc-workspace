import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useMessage } from '@/sync/storage';
import { ToolFullView } from '@/components/tools/ToolFullView';
import { ToolHeader } from '@/components/tools/ToolHeader';
import { ToolStatusIndicator } from '@/components/tools/ToolStatusIndicator';
import { FileViewPanel } from '@/components/FileViewPanel';
import { useChatMaxWidth } from '@/components/ChatWidthContext';
import { lmcElevation, lmcSurfaceBorder } from './elevation';
import { t } from '@/text';

const styles = StyleSheet.create((theme) => ({
    layer: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center' },
    card: {
        width: '100%',
        flex: 1,
        minHeight: 0,
        marginHorizontal: 16,
        marginBottom: 12,
        borderRadius: 20,
        backgroundColor: theme.colors.surface,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingLeft: 14,
        paddingRight: 8,
        paddingVertical: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    close: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
    body: { flex: 1, minHeight: 0 },
    missing: { padding: 24, color: theme.colors.textSecondary, fontSize: 14, ...Typography.default() },
}));

/**
 * A tool's full output, shown over the transcript instead of on a pushed
 * screen. The chat stays mounted underneath — its scroll position, streaming
 * text and composer draft all survive — and closing is a fade, not a
 * navigation transition.
 */
export const SessionToolOverlay = React.memo(({ sessionId, messageId, filePath, top, onClose }: {
    sessionId: string;
    messageId?: string;
    filePath?: string;
    top: number;
    onClose: () => void;
}) => {
    const { theme } = useUnistyles();
    const message = useMessage(sessionId, messageId ?? '');
    const chatMaxWidth = useChatMaxWidth();
    const progress = useSharedValue(0);
    React.useEffect(() => {
        progress.value = 0;
        progress.value = withTiming(1, { duration: 180, easing: Easing.out(Easing.cubic) });
    }, [messageId, filePath, progress]);
    const style = useAnimatedStyle(() => ({ opacity: progress.value, transform: [{ translateY: (1 - progress.value) * 10 }] }));

    return (
        <View style={[styles.layer, { top }]} pointerEvents="box-none">
            <Animated.View style={[styles.card, style, { maxWidth: chatMaxWidth }, lmcSurfaceBorder(theme), lmcElevation(theme, 3)]}>
                <View style={styles.header}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                        {filePath
                            ? <Text numberOfLines={1} style={{ fontSize: 15, color: theme.colors.text, ...Typography.default('semiBold') }}>{filePath.split('/').pop()}</Text>
                            : message?.kind === 'tool-call'
                            ? <ToolHeader tool={message.tool} />
                            : <Text style={{ fontSize: 15, color: theme.colors.text, ...Typography.default('semiBold') }}>详情</Text>}
                    </View>
                    {!filePath && message?.kind === 'tool-call' && <ToolStatusIndicator tool={message.tool} />}
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('lmc.common.close')}
                        onPress={onClose}
                        style={({ pressed }) => [styles.close, pressed && { backgroundColor: theme.colors.surfacePressed }]}
                    >
                        <Ionicons name="close" size={18} color={theme.colors.text} />
                    </Pressable>
                </View>
                <View style={styles.body}>
                    {filePath ? (
                        <FileViewPanel sessionId={sessionId} filePath={filePath} onHeaderRightSlotChange={() => {}} />
                    ) : !message ? (
                        <View style={{ padding: 24, alignItems: 'center' }}>
                            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                        </View>
                    ) : message.kind === 'tool-call' ? (
                        <ToolFullView tool={message.tool} messages={message.children} />
                    ) : message.kind === 'agent-text' || message.kind === 'user-text' ? (
                        <ScrollView contentContainerStyle={{ padding: 16 }}>
                            <Text style={{ fontSize: 15, lineHeight: 24, color: theme.colors.text, ...Typography.default() }}>{message.text}</Text>
                        </ScrollView>
                    ) : (
                        <Text style={styles.missing}>这条消息没有可展开的详情。</Text>
                    )}
                </View>
            </Animated.View>
        </View>
    );
});
