import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolCall } from '@/sync/typesMessage';
import { getToolTiming, validTimestamp } from '@/utils/turnTimeline';
import { useElapsedTime } from '@/hooks/useElapsedTime';
import { formatWorkDuration } from '@/hooks/useGroupedMessages';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export function ToolTimelineTiming({ tool, active = false }: { tool: ToolCall; active?: boolean }) {
    const ticking = active && tool.state === 'running';
    const elapsed = useElapsedTime(ticking ? tool.startedAt ?? tool.createdAt : null);
    const now = ticking ? Date.now() : tool.completedAt ?? tool.createdAt;
    const timing = React.useMemo(() => getToolTiming(tool, active, now), [tool, active, now, elapsed]);
    const time = (value: number | null) => validTimestamp(value) ? new Date(value).toLocaleString() : '—';
    return (
        <View style={styles.card} testID="tool-timeline-timing">
            <Text style={[styles.status, timing.status === 'error' && styles.error]}>
                {t(`toolGroup.timeline.${timing.status}`)} · {timing.durationMs === null ? t('toolGroup.timeline.unrecorded') : formatWorkDuration(timing.durationMs)}
            </Text>
            <Text style={styles.time}>{t('toolGroup.timeline.started')}  {time(timing.startedAt)}</Text>
            <Text style={styles.time}>{t('toolGroup.timeline.finished')}  {time(tool.completedAt)}</Text>
        </View>
    );
}

const styles = StyleSheet.create(theme => ({
    card: { marginBottom: 20, padding: 16, gap: 6, borderRadius: 12, backgroundColor: theme.colors.surfaceHighest },
    status: { fontSize: 14, lineHeight: 21, color: theme.colors.text, ...Typography.default('semiBold') },
    error: { color: theme.colors.textDestructive },
    time: { fontSize: 13, lineHeight: 20, color: theme.colors.textSecondary, ...Typography.default() },
}));
