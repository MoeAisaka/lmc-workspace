import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { QueueMode, QueuedPrompt, SteerState } from '@/sync/turnQueue';
import { lmcColors } from './lmcColors';

/**
 * The prompts waiting for the engine, above the composer. Figma D16.
 *
 * Sending is only ever queueing — one action, decided before the message is
 * written. What to do with it afterwards is decided here, on the message
 * itself: 引导 hands it to the running turn without stopping it, 插入 stops
 * that turn so this one goes next, 撤回 takes it back. Every button is on the
 * row at every width: hover only tints the row, because a finger cannot hover
 * and a phone browser eats long-presses.
 *
 * The strip exists only while something is waiting — no empty shell, no count.
 * The rows are the count.
 */
export interface QueueStripProps {
    items: QueuedPrompt[];
    mode: QueueMode;
    /** Dimmed on engines that cannot steer; pressing it still says why. */
    steerState: SteerState;
    onSteer: (key: string) => void;
    onPromote: (key: string) => void;
    onWithdraw: (key: string) => void;
    onModeChange: (mode: QueueMode) => void;
}

export const QueueStrip = React.memo(function QueueStrip(props: QueueStripProps) {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    if (props.items.length === 0) return null;
    const toggleMode = () => props.onModeChange(props.mode === 'batch' ? 'sequential' : 'batch');

    return (
        <View style={styles.strip} {...({ dataSet: { lmcQueueStrip: 'true' } } as any)}>
            {props.items.map((item) => (
                <View key={item.key} style={styles.row}>
                    <Ionicons name="time-outline" size={14} color={colors.placeholder} />
                    <Text numberOfLines={1} style={styles.preview}>{item.preview}</Text>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('lmc.queue.steer')}
                        accessibilityHint={props.steerState === 'disabled' ? t('lmc.queue.steerUnavailable') : undefined}
                        onPress={() => props.onSteer(item.key)}
                        hitSlop={4}
                        style={(p) => [styles.action, { opacity: props.steerState === 'disabled' ? 0.38 : p.pressed ? 0.6 : 1 }]}
                    >
                        <Text style={styles.actionText}>{t('lmc.queue.steer')}</Text>
                    </Pressable>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('lmc.queue.promote')}
                        onPress={() => props.onPromote(item.key)}
                        hitSlop={4}
                        style={(p) => [styles.action, { opacity: p.pressed ? 0.6 : 1 }]}
                    >
                        <Text style={styles.actionText}>{t('lmc.queue.promote')}</Text>
                    </Pressable>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('lmc.queue.withdraw')}
                        onPress={() => props.onWithdraw(item.key)}
                        hitSlop={4}
                        style={(p) => [styles.withdraw, { opacity: p.pressed ? 0.6 : 1 }]}
                    >
                        <Ionicons name="close" size={15} color={colors.tertiary} />
                    </Pressable>
                </View>
            ))}
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('lmc.queue.modeSwitch')}
                onPress={toggleMode}
                hitSlop={4}
                style={(p) => [styles.footer, { opacity: p.pressed ? 0.6 : 1 }]}
            >
                <Text style={styles.modeText}>{props.mode === 'batch' ? t('lmc.queue.modeBatch') : t('lmc.queue.modeSequential')}</Text>
                <Ionicons name="chevron-down" size={12} color={colors.tertiary} />
            </Pressable>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    strip: {
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.dark ? 'rgba(255,255,255,0.12)' : '#E5E5E5',
        paddingTop: 6,
        paddingBottom: 4,
        paddingHorizontal: 6,
        marginBottom: 8,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingLeft: 10,
        paddingRight: 4,
        paddingVertical: 4,
        borderRadius: 10,
    },
    preview: {
        flex: 1,
        minWidth: 0,
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text,
        ...Typography.default(),
    },
    action: {
        paddingHorizontal: 9,
        paddingVertical: 4,
        borderRadius: 999,
        backgroundColor: theme.dark ? 'rgba(255,255,255,0.08)' : '#F0F0F0',
    },
    actionText: {
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    withdraw: {
        width: 26,
        height: 26,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: 4,
        paddingLeft: 10,
        paddingRight: 6,
        paddingVertical: 4,
    },
    modeText: {
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
}));
