import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, View } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { ProviderIcon } from '@/components/ProviderIcon';
import { lmcColors } from '@/components/lmc/lmcColors';
import { lmcElevation, lmcSurfaceBorder } from '@/components/lmc/elevation';
import { compactTokens as fmt, summarizeUsage, type UsageBucket, type UsagePeriod } from '@/sync/usageAnalytics';
import type { UsageAnalyticsState } from '@/sync/useUsageAnalytics';
import { emptyUsage, usageTotal, type UsageTokens } from 'lmc-wire';
import { UsageSessionDetails } from './UsageSessionDetails';
import { AiTrafficCard, type AiTrafficMachine } from './AiTrafficCard';
import type { UsageSessionRole } from '@/sync/usageSessionGroups';

const palette = { input: '#0060F0', output: '#DE7358', cacheWrite: '#9981CF', cacheRead: '#4D9C78' };
const categories = [['input', '新输入'], ['output', '输出'], ['cacheWrite', '缓存写入'], ['cacheRead', '缓存读取']] as const;
const styles = StyleSheet.create(theme => ({
    page: { width: '100%', maxWidth: 1380, alignSelf: 'center', padding: 24, gap: 16, flexShrink: 0 },
    text: { color: theme.colors.text, fontSize: 14, lineHeight: 21 },
    muted: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 19 },
    heading: { color: theme.colors.text, fontSize: 24, lineHeight: 32, fontWeight: '600' },
    title: { color: theme.colors.text, fontSize: 15, fontWeight: '600', lineHeight: 22 },
    number: { color: theme.colors.text, fontSize: 34, fontWeight: '600', letterSpacing: -0.8, fontVariant: ['tabular-nums'] },
    card: { borderRadius: 16, ...lmcSurfaceBorder(theme), ...lmcElevation(theme, 1), backgroundColor: theme.colors.surface, padding: 16, gap: 12, minWidth: 0, flexShrink: 0 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
    spread: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
    chip: { minHeight: 36, borderRadius: 10, paddingHorizontal: 13, paddingVertical: 7, justifyContent: 'center', backgroundColor: lmcColors(theme).subtle },
    chipActive: { backgroundColor: lmcColors(theme).brand },
    chipText: { fontSize: 12, color: theme.colors.text, fontWeight: '500' },
    chipTextActive: { color: '#FFFFFF' },
    line: { height: 1, backgroundColor: lmcColors(theme).border, flexShrink: 0 },
}));

function Choice({ label, selected, onPress }: { label: string; selected?: boolean; onPress: () => void }) {
    return <Pressable accessibilityRole="button" accessibilityState={{ selected: !!selected }} accessibilityLabel={label}
        onPress={onPress} style={({ pressed }) => [styles.chip, selected && styles.chipActive, pressed && { opacity: 0.75 }]}><Text style={[styles.chipText, selected && styles.chipTextActive]}>{label}</Text></Pressable>;
}
function Caption({ children }: { children: React.ReactNode }) { return <Text style={styles.muted}>{children}</Text>; }
function Legend() { return <View style={styles.row}>{categories.map(([key, label]) => <View key={key} style={[styles.row, { gap: 5 }]}>
    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: palette[key] }} /><Caption>{label}</Caption></View>)}</View>; }

function Trend({ buckets, daily, small = false, onSelect, selected, emptyLabel }: { buckets: UsageBucket[]; daily?: boolean; small?: boolean; emptyLabel?: string;
    onSelect?: (index: number) => void; selected?: number | null }) {
    const { theme } = useUnistyles();
    const [width, setWidth] = React.useState(800);
    const height = small ? 90 : 238, bottom = small ? 0 : 27, top = small ? 2 : 24;
    const max = Math.max(2, ...buckets.map(b => usageTotal(b.tokens)));
    const x = (i: number) => buckets.length === 1 ? width / 2 : i * width / Math.max(1, buckets.length - 1);
    const y = (n: number) => height - bottom - (height - bottom - top) * n / max;
    const sums = buckets.map(() => 0);
    if (!buckets.some(b => b.count > 0)) return <View testID={small ? 'usage-pulse-empty' : 'usage-trend-empty'} style={{ minHeight: small ? 72 : 144, width: '100%', flexShrink: 0, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
        {!small && <Ionicons name="bar-chart-outline" size={24} color={theme.colors.textSecondary} />}
        <Caption>{emptyLabel ?? (small ? '近 30 分钟暂无用量' : '所选时间段暂无用量')}</Caption>
    </View>;
    return <View onLayout={e => setWidth(Math.max(1, e.nativeEvent.layout.width))} style={{ height, flexShrink: 0, width: '100%' }} accessibilityLabel={small ? '近 30 分钟用量，每格一分钟' : 'Token 用量趋势，可选择时间段查看明细'}>
        <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" accessible={false}>
            {!small && [0, 0.5, 1].map(f => <React.Fragment key={f}>
                <Line x1={0} y1={y(max * f)} x2={width} y2={y(max * f)} stroke={lmcColors(theme).border} strokeDasharray="3 5" />
                <SvgText x={2} y={y(max * f) - 6} fill={theme.colors.textSecondary} fontSize={11}>{fmt(max * f)}</SvgText>
            </React.Fragment>)}
            {categories.map(([key]) => {
                const lower = [...sums]; buckets.forEach((b, i) => { sums[i] += b.tokens[key]; });
                // Extend the sole observation to a short interval so it remains visible.
                const upperPath = sums.map((v, i) => `${x(i)},${y(v)}`);
                const lowerPath = lower.map((v, i) => `${x(i)},${y(v)}`).reverse();
                const d = buckets.length === 1 ? `M 0 ${y(sums[0])} L ${width} ${y(sums[0])} L ${width} ${y(lower[0])} L 0 ${y(lower[0])} Z`
                    : `M ${upperPath.join(' L ')} L ${lowerPath.join(' L ')} Z`;
                return <Path key={key} d={d} fill={palette[key]} fillOpacity={small ? 0.72 : 0.58} stroke={palette[key]} strokeWidth={1.4} />;
            })}
            {!small && buckets.map((b, i) => (i === 0 || i === buckets.length - 1 || i % Math.max(1, Math.ceil(buckets.length / 5)) === 0) &&
                <SvgText key={b.at} x={x(i)} y={height - 3} fill={theme.colors.textSecondary} fontSize={11} textAnchor={i === 0 ? 'start' : i === buckets.length - 1 ? 'end' : 'middle'}>
                    {new Date(b.at).toLocaleString('zh-CN', daily ? { month: 'numeric', day: 'numeric' } : { hour: '2-digit', minute: '2-digit', hour12: false })}
                </SvgText>)}
            {selected != null && buckets[selected] && <Line x1={x(selected)} x2={x(selected)} y1={top} y2={height - bottom} stroke={theme.colors.text} strokeDasharray="4 4" />}
        </Svg>
        {onSelect && <View style={{ position: 'absolute', top: 20, left: 0, right: 0, bottom, flexDirection: 'row' }}>
            {buckets.map((b, i) => <Pressable key={b.at} style={{ flex: 1 }} accessibilityRole="button"
                accessibilityLabel={`${new Date(b.at).toLocaleString('zh-CN')}，${usageTotal(b.tokens).toLocaleString()} Token`} onPress={() => onSelect(i)} />)}
        </View>}
    </View>;
}

function Ring({ value }: { value: number | null }) {
    const { theme } = useUnistyles();
    return <Svg width={90} height={90} viewBox="0 0 90 90" accessibilityLabel={value === null ? '缓存命中率暂无数据' : `缓存命中率 ${Math.round(value * 100)}%`}>
        <Circle cx={45} cy={45} r={35} fill="none" stroke={lmcColors(theme).border} strokeWidth={7} />
        <Circle cx={45} cy={45} r={35} fill="none" stroke={palette.cacheRead} strokeWidth={7} strokeLinecap="round"
            strokeDasharray={`${(value ?? 0) * 220} 220`} rotation={-90} origin="45,45" />
    </Svg>;
}

export type UsageDashboardProps = UsageAnalyticsState & {
    period: UsagePeriod; onPeriod: (period: UsagePeriod) => void; onRefresh: () => void;
    sessionNames: Record<string, string>; machineNames: Record<string, string>;
    sessionRoles?: Record<string, UsageSessionRole>;
    onSession: (id: string) => void; quota?: React.ReactNode;
    /** Each machine's AI traffic ledger; the card is left out when the caller has none to give. */
    aiTraffic?: AiTrafficMachine[];
};
export function UsageDashboard(props: UsageDashboardProps) {
    const { theme } = useUnistyles();
    const [width, setWidth] = React.useState(1000);
    const [engine, setEngine] = React.useState('');
    const [machineId, setMachine] = React.useState('');
    const [sessionId, setSession] = React.useState('');
    const [selected, setSelected] = React.useState<number | null>(null);
    const [recordPage, setRecordPage] = React.useState(1);
    const phone = width < 640, wide = width >= 1020;
    const summary = React.useMemo(() => summarizeUsage(props.records, props.period, props.now, { engine, machineId, sessionId }), [props.records, props.period, props.now, engine, machineId, sessionId]);
    React.useEffect(() => { setSelected(null); }, [engine, machineId, sessionId, props.period]);
    React.useEffect(() => { setRecordPage(1); }, [engine, machineId, sessionId, props.period, selected]);
    const machines = [...new Set(props.records.map(r => r.machineId))];
    const sessionName = (id: string) => props.sessionNames[id] ?? `会话 ${id.slice(-8)}`;
    const total = usageTotal(summary.total);
    const ready = props.updatedAt !== null;
    const display = (n: number) => ready ? fmt(n) : '—';
    const selectedBucket = selected == null ? null : summary.buckets[selected];
    const detailRecords = selectedBucket ? summary.records.filter(r => {
        const next = summary.buckets[selected! + 1]?.at ?? props.now + 1;
        return r.occurredAt >= selectedBucket.at && r.occurredAt < next;
    }) : summary.records;
    // Only horizontal siblings share available width. A flex basis of zero in
    // a vertical scroll flow collapses cards below their content's natural height.
    const card = (horizontal = false, grow = 1) => [styles.card, horizontal ? { flexGrow: grow, flexBasis: 0 } : { width: '100%' as const }];
    const emptyChartLabel = ready ? undefined : props.loading ? '正在获取用量…' : '用量暂不可用';
    return <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surfaceHigh }} contentContainerStyle={{ flexGrow: 1 }}>
        <View testID="usage-dashboard" onLayout={e => setWidth(e.nativeEvent.layout.width)} style={[styles.page, phone && { padding: 14, gap: 14 }]}>
            <View style={styles.spread}>
                <View style={{ gap: 5 }}><Text accessibilityRole="header" style={styles.heading}>用量看板</Text><Caption>LMC 管理的 Claude 与 Codex 会话</Caption></View>
                <View style={styles.row}>{([['today', '今日'], ['7days', '7 天'], ['30days', '30 天']] as const).map(([value, label]) =>
                    <Choice key={value} label={label} selected={props.period === value} onPress={() => props.onPeriod(value)} />)}
                    <Pressable accessibilityRole="button" accessibilityLabel="刷新用量" onPress={props.onRefresh} style={styles.chip}>
                        {props.loading ? <ActivityIndicator size="small" color={theme.colors.text} /> : <Ionicons name="refresh-outline" size={17} color={theme.colors.text} />}
                    </Pressable>
                </View>
            </View>
            <View style={styles.spread}>
                <View style={styles.row}>{[['', '全部引擎'], ['claude', 'Claude'], ['codex', 'Codex']].map(([id, label]) => <Choice key={id} label={label} selected={engine === id} onPress={() => setEngine(id)} />)}</View>
                <View style={styles.row}><Choice label="全部设备" selected={!machineId} onPress={() => setMachine('')} />{machines.map(id => <Choice key={id} label={props.machineNames[id] ?? `设备 ${id.slice(-6)}`} selected={machineId === id} onPress={() => setMachine(id)} />)}</View>
            </View>
            {sessionId && <View style={styles.row}><Caption>筛选会话：{sessionName(sessionId)}</Caption><Choice label="清除会话筛选" onPress={() => setSession('')} /></View>}
            {props.error && <View accessibilityRole="alert" {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={[styles.card, { borderColor: lmcColors(theme).attention }]}><Text style={styles.text}>{props.error}{ready ? ' 以下保留上次成功获取的数据。' : ''}</Text><Choice label="重新加载" onPress={props.onRefresh} /></View>}
            {!ready && props.loading && <Caption>正在获取用量记录…</Caption>}
            {ready && !summary.count && <View {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={styles.card}><Text style={styles.title}>这个范围内还没有用量记录</Text><Caption>Agent 1.2.95 起逐条累计。会话在新版运行并产生用量后，这里会自动更新；旧版的不完整记录不计入合计。</Caption></View>}
            <View style={{ flexDirection: wide ? 'row' : 'column', gap: 14 }}>
                <View testID="usage-live-card" {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={[...card(wide, 1.12), { justifyContent: 'space-between' }]}>
                    <View style={styles.spread}><Text style={styles.title}>实时用量</Text><View style={styles.row}><View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: props.error ? lmcColors(theme).attention : lmcColors(theme).brand }} /><Caption>近 10 分钟</Caption></View></View>
                    <View style={styles.row}><Text testID="usage-rate" style={[styles.number, { fontSize: phone ? 44 : 54 }]}>{display(summary.perMinute)}</Text><Caption>Token / 分钟</Caption></View>
                    <Trend buckets={summary.pulse} small emptyLabel={emptyChartLabel} />
                    <Caption>近 30 分钟 · 每格一分钟 · 含缓存 Token</Caption>
                </View>
                <View style={[{ gap: 14, minWidth: 0, flexShrink: 0 }, wide && { flexGrow: 1.3, flexBasis: 0 }]}>
                    <View style={{ flexDirection: phone ? 'column' : 'row', gap: 14 }}>
                        <View {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={card(!phone)}><Caption>总 Token</Caption><Text testID="usage-total" style={styles.number}>{display(total)}</Text><Caption>{summary.count.toLocaleString()} 条用量记录 · {summary.sessions.length} 个会话</Caption></View>
                        <View {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={card(!phone)}><Caption>新输入 / 输出</Caption><Text style={[styles.number, { fontSize: 25 }]}>{display(summary.total.input)} / {display(summary.total.output)}</Text>
                            <View style={{ height: 5, flexDirection: 'row', overflow: 'hidden', borderRadius: 3, backgroundColor: lmcColors(theme).border }}>
                                <View style={{ flex: summary.total.input || 0.001, backgroundColor: palette.input }} /><View style={{ flex: summary.total.output || 0.001, backgroundColor: palette.output }} /></View><Caption>新输入不含缓存 · 输出包含推理</Caption></View>
                    </View>
                    <View {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={[...card(), styles.spread]}><View style={{ gap: 8 }}><Caption>缓存命中率</Caption><Text style={styles.number}>{summary.cacheRate === null || !ready ? '—' : `${(summary.cacheRate * 100).toFixed(1)}%`}</Text><Caption>读取 {display(summary.total.cacheRead)} · 写入 {display(summary.total.cacheWrite)}</Caption></View><Ring value={summary.cacheRate} /></View>
                </View>
            </View>
            <View style={{ flexDirection: phone ? 'column' : 'row', gap: 14 }}>{(['claude', 'codex'] as const).map(id => {
                const stats = summary.engines.find(e => e.id === id), tokens = stats?.tokens ?? emptyUsage();
                return <Pressable key={id} accessibilityRole="button" accessibilityState={{ selected: engine === id }} accessibilityLabel={`筛选 ${id === 'claude' ? 'Claude' : 'Codex'} 用量`} onPress={() => setEngine(engine === id ? '' : id)} {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={[...card(!phone), engine === id && { borderColor: lmcColors(theme).brand }]}>
                    <View style={styles.spread}><View style={styles.row}><ProviderIcon kind={id} size={22} /><Text style={styles.title}>{id === 'claude' ? 'Claude Code' : 'Codex'}</Text></View><Caption>{summary.sessions.filter(s => s.engines.includes(id)).length} 个会话</Caption></View>
                    <View style={styles.spread}><Text style={[styles.number, { fontSize: 29 }]}>{display(usageTotal(tokens))}</Text><Caption>{stats?.count ?? 0} 条用量记录</Caption></View>
                    <View style={{ height: 4, borderRadius: 3, backgroundColor: lmcColors(theme).border }}><View style={{ height: 4, borderRadius: 3, width: `${total ? usageTotal(tokens) / total * 100 : 0}%`, backgroundColor: id === 'claude' ? palette.output : palette.input }} /></View>
                </Pressable>;
            })}</View>
            <View style={{ flexDirection: wide ? 'row' : 'column', gap: 14, alignItems: 'stretch' }}>
                <View testID="usage-trend-card" {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={card(wide, 2.4)}><View style={styles.spread}><Text style={styles.title}>用量趋势</Text><Caption>{props.period === 'today' ? '按小时' : '按天'} · 本地时区</Caption></View><Legend />
                    <Trend buckets={summary.buckets} daily={props.period !== 'today'} selected={selected} onSelect={i => setSelected(selected === i ? null : i)} emptyLabel={emptyChartLabel} />
                    {!!summary.count && <Caption>{selectedBucket ? `${new Date(selectedBucket.at).toLocaleString('zh-CN')} · ${usageTotal(selectedBucket.tokens).toLocaleString()} Token · ${selectedBucket.count} 条记录` : '点击时间段，查看下面的用量明细。'}</Caption>}
                </View>
                <View testID="usage-model-card" {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={card(wide)}><Text style={styles.title}>模型分布</Text>{summary.models.length ? summary.models.slice(0, 5).map(m => <View key={m.id} style={{ gap: 5 }}><View style={styles.spread}><Text numberOfLines={1} style={[styles.muted, { flex: 1 }]}>{m.id}</Text><Text style={styles.text}>{fmt(usageTotal(m.tokens))}</Text></View><View style={{ height: 4, backgroundColor: lmcColors(theme).border, borderRadius: 3 }}><View style={{ height: 4, width: `${usageTotal(m.tokens) / Math.max(1, total) * 100}%`, backgroundColor: m.engines[0] === 'claude' ? palette.output : palette.input, borderRadius: 3 }} /></View></View>) : <Caption>产生用量后显示型号分布</Caption>}
                    {summary.models.length > 5 && <Caption>另有 {summary.models.length - 5} 个型号，可在用量明细查看。</Caption>}
                    <View style={styles.line} /><Caption>费用暂不估算：Token 用量不等于订阅额度，也不等于实际账单。</Caption>
                </View>
            </View>
            {props.aiTraffic && <View testID="usage-traffic-card" {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={styles.card}>
                <AiTrafficCard machines={props.aiTraffic} period={props.period} now={props.now} machineId={machineId} phone={phone} />
            </View>}
            <View style={{ flexDirection: wide ? 'row' : 'column', gap: 14, alignItems: 'flex-start' }}>
                <View testID="usage-session-card" {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={card(wide, 2.4)}>
                    <UsageSessionDetails sessions={summary.sessions} roles={props.sessionRoles} names={props.sessionNames} total={total} ready={ready}
                        scopeKey={`${props.period}:${engine}:${machineId}:${sessionId}`} onSession={props.onSession} onFilterSession={setSession} />
                </View>
                {props.quota && <View testID="usage-quota-card" {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={card(wide)}><Text style={styles.title}>账号额度 · 独立参考</Text><Caption>来自账号额度接口，可能包含 LMC 之外的使用；不参与本页用量合计，也不随本页筛选变化。</Caption>{props.quota}</View>}
            </View>
            <View testID="usage-records-card" {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={styles.card}><View style={styles.spread}><Text style={styles.title}>{selectedBucket ? '所选时间段' : '最近'}用量记录</Text><Caption>显示 {Math.min(recordPage * 10, detailRecords.length)} / {detailRecords.length} 条</Caption></View>
                {detailRecords.slice(0, recordPage * 10).map(r => <View key={`${r.sessionId}:${r.key}`} style={styles.spread}>
                    <View style={{ flex: 1, minWidth: 160 }}><Text numberOfLines={1} style={styles.text}>{sessionName(r.sessionId)}</Text><Caption>{new Date(r.occurredAt).toLocaleString('zh-CN')} · {r.engine} · {r.model ?? '型号未上报'}</Caption></View>
                    <Text style={styles.title}>{fmt(usageTotal(r.tokens))}</Text><Caption>新入 {fmt(r.tokens.input)} / 出 {fmt(r.tokens.output)} / 读 {fmt(r.tokens.cacheRead)} / 写 {fmt(r.tokens.cacheWrite)}</Caption>
                </View>)}
                {!detailRecords.length && <Caption>当前时间段没有用量记录</Caption>}
                {detailRecords.length > recordPage * 10 && <Choice label="显示更多用量记录" onPress={() => setRecordPage(p => p + 1)} />}
            </View>
            <View style={{ gap: 5, paddingBottom: 12 }}>
                <Caption>{props.collectedSince ? `已记录数据起点：${new Date(props.collectedSince).toLocaleString('zh-CN')}。` : '等待新版 Agent 的首条用量记录。'}旧版历史不完整，未计入本页；各会话从升级后开始累计。</Caption>
                <Caption>总 Token = 新输入 + 输出 + 缓存写入 + 缓存读取。记录按引擎用量更新去重，不代表请求次数。Claude 型号来自响应，Codex 型号来自该回合配置。</Caption>
                <Caption>{props.updatedAt ? `最近同步 ${new Date(props.updatedAt).toLocaleTimeString('zh-CN')} · 前台每 30 秒刷新` : '尚未完成同步'}</Caption>
            </View>
        </View>
    </ScrollView>;
}
