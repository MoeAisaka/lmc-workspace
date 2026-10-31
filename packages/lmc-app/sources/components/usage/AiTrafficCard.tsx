import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { lmcColors } from '@/components/lmc/lmcColors';
import { formatTraffic, providerSum, summarizeAiTraffic, trafficSum, type AiTraffic, type AiTrafficProvider, type TrafficBytes, type TrafficPeriod } from '@/utils/lmc/aiTraffic';
import { t } from '@/text';

export type AiTrafficMachine = { id: string; name: string; traffic: AiTraffic | null };
const CLAUDE = '#D97757';

const styles = StyleSheet.create(theme => ({
    title: { color: theme.colors.text, fontSize: 15, fontWeight: '600', lineHeight: 22 },
    muted: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 19 },
    text: { color: theme.colors.text, fontSize: 14, lineHeight: 21 },
    head: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
    stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
    stat: { flexGrow: 1, borderRadius: 12, backgroundColor: lmcColors(theme).subtle, paddingHorizontal: 14, paddingVertical: 12, gap: 2, minWidth: 0 },
    statNumber: { color: theme.colors.text, fontSize: 24, lineHeight: 32, fontVariant: ['tabular-nums'] },
    label: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    group: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingTop: 10, paddingBottom: 2 },
    groupText: { color: theme.colors.text, fontSize: 13, lineHeight: 20, fontWeight: '600', flexShrink: 1 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7, flexWrap: 'wrap' },
    name: { color: theme.colors.text, fontSize: 13, lineHeight: 20, width: 82 },
    track: { flexGrow: 1, flexBasis: 80, height: 6, borderRadius: 3, backgroundColor: lmcColors(theme).subtle, overflow: 'hidden' },
    bar: { height: 6, borderRadius: 3 },
    figures: { flexDirection: 'row', alignItems: 'center', gap: 10, marginLeft: 'auto' },
    figure: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 19, fontVariant: ['tabular-nums'], minWidth: 72, textAlign: 'right' },
    total: { color: theme.colors.text, fontSize: 14, lineHeight: 21, fontVariant: ['tabular-nums'], minWidth: 64, textAlign: 'right' },
    line: { height: 1, backgroundColor: lmcColors(theme).border },
}));

const split = (t: TrafficBytes) => `↑ ${formatTraffic(t.up)} · ↓ ${formatTraffic(t.down)}`;

/** D29: what Claude, OpenAI, and Antigravity cost in network data, for sizing a metered plan. */
export function AiTrafficCard(props: { machines: AiTrafficMachine[]; period: TrafficPeriod; now: number; machineId: string; phone: boolean }) {
    const { theme } = useUnistyles();
    const summary = React.useMemo(() => summarizeAiTraffic(props.machines, props.period, props.now, props.machineId), [props.machines, props.period, props.now, props.machineId]);
    const period = props.period === 'today' ? t('lmc.usage.trafficPeriodToday') : props.period === '7days' ? t('lmc.usage.trafficPeriod7d') : t('lmc.usage.trafficPeriod30d');
    const openaiColor = theme.colors.text, antigravityColor = theme.dark ? '#4C92FF' : '#257EFB';
    const providerMeta: Record<AiTrafficProvider, { label: string; color: string }> = {
        claude: { label: 'Claude', color: CLAUDE },
        openai: { label: 'OpenAI', color: openaiColor },
        antigravity: { label: 'Antigravity', color: antigravityColor },
    };
    const total = {
        up: summary.total.claude.up + summary.total.openai.up + summary.total.antigravity.up,
        down: summary.total.claude.down + summary.total.openai.down + summary.total.antigravity.down,
    };
    const largest = Math.max(
        1,
        ...summary.machines.flatMap(m => [
            trafficSum(m.traffic.claude),
            trafficSum(m.traffic.openai),
            trafficSum(m.traffic.antigravity),
        ]),
    );
    const stat = (key: string, label: string, value: string, note: string, dot?: string) => <View testID={`ai-traffic-${key}`} style={[styles.stat, { flexBasis: props.phone ? '45%' : 170 }]}>
        <View style={styles.label}>{!!dot && <View style={[styles.dot, { backgroundColor: dot }]} />}<Text numberOfLines={1} style={styles.muted}>{label}</Text></View>
        <Text numberOfLines={1} style={styles.statNumber}>{value}</Text>
        <Text numberOfLines={1} style={styles.muted}>{note}</Text>
    </View>;
    const row = (machine: string, key: AiTrafficProvider, traffic: TrafficBytes) => {
        const { label, color } = providerMeta[key];
        return <View key={key} testID={`ai-traffic-row-${machine}-${key}`} style={styles.row}>
            <View style={[styles.dot, { backgroundColor: color }]} />
            <Text numberOfLines={1} style={styles.name}>{label}</Text>
            <View style={styles.track}><View style={[styles.bar, { backgroundColor: color, width: `${Math.max(trafficSum(traffic) > 0 ? 1 : 0, trafficSum(traffic) / largest * 100)}%` }]} /></View>
            <View style={styles.figures}><Text style={styles.figure}>↑ {formatTraffic(traffic.up)}</Text><Text style={styles.figure}>↓ {formatTraffic(traffic.down)}</Text><Text style={styles.total}>{formatTraffic(trafficSum(traffic))}</Text></View>
        </View>;
    };
    const projection = summary.projection;
    return <>
        <View style={styles.head}><Text style={styles.title}>{t('lmc.usage.trafficTitle')}</Text><Text style={[styles.muted, { flex: 1, minWidth: 160 }]}>{t('lmc.usage.trafficSubtitle')}</Text><Text style={styles.muted}>{period}</Text></View>
        {!summary.reporting ? <Text testID="ai-traffic-empty" style={styles.muted}>{t('lmc.usage.trafficEmpty')}</Text> : <>
            <View style={styles.stats}>
                {stat('total', t('lmc.usage.trafficTotalPeriod', { period }), formatTraffic(trafficSum(total)), split(total))}
                {stat('claude', `Claude · ${period}`, formatTraffic(trafficSum(summary.total.claude)), split(summary.total.claude), CLAUDE)}
                {stat('openai', `OpenAI · ${period}`, formatTraffic(trafficSum(summary.total.openai)), split(summary.total.openai), openaiColor)}
                {stat('antigravity', `Antigravity · ${period}`, formatTraffic(trafficSum(summary.total.antigravity)), split(summary.total.antigravity), antigravityColor)}
                {stat('projection', t('lmc.usage.trafficProjectionTitle'), projection ? `≈ ${formatTraffic(projection.monthlyBytes)}` : '—',
                    projection ? t('lmc.usage.trafficProjectionSub', { days: projection.days, daily: formatTraffic(projection.dailyBytes) }) : t('lmc.usage.trafficProjectionWaiting'))}
            </View>
            {summary.machines.length ? <View>{summary.machines.map((machine, index) => <View key={machine.id}>
                {index > 0 && <View style={styles.line} />}
                <View style={styles.group}><Text numberOfLines={1} style={styles.groupText}>{machine.name}</Text><Text style={[styles.groupText, { fontVariant: ['tabular-nums'] }]}>{formatTraffic(providerSum(machine.traffic))}</Text></View>
                {row(machine.id, 'claude', machine.traffic.claude)}
                {row(machine.id, 'openai', machine.traffic.openai)}
                {row(machine.id, 'antigravity', machine.traffic.antigravity)}
            </View>)}</View> : <Text style={styles.muted}>{t('lmc.usage.trafficNoneInPeriod', { period })}</Text>}
            <View style={styles.line} />
            <Text style={styles.muted}>{t('lmc.usage.trafficFootnote')}</Text>
        </>}
    </>;
}
