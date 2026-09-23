import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { buildTurnTimeline, selectTimelineItems, type TimelineStep, type TimelineStatus } from '@/utils/turnTimeline';
import { getTimelineToolLabel, getToolSummaryCategory, type ToolSummaryCategory } from '@/utils/toolDisplay';
import { formatWorkDuration, type AgentWorkGroupItem } from '@/hooks/useGroupedMessages';
import type { Metadata } from '@/sync/storageTypes';
import { openToolDetail } from './lmc/toolOverlayStore';
import { MessageView } from './MessageView';
import { t } from '@/text';

export function timelineStatusLabel(status: TimelineStatus): string {
    return t(`toolGroup.timeline.${status}`);
}

export const TurnTimeline = React.memo(function TurnTimeline({ group, metadata, sessionId, now, expanded, header }: {
    group: AgentWorkGroupItem; metadata: Metadata | null; sessionId: string; now: number; expanded: boolean; header: React.ReactNode;
}) {
    const [showEarlier, setShowEarlier] = React.useState(false);
    const [selected, setSelected] = React.useState<string | null>(null);
    const items = React.useMemo(() => buildTurnTimeline(group.messages, group.startedAt, group.completedAt === null, now), [group, now]);
    const selection = selectTimelineItems(items, expanded, group.completedAt === null, showEarlier);
    const router = useRouter();
    const open = React.useCallback((id: string) => {
        setSelected(id);
        if (!openToolDetail(id)) router.push(`/session/${sessionId}/message/${id}`);
    }, [router, sessionId]);
    const renderStep = (step: TimelineStep) => (
        <TimelineRow key={step.id} step={step}
            selected={selected === step.id} onPress={() => open(step.id)} metadata={metadata} sessionId={sessionId} />
    );
    // Progress prose stays outside process surfaces and never disappears on fold.
    // Split only at prose boundaries, preserving the original transcript order.
    const sections: React.ReactNode[] = [];
    let process: React.ReactNode[] = [header];
    let sectionKey = 'header';
    if (expanded && selection.hiddenCount > 0) process.push(
        <Pressable key="earlier" accessibilityRole="button" onPress={() => setShowEarlier(true)} style={styles.earlier}>
            <Text style={styles.earlierText}>{t('toolGroup.timeline.earlier', { count: selection.hiddenCount })}</Text>
        </Pressable>
    );
    const flush = () => {
        if (process.length) sections.push(<View key={sectionKey} style={styles.process} testID="timeline-process">{process}</View>);
        process = [];
    };
    for (const item of selection.items) {
        if (item.type === 'message') {
            flush();
            sections.push(<MessageView key={item.id} message={item.message} metadata={metadata} sessionId={sessionId} />);
            continue;
        }
        if (!process.length) sectionKey = item.id;
        if (item.type === 'step') process.push(renderStep(item));
        else process.push(
            <View key={item.id} style={styles.parallel} testID="timeline-parallel">
                <Text style={styles.parallelTitle}>{t('toolGroup.timeline.parallel', { count: item.steps.length })}</Text>
                {item.steps.map(renderStep)}
            </View>
        );
    }
    flush();
    return <View testID="turn-timeline">{sections}</View>;

});

const typeIcons: Record<ToolSummaryCategory, React.ComponentProps<typeof Ionicons>['name']> = {
    read: 'document-outline', search: 'search-outline', edit: 'create-outline',
    terminal: 'terminal-outline', web: 'globe-outline', task: 'rocket-outline', other: 'construct-outline',
};

function TimelineRow({ step, selected, onPress, metadata, sessionId }: {
    step: TimelineStep; selected: boolean; onPress: () => void;
    metadata: Metadata | null; sessionId: string;
}) {
    const { theme } = useUnistyles();
    const { tool } = step.message;
    const running = step.status === 'running';
    const needsExplanation = step.status !== 'completed' && !running;
    const title = getTimelineToolLabel(tool);
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
                style={({ pressed }) => [styles.row, (running || selected || pressed) && styles.highlight]}
                testID={`timeline-step-${step.id}`}>
                <View style={[styles.status, step.status === 'completed' && styles.subdued]} testID={`timeline-status-${step.id}`}>
                    {running ? <View style={styles.spinner}><ActivityIndicator size="small" color={color} style={styles.spinnerScale} /></View>
                        : <Ionicons name={icon} size={14} color={color} />}
                </View>
                <View testID={`timeline-type-${step.id}`} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.typeIcon}>
                    <Ionicons name={typeIcon} size={14} color={theme.colors.textSecondary} />
                </View>
                <View style={styles.body}>
                    <Text style={styles.title} numberOfLines={1}>{title}</Text>
                    {needsExplanation && <Text style={[styles.subtitle, { color }]} numberOfLines={2}>
                        {timelineStatusLabel(step.status)}
                    </Text>}
                </View>
                <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} style={styles.subdued} />
            </Pressable>
            {step.status === 'waiting' && (
                <MessageView message={step.message} metadata={metadata} sessionId={sessionId} />
            )}
        </View>
    );
}

const styles = StyleSheet.create(theme => ({
    process: { marginHorizontal: 16, marginVertical: 4, paddingHorizontal: 14, paddingVertical: 10, gap: 4, borderRadius: 10, backgroundColor: theme.colors.processSurface },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 34, borderRadius: 6, paddingHorizontal: 8 },
    highlight: { backgroundColor: theme.colors.surfacePressed },
    subdued: { opacity: 0.45 },
    status: { width: 14, flexShrink: 0, alignItems: 'center', justifyContent: 'center' },
    typeIcon: { width: 14, height: 22, alignItems: 'center', justifyContent: 'center' },
    body: { flex: 1, minWidth: 0, gap: 2, paddingVertical: 5 },
    title: { fontSize: 14, lineHeight: 22, color: theme.colors.textSecondary, ...Typography.default() },
    subtitle: { fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary, ...Typography.default() },
    spinner: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
    spinnerScale: { transform: [{ scale: 0.7 }] },
    parallel: {
        marginVertical: 2, paddingHorizontal: 10, paddingVertical: 8, gap: 4,
        borderRadius: 8, borderWidth: 1,
        borderColor: theme.colors.processGroupBorder,
        backgroundColor: theme.colors.processSurface,
    },
    parallelTitle: { paddingHorizontal: 8, fontSize: 12, lineHeight: 20, color: theme.colors.textSecondary, ...Typography.default() },
    earlier: { minHeight: 28, justifyContent: 'center', marginBottom: 4 },
    earlierText: { fontSize: 12, lineHeight: 20, color: theme.colors.textSecondary, ...Typography.default() },
}));
