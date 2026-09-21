import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { buildTurnTimeline, formatTimelineOffset, type TimelineStep, type TimelineStatus } from '@/utils/turnTimeline';
import { getToolActivityLabel, getToolSummaryCategory, getToolSummaryDetail, type ToolSummaryCategory } from '@/utils/toolDisplay';
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
    const renderStep = (step: TimelineStep, parallel = false, first = true, last = true) => (
        <TimelineRow key={step.id} step={step} compact={compact} parallel={parallel} first={first} last={last}
            selected={selected === step.id} onPress={() => open(step.id)} metadata={metadata} sessionId={sessionId} />
    );
    return (
        <View style={styles.timeline} onLayout={e => setCompact(e.nativeEvent.layout.width < 500)} testID="turn-timeline">
            {items.map((item, index) => {
                const previous = items[index - 1];
                if (item.type === 'step') return renderStep(item, false,
                    previous?.type !== 'step' || previous.status === 'waiting',
                    items[index + 1]?.type !== 'step' || item.status === 'waiting');
                if (item.type === 'message') return <MessageView key={item.id} message={item.message} metadata={metadata} sessionId={sessionId} />;
                return (
                    <View key={item.id} style={styles.parallel} testID="timeline-parallel">
                        <View style={styles.parallelHeader}>
                            <Text style={styles.parallelTitle}>{!compact && `${formatTimelineOffset(item.offsetMs)}   `}{t('toolGroup.timeline.parallel', { count: item.steps.length })}</Text>
                            <Text style={styles.duration}>{t('toolGroup.timeline.total', { duration: formatWorkDuration(item.durationMs) })}</Text>
                        </View>
                        {item.steps.map((step, index) => renderStep(step, true, index === 0, index === item.steps.length - 1))}
                    </View>
                );
            })}
            {group.completedAt !== null && <Text style={styles.end}>{t('toolGroup.timeline.ended')}</Text>}
        </View>
    );
});

const typeIcons: Record<ToolSummaryCategory, React.ComponentProps<typeof Ionicons>['name']> = {
    read: 'document-outline', search: 'search-outline', edit: 'create-outline',
    terminal: 'terminal-outline', web: 'globe-outline', task: 'rocket-outline', other: 'construct-outline',
};

function TimelineRow({ step, compact, parallel, first, last, selected, onPress, metadata, sessionId }: {
    step: TimelineStep; compact: boolean; parallel: boolean; first: boolean; last: boolean; selected: boolean; onPress: () => void;
    metadata: Metadata | null; sessionId: string;
}) {
    const { theme } = useUnistyles();
    const { tool } = step.message;
    const running = step.status === 'running';
    const needsExplanation = step.status !== 'completed' && !running;
    const title = getToolActivityLabel(tool);
    const rawDetail = getToolSummaryDetail(tool);
    const detail = rawDetail === title ? null : rawDetail;
    const duration = step.durationMs === null ? t('toolGroup.timeline.unrecorded') : formatWorkDuration(step.durationMs);
    const color = step.status === 'error' ? theme.colors.textDestructive
        : running || step.status === 'waiting' ? theme.colors.textLink : theme.colors.textSecondary;
    const typeIcon = typeIcons[tool.name === 'WebSearch' ? 'web' : getToolSummaryCategory(tool.name)];
    const icon = step.status === 'completed' ? 'checkmark' : step.status === 'error' ? 'close-circle-outline'
        : step.status === 'waiting' ? 'time-outline' : step.status === 'stopped' ? 'stop-circle-outline' : 'help-circle-outline';
    return (
        <View>
            <Pressable onPress={onPress} accessibilityRole="button"
                accessibilityLabel={`${title}, ${timelineStatusLabel(step.status)}, ${duration}`}
                style={({ pressed }) => [styles.row, compact && styles.mobileRow, (running || selected || pressed) && styles.highlight]}
                testID={`timeline-step-${step.id}`}>
                {!compact && <Text style={styles.offset}>{!parallel && step.offsetMs !== null ? formatTimelineOffset(step.offsetMs) : ''}</Text>}
                <View style={styles.rail}>
                    {!first && <View style={[styles.connector, styles.connectorBefore]} />}
                    {!last && <View style={[styles.connector, styles.connectorAfter]} />}
                    <View testID={`timeline-type-${step.id}`} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
                        style={[styles.typeIcon, { backgroundColor: running || selected ? theme.colors.surfacePressed : parallel ? theme.colors.surfaceHighest : theme.colors.surface }]}>
                        <Ionicons name={typeIcon} size={16} color={theme.colors.text} />
                    </View>
                </View>
                <View style={[styles.body, compact && styles.mobileBody]}>
                    <Text style={styles.title} numberOfLines={1}>{title}</Text>
                    {needsExplanation && <Text style={[styles.subtitle, { color }]} numberOfLines={2}>
                        {timelineStatusLabel(step.status)}{detail ? ` · ${detail}` : ''}
                    </Text>}
                </View>
                <View style={styles.timing} testID={`timeline-status-${step.id}`}>
                    {running ? <View style={styles.spinner}><ActivityIndicator size="small" color={color} style={styles.spinnerScale} /></View>
                        : <Ionicons name={icon} size={14} color={color} />}
                    <Text style={[styles.duration, running && { color }]} numberOfLines={1}>
                        {running ? `${timelineStatusLabel(step.status)} · ` : ''}{duration}
                    </Text>
                </View>
                <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
            </Pressable>
            {step.status === 'waiting' && (
                <MessageView message={step.message} metadata={metadata} sessionId={sessionId} />
            )}
        </View>
    );
}

const styles = StyleSheet.create(theme => ({
    timeline: { marginHorizontal: 16, marginTop: 8 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 40, borderRadius: 10 },
    mobileRow: { minHeight: 44 },
    highlight: { backgroundColor: theme.colors.surfacePressed },
    offset: { width: 44, fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() },
    rail: { width: 18, flexShrink: 0, alignSelf: 'stretch', justifyContent: 'center', alignItems: 'center' },
    connector: { position: 'absolute', width: 1, backgroundColor: theme.colors.divider },
    connectorBefore: { top: 0, bottom: '50%' },
    connectorAfter: { top: '50%', bottom: 0 },
    typeIcon: { width: 18, height: 22, alignItems: 'center', justifyContent: 'center' },
    body: { flex: 1, minWidth: 0, gap: 2, paddingVertical: 9 },
    mobileBody: { paddingVertical: 11 },
    title: { fontSize: 14, lineHeight: 22, color: theme.colors.text, ...Typography.default('semiBold') },
    subtitle: { fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary, ...Typography.default() },
    timing: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 },
    spinner: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
    spinnerScale: { transform: [{ scale: 0.7 }] },
    duration: { fontSize: 12, lineHeight: 20, color: theme.colors.textSecondary, flexShrink: 0, textAlign: 'right', ...Typography.default() },
    parallel: { backgroundColor: theme.colors.surfaceHighest, borderRadius: 12, padding: 12, overflow: 'hidden' },
    parallelHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 22 },
    parallelTitle: { flex: 1, fontSize: 14, color: theme.colors.textSecondary, ...Typography.default('semiBold') },
    end: { fontSize: 12, lineHeight: 20, color: theme.colors.textSecondary, paddingVertical: 4, ...Typography.default() },
}));
