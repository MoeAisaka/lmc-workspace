import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { buildTurnTimeline, formatTimelineOffset, type TimelineStep, type TimelineStatus } from '@/utils/turnTimeline';
import { getToolActivityLabel, getToolSummaryDetail } from '@/utils/toolDisplay';
import { formatWorkDuration, type AgentWorkGroupItem } from '@/hooks/useGroupedMessages';
import type { Metadata } from '@/sync/storageTypes';
import { openToolDetail } from './lmc/toolOverlayStore';
import { MessageView } from './MessageView';
import { t } from '@/text';

export function timelineStatusLabel(status: TimelineStatus): string {
    return t(`toolGroup.timeline.${status}`);
}

export const TurnTimeline = React.memo(function TurnTimeline({ group, metadata, sessionId, now }: {
    group: AgentWorkGroupItem; metadata: Metadata | null; sessionId: string; now: number;
}) {
    const [compact, setCompact] = React.useState(true);
    const [selected, setSelected] = React.useState<string | null>(null);
    const items = React.useMemo(() => buildTurnTimeline(group.messages, group.startedAt, group.completedAt === null, now), [group, now]);
    const router = useRouter();
    const open = React.useCallback((id: string) => {
        setSelected(id);
        if (!openToolDetail(id)) router.push(`/session/${sessionId}/message/${id}`);
    }, [router, sessionId]);
    const renderStep = (step: TimelineStep, parallel = false, last = false) => (
        <TimelineRow key={step.id} step={step} compact={compact} parallel={parallel} last={last}
            selected={selected === step.id} onPress={() => open(step.id)} metadata={metadata} sessionId={sessionId} />
    );
    return (
        <View style={styles.timeline} onLayout={e => setCompact(e.nativeEvent.layout.width < 500)} testID="turn-timeline">
            {items.map((item, index) => {
                if (item.type === 'step') return renderStep(item, false, index === items.length - 1);
                if (item.type === 'message') return <MessageView key={item.id} message={item.message} metadata={metadata} sessionId={sessionId} />;
                return (
                    <View key={item.id} style={styles.parallel} testID="timeline-parallel">
                        <View style={styles.parallelHeader}>
                            <Text style={styles.parallelTitle}>{!compact && `${formatTimelineOffset(item.offsetMs)}   `}{t('toolGroup.timeline.parallel', { count: item.steps.length })}</Text>
                            <Text style={styles.duration}>{t('toolGroup.timeline.total', { duration: formatWorkDuration(item.durationMs) })}</Text>
                        </View>
                        {item.steps.map((step, index) => renderStep(step, true, index === item.steps.length - 1))}
                    </View>
                );
            })}
            {group.completedAt !== null && <Text style={styles.end}>{t('toolGroup.timeline.ended')}</Text>}
        </View>
    );
});

function TimelineRow({ step, compact, parallel, last, selected, onPress, metadata, sessionId }: {
    step: TimelineStep; compact: boolean; parallel: boolean; last: boolean; selected: boolean; onPress: () => void;
    metadata: Metadata | null; sessionId: string;
}) {
    const { theme } = useUnistyles();
    const { tool } = step.message;
    const running = step.status === 'running';
    const title = tool.description?.trim() || getToolActivityLabel({ ...tool, input: {}, description: null });
    const rawDetail = getToolSummaryDetail(tool);
    const detail = rawDetail === title ? null : rawDetail;
    const duration = step.durationMs === null ? t('toolGroup.timeline.unrecorded') : formatWorkDuration(step.durationMs);
    const color = step.status === 'error' ? theme.colors.textDestructive
        : step.status === 'completed' ? theme.colors.diff.success
            : running || step.status === 'waiting' ? theme.colors.textLink : theme.colors.textSecondary;
    const icon = step.status === 'completed' ? 'checkmark' : step.status === 'error' ? 'close-circle-outline'
        : step.status === 'waiting' ? 'time-outline' : step.status === 'stopped' ? 'stop-circle-outline' : 'help-circle-outline';
    return (
        <View>
            <Pressable onPress={onPress} accessibilityRole="button"
                accessibilityLabel={`${title}, ${timelineStatusLabel(step.status)}, ${duration}`}
                style={({ pressed }) => [styles.row, (running || selected || pressed) && styles.highlight]}
                testID={`timeline-step-${step.id}`}>
                {!compact && <Text style={styles.offset}>{!parallel && step.offsetMs !== null ? formatTimelineOffset(step.offsetMs) : ''}</Text>}
                <View style={styles.rail}>
                    {!last && <View style={styles.connector} />}
                    <View style={[styles.statusIcon, { backgroundColor: running || selected ? theme.colors.surfacePressed : parallel ? theme.colors.surfaceHighest : theme.colors.surface }]}>
                        {running ? <ActivityIndicator size="small" color={color} /> : <Ionicons name={icon} size={18} color={color} />}
                    </View>
                </View>
                <View style={styles.body}>
                    <Text style={styles.title} numberOfLines={2}>{title}</Text>
                    <Text style={[styles.subtitle, step.status === 'error' && { color }]} numberOfLines={2}>
                        {step.status !== 'completed' ? `${timelineStatusLabel(step.status)}${detail ? ' · ' : ''}` : ''}{detail || (step.status === 'completed' ? timelineStatusLabel(step.status) : '')}
                    </Text>
                </View>
                <Text style={styles.duration}>{duration}</Text>
                <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />
            </Pressable>
            {step.status === 'waiting' && (
                <MessageView message={step.message} metadata={metadata} sessionId={sessionId} />
            )}
        </View>
    );
}

const styles = StyleSheet.create(theme => ({
    timeline: { marginHorizontal: 16, marginTop: 8, gap: 4 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 68, paddingVertical: 12, borderRadius: 10 },
    highlight: { backgroundColor: theme.colors.surfacePressed },
    offset: { width: 44, fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() },
    rail: { width: 18, alignSelf: 'stretch', justifyContent: 'center', alignItems: 'center' },
    connector: { position: 'absolute', width: 1, top: '50%', bottom: -48, backgroundColor: theme.colors.divider },
    statusIcon: { width: 18, height: 22, alignItems: 'center', justifyContent: 'center' },
    body: { flex: 1, minWidth: 0, gap: 2 },
    title: { fontSize: 15, lineHeight: 23, color: theme.colors.text, ...Typography.default('semiBold') },
    subtitle: { fontSize: 13, lineHeight: 20, color: theme.colors.textSecondary, ...Typography.default() },
    duration: { fontSize: 13, color: theme.colors.textSecondary, maxWidth: 82, textAlign: 'right', ...Typography.default() },
    parallel: { backgroundColor: theme.colors.surfaceHighest, borderRadius: 12, padding: 12, overflow: 'hidden' },
    parallelHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 28 },
    parallelTitle: { flex: 1, fontSize: 14, color: theme.colors.textSecondary, ...Typography.default('semiBold') },
    end: { fontSize: 12, lineHeight: 20, color: theme.colors.textSecondary, paddingVertical: 8, ...Typography.default() },
}));
