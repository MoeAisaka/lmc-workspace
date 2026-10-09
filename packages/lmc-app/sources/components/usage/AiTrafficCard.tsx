import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { lmcColors } from '@/components/lmc/lmcColors';
import type { UsagePeriod } from '@/sync/usageAnalytics';
import { formatTraffic, providerSum, summarizeAiTraffic, trafficSum, type AiTraffic, type TrafficBytes } from '@/utils/lmc/aiTraffic';

export type AiTrafficMachine = { id: string; name: string; traffic: AiTraffic | null };
const CLAUDE = '#D97757';
const periodLabel: Record<UsagePeriod, string> = { today: '今日', '7days': '近 7 天', '30days': '近 30 天' };

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
    name: { color: theme.colors.text, fontSize: 13, lineHeight: 20, width: 58 },
    track: { flexGrow: 1, flexBasis: 80, height: 6, borderRadius: 3, backgroundColor: lmcColors(theme).subtle, overflow: 'hidden' },
    bar: { height: 6, borderRadius: 3 },
    figures: { flexDirection: 'row', alignItems: 'center', gap: 10, marginLeft: 'auto' },
    figure: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 19, fontVariant: ['tabular-nums'], minWidth: 72, textAlign: 'right' },
    total: { color: theme.colors.text, fontSize: 14, lineHeight: 21, fontVariant: ['tabular-nums'], minWidth: 64, textAlign: 'right' },
    line: { height: 1, backgroundColor: lmcColors(theme).border },
}));

const split = (t: TrafficBytes) => `↑ ${formatTraffic(t.up)} · ↓ ${formatTraffic(t.down)}`;

/** D29: what OpenAI and Claude cost in network data, for sizing a metered plan. */
export function AiTrafficCard(props: { machines: AiTrafficMachine[]; period: UsagePeriod; now: number; machineId: string; phone: boolean }) {
    const { theme } = useUnistyles();
    const summary = React.useMemo(() => summarizeAiTraffic(props.machines, props.period, props.now, props.machineId), [props.machines, props.period, props.now, props.machineId]);
    const period = periodLabel[props.period], openaiColor = theme.colors.text;
    const total = { up: summary.total.claude.up + summary.total.openai.up, down: summary.total.claude.down + summary.total.openai.down };
    const largest = Math.max(1, ...summary.machines.flatMap(m => [trafficSum(m.traffic.claude), trafficSum(m.traffic.openai)]));
    const stat = (key: string, label: string, value: string, note: string, dot?: string) => <View testID={`ai-traffic-${key}`} style={[styles.stat, { flexBasis: props.phone ? '45%' : 0 }]}>
        <View style={styles.label}>{!!dot && <View style={[styles.dot, { backgroundColor: dot }]} />}<Text numberOfLines={1} style={styles.muted}>{label}</Text></View>
        <Text numberOfLines={1} style={styles.statNumber}>{value}</Text>
        <Text numberOfLines={1} style={styles.muted}>{note}</Text>
    </View>;
    const row = (machine: string, key: 'claude' | 'openai', traffic: TrafficBytes) => <View key={key} testID={`ai-traffic-row-${machine}-${key}`} style={styles.row}>
        <View style={[styles.dot, { backgroundColor: key === 'claude' ? CLAUDE : openaiColor }]} />
        <Text style={styles.name}>{key === 'claude' ? 'Claude' : 'OpenAI'}</Text>
        <View style={styles.track}><View style={[styles.bar, { backgroundColor: key === 'claude' ? CLAUDE : openaiColor, width: `${Math.max(trafficSum(traffic) > 0 ? 1 : 0, trafficSum(traffic) / largest * 100)}%` }]} /></View>
        <View style={styles.figures}><Text style={styles.figure}>↑ {formatTraffic(traffic.up)}</Text><Text style={styles.figure}>↓ {formatTraffic(traffic.down)}</Text><Text style={styles.total}>{formatTraffic(trafficSum(traffic))}</Text></View>
    </View>;
    const projection = summary.projection;
    return <>
        <View style={styles.head}><Text style={styles.title}>AI 流量</Text><Text style={[styles.muted, { flex: 1, minWidth: 160 }]}>OpenAI 与 Claude 的网络数据量 · ↑ 上行 ↓ 下行</Text><Text style={styles.muted}>{period}</Text></View>
        {!summary.reporting ? <Text testID="ai-traffic-empty" style={styles.muted}>还没有流量数据。各机器的 Agent 升级后开始记录。</Text> : <>
            <View style={styles.stats}>
                {stat('total', `合计 · ${period}`, formatTraffic(trafficSum(total)), split(total))}
                {stat('claude', `Claude · ${period}`, formatTraffic(trafficSum(summary.total.claude)), split(summary.total.claude), CLAUDE)}
                {stat('openai', `OpenAI · ${period}`, formatTraffic(trafficSum(summary.total.openai)), split(summary.total.openai), openaiColor)}
                {stat('projection', '按近 7 天推算的月用量', projection ? `≈ ${formatTraffic(projection.monthlyBytes)}` : '—',
                    projection ? `${projection.days < 6 ? `仅 ${projection.days} 天数据 · ` : ''}日均 ${formatTraffic(projection.dailyBytes)} × 30` : '满一整天后开始推算')}
            </View>
            {summary.machines.length ? <View>{summary.machines.map((machine, index) => <View key={machine.id}>
                {index > 0 && <View style={styles.line} />}
                <View style={styles.group}><Text numberOfLines={1} style={styles.groupText}>{machine.name}</Text><Text style={[styles.groupText, { fontVariant: ['tabular-nums'] }]}>{formatTraffic(providerSum(machine.traffic))}</Text></View>
                {row(machine.id, 'claude', machine.traffic.claude)}
                {row(machine.id, 'openai', machine.traffic.openai)}
            </View>)}</View> : <Text style={styles.muted}>{period}没有记录到流量。</Text>}
            <View style={styles.line} />
            <Text style={styles.muted}>应用层发出的数据量；实际占用的 SIM 流量还要加上加密与代理协议的开销。Windows 上其他程序访问这两家域名也会计入。</Text>
        </>}
    </>;
}
