import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { buildTurnTimeline, type TimelineStep, type TimelineStatus } from '@/utils/turnTimeline';
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
    const renderStep = (step: TimelineStep) => (
        <TimelineRow key={step.id} step={step} compact={compact}
            selected={selected === step.id} onPress={() => open(step.id)} metadata={metadata} sessionId={sessionId} />
    );
    return (
        <View style={styles.timeline} onLayout={e => setCompact(e.nativeEvent.layout.width < 500)} testID="turn-timeline">
            {items.map((item) => {
                if (item.type === 'step') return renderStep(item);
                if (item.type === 'message') return <MessageView key={item.id} message={item.message} metadata={metadata} sessionId={sessionId} />;
                return (
                    <View key={item.id} style={styles.parallel} testID="timeline-parallel">
                        <View style={styles.parallelHeader}>
                            <Text style={styles.parallelTitle}>{t('toolGroup.timeline.parallel', { count: item.steps.length })}</Text>
                        </View>
                        {item.steps.map(step => renderStep(step))}
                    </View>
                );
            })}
        </View>
    );
});

const typeIcons: Record<ToolSummaryCategory, React.ComponentProps<typeof Ionicons>['name']> = {
    read: 'document-outline', search: 'search-outline', edit: 'create-outline',
    terminal: 'terminal-outline', web: 'globe-outline', task: 'rocket-outline', other: 'construct-outline',
};

function TimelineRow({ step, compact, selected, onPress, metadata, sessionId }: {
    step: TimelineStep; compact: boolean; selected: boolean; onPress: () => void;
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
                <View style={styles.status} testID={`timeline-status-${step.id}`}>
                    {running ? <View style={styles.spinner}><ActivityIndicator size="small" color={color} style={styles.spinnerScale} /></View>
                        : <Ionicons name={icon} size={12} color={color} />}
                </View>
                <View testID={`timeline-type-${step.id}`} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.typeIcon}>
                    <Ionicons name={typeIcon} size={12} color={theme.colors.textSecondary} />
                </View>
                <View style={[styles.body, compact && styles.mobileBody]}>
                    <Text style={styles.title} numberOfLines={1}>{title}</Text>
                    {needsExplanation && <Text style={[styles.subtitle, { color }]} numberOfLines={2}>
                        {timelineStatusLabel(step.status)}{detail ? ` · ${detail}` : ''}
                    </Text>}
                </View>
                <Ionicons name="chevron-forward" size={12} color={theme.colors.textSecondary} />
            </Pressable>
            {step.status === 'waiting' && (
                <MessageView message={step.message} metadata={metadata} sessionId={sessionId} />
            )}
        </View>
    );
}

const styles = StyleSheet.create(theme => ({
    timeline: { marginHorizontal: 16, marginTop: 8 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 4.5, minHeight: 22.5, borderRadius: 7.5 },
    mobileRow: { minHeight: 24.75 },
    highlight: { backgroundColor: theme.colors.surfacePressed },
    status: { width: 12, flexShrink: 0, alignItems: 'center', justifyContent: 'center' },
    typeIcon: { width: 12, height: 18, alignItems: 'center', justifyContent: 'center' },
    body: { flex: 1, minWidth: 0, gap: 1.5, paddingVertical: 2.25 },
    mobileBody: { paddingVertical: 3.375 },
    title: { fontSize: 12, lineHeight: 18, color: theme.colors.text, ...Typography.default('semiBold') },
    subtitle: { fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary, ...Typography.default() },
    spinner: { width: 12, height: 12, alignItems: 'center', justifyContent: 'center' },
    spinnerScale: { transform: [{ scale: 0.6 }] },
    parallel: { backgroundColor: theme.colors.surfaceHighest, borderRadius: 9, padding: 6.75, overflow: 'hidden' },
    parallelHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 18 },
    parallelTitle: { flex: 1, fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary, ...Typography.default('semiBold') },
}));
