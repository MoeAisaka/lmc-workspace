import { QuotaEfficiencyCard } from './QuotaEfficiencyCard';
import * as React from 'react';
import { ActivityIndicator, Platform, ScrollView, View } from 'react-native';
import { InteractionPressable as Pressable } from '@/components/InteractionPressable';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { ProviderIcon } from '@/components/ProviderIcon';
import { lmcColors } from '@/components/lmc/lmcColors';
import { lmcElevation, lmcSurfaceBorder } from '@/components/lmc/elevation';
import { compactTokens as fmt, fiveHourUsageRange, summarizeUsage, type UsageBucket, type UsagePeriod } from '@/sync/usageAnalytics';
import type { UsageAnalyticsState } from '@/sync/useUsageAnalytics';
import { emptyUsage, usageTotal, type AccountQuotaSnapshot } from 'lmc-wire';
import { UsageSessionDetails } from './UsageSessionDetails';
import { AiTrafficCard, type AiTrafficMachine } from './AiTrafficCard';
import { UsageCalendar } from './UsageCalendar';
import type { UsageSessionRole } from '@/sync/usageSessionGroups';
import { getDateLocale, t } from '@/text';

const palette = { input: '#0060F0', output: '#DE7358', cacheWrite: '#9981CF', cacheRead: '#4D9C78' };
const categoryKeys = ['input', 'output', 'cacheWrite', 'cacheRead'] as const;
const getCategories = () => [
    ['input', t('lmc.usage.catInput')],
    ['output', t('lmc.usage.catOutput')],
    ['cacheWrite', t('lmc.usage.catCacheWrite')],
    ['cacheRead', t('lmc.usage.catCacheRead')],
] as const;
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
function Legend() { return <View style={styles.row}>{getCategories().map(([key, label]) => <View key={key} style={[styles.row, { gap: 5 }]}>
    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: palette[key] }} /><Caption>{label}</Caption></View>)}</View>; }

function Trend({ buckets, daily, small = false, onSelect, selected, emptyLabel }: { buckets: UsageBucket[]; daily?: boolean; small?: boolean; emptyLabel?: string;
    onSelect?: (index: number) => void; selected?: number | null }) {
    const { theme } = useUnistyles();
    const locale = getDateLocale();
    const [width, setWidth] = React.useState(800);
    const height = small ? 90 : 238, bottom = small ? 0 : 27, top = small ? 2 : 24;
    const max = Math.max(2, ...buckets.map(b => usageTotal(b.tokens)));
    const x = (i: number) => buckets.length === 1 ? width / 2 : i * width / Math.max(1, buckets.length - 1);
    const y = (n: number) => height - bottom - (height - bottom - top) * n / max;
    const sums = buckets.map(() => 0);
    const labelCount = Math.min(buckets.length, Math.max(2, Math.min(6, Math.floor(width / 72))));
    const labelIndexes = new Set(Array.from({ length: labelCount }, (_, i) => Math.round(i * (buckets.length - 1) / Math.max(1, labelCount - 1))));
    if (!buckets.some(b => b.count > 0)) return <View testID={small ? 'usage-pulse-empty' : 'usage-trend-empty'} style={{ minHeight: small ? 72 : 144, width: '100%', flexShrink: 0, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
        {!small && <Ionicons name="bar-chart-outline" size={24} color={theme.colors.textSecondary} />}
        <Caption>{emptyLabel ?? (small ? t('lmc.usage.empty30m') : t('lmc.usage.emptySelectedRange'))}</Caption>
    </View>;
    return <View onLayout={e => setWidth(Math.max(1, e.nativeEvent.layout.width))} style={{ height, flexShrink: 0, width: '100%' }} accessibilityLabel={small ? t('lmc.usage.chart30mA11y') : t('lmc.usage.chartTrendA11y')}>
        <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" accessible={false}>
            {!small && [0, 0.5, 1].map(f => <React.Fragment key={f}>
                <Line x1={0} y1={y(max * f)} x2={width} y2={y(max * f)} stroke={lmcColors(theme).border} strokeDasharray="3 5" />
                <SvgText x={2} y={y(max * f) - 6} fill={theme.colors.textSecondary} fontSize={11}>{fmt(max * f)}</SvgText>
            </React.Fragment>)}
            {categoryKeys.map((key) => {
                const lower = [...sums]; buckets.forEach((b, i) => { sums[i] += b.tokens[key]; });
                // Extend the sole observation to a short interval so it remains visible.
                const upperPath = sums.map((v, i) => `${x(i)},${y(v)}`);
                const lowerPath = lower.map((v, i) => `${x(i)},${y(v)}`).reverse();
                const d = buckets.length === 1 ? `M 0 ${y(sums[0])} L ${width} ${y(sums[0])} L ${width} ${y(lower[0])} L 0 ${y(lower[0])} Z`
                    : `M ${upperPath.join(' L ')} L ${lowerPath.join(' L ')} Z`;
                return <Path key={key} d={d} fill={palette[key]} fillOpacity={small ? 0.72 : 0.58} stroke={palette[key]} strokeWidth={1.4} />;
            })}
            {!small && buckets.map((b, i) => labelIndexes.has(i) &&
                <SvgText key={b.at} x={x(i)} y={height - 3} fill={theme.colors.textSecondary} fontSize={11} textAnchor={i === 0 ? 'start' : i === buckets.length - 1 ? 'end' : 'middle'}>
                    {new Date(b.at).toLocaleString(locale, daily ? { month: 'numeric', day: 'numeric' } : { hour: '2-digit', minute: '2-digit', hour12: false })}
                </SvgText>)}
            {selected != null && buckets[selected] && <Line x1={x(selected)} x2={x(selected)} y1={top} y2={height - bottom} stroke={theme.colors.text} strokeDasharray="4 4" />}
        </Svg>
        {onSelect && <View style={{ position: 'absolute', top: 20, left: 0, right: 0, bottom, flexDirection: 'row' }}>
            {buckets.map((b, i) => <Pressable key={b.at} style={{ flex: 1 }} accessibilityRole="button"
                accessibilityLabel={t('lmc.usage.bucketA11y', { time: new Date(b.at).toLocaleString(locale), tokens: usageTotal(b.tokens).toLocaleString() })} onPress={() => onSelect(i)} />)}
        </View>}
    </View>;
}

function Ring({ value }: { value: number | null }) {
    const { theme } = useUnistyles();
    return <Svg width={90} height={90} viewBox="0 0 90 90" accessibilityLabel={value === null ? t('lmc.usage.cacheRingEmptyA11y') : t('lmc.usage.cacheRingValueA11y', { pct: Math.round(value * 100) })}>
        <Circle cx={45} cy={45} r={35} fill="none" stroke={lmcColors(theme).border} strokeWidth={7} />
        <Circle cx={45} cy={45} r={35} fill="none" stroke={palette.cacheRead} strokeWidth={7} strokeLinecap="round"
            strokeDasharray={`${(value ?? 0) * 220} 220`} rotation={-90} origin="45,45" />
    </Svg>;
}

export type UsageDashboardProps = UsageAnalyticsState & {
    period: UsagePeriod; onPeriod: (period: UsagePeriod) => void; onRefresh: () => void;
    monthOffset?: number; onMonth?: (offset: number) => void; quotaSnapshot?: AccountQuotaSnapshot | null;
    sessionNames: Record<string, string>; machineNames: Record<string, string>;
    sessionRoles?: Record<string, UsageSessionRole>;
    onSession: (id: string) => void; quota?: React.ReactNode;
    /** Each machine's AI traffic ledger; the card is left out when the caller has none to give. */
    aiTraffic?: AiTrafficMachine[];
};
export function UsageDashboard(props: UsageDashboardProps) {
    const { theme } = useUnistyles();
    const locale = getDateLocale();
    const [width, setWidth] = React.useState(1000);
    const [engine, setEngine] = React.useState('');
    const [machineId, setMachine] = React.useState('');
    const [sessionId, setSession] = React.useState('');
    const [selectedAt, setSelectedAt] = React.useState<number | null>(null);
    const [recordPage, setRecordPage] = React.useState(1);
    const phone = width < 640, wide = width >= 1020;
    const monthOffset = props.monthOffset ?? 0;
    const window = React.useMemo(() => fiveHourUsageRange(props.quotaSnapshot, engine, props.now), [props.quotaSnapshot, engine, props.now]);
    const scope = { engine, machineId, sessionId, monthOffset, ...(props.period === '5hours' ? { range: window } : {}) };
    const summary = React.useMemo(() => summarizeUsage(props.records, props.period, props.now, scope), [props.records, props.period, props.now, engine, machineId, sessionId, monthOffset, window]);
    React.useEffect(() => { setSelectedAt(null); }, [engine, machineId, sessionId, props.period, monthOffset]);
    React.useEffect(() => { setRecordPage(1); }, [engine, machineId, sessionId, props.period, monthOffset, selectedAt]);
    const machines = [...new Set(props.records.map(r => r.machineId))];
    const sessionName = (id: string) => props.sessionNames[id] ?? t('lmc.usage.sessionFallback', { id: id.slice(-8) });
    const total = usageTotal(summary.total);
    const ready = props.updatedAt !== null;
    const display = (n: number) => ready ? fmt(n) : '—';
    const selected = summary.buckets.findIndex(b => b.at === selectedAt);
    const selectedBucket = selected < 0 ? null : summary.buckets[selected];
    const detailRecords = selectedBucket ? summary.records.filter(r => {
        const next = summary.buckets[selected + 1]?.at ?? summary.range.end;
        return r.occurredAt >= selectedBucket.at && r.occurredAt < next;
    }) : summary.records;
    const breakdown = selectedBucket ? summarizeUsage(detailRecords, props.period, props.now, scope) : summary;
    const timeLabel = (at: number) => new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
    const dayLabel = selectedBucket ? new Date(selectedBucket.at).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' }) : '';
    // Only horizontal siblings share available width. A flex basis of zero in
    // a vertical scroll flow collapses cards below their content's natural height.
    const card = (horizontal = false, grow = 1) => [styles.card, horizontal ? { flexGrow: grow, flexBasis: 0 } : { width: '100%' as const }];
    const emptyChartLabel = ready ? undefined : props.loading ? t('lmc.usage.loadingShort') : t('lmc.usage.unavailableShort');
    const bucketLabel = selectedBucket ? `${dayLabel}${props.period === '5hours' || props.period === 'today' ? ` ${timeLabel(selectedBucket.at)}` : ''}` : '';
    return <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surfaceHigh }} contentContainerStyle={{ flexGrow: 1 }}>
        <View testID="usage-dashboard" onLayout={e => setWidth(e.nativeEvent.layout.width)} style={[styles.page, phone && { padding: 14, gap: 14 }]}>
            <View style={styles.spread}>
                <View style={{ gap: 5 }}><Text accessibilityRole="header" style={styles.heading}>{t('lmc.usage.title')}</Text><Caption>{t('lmc.usage.subtitle')}</Caption></View>
                <View style={styles.row}>{([['5hours', t('lmc.usage.period5h')], ['today', t('lmc.usage.periodToday')], ['7days', t('lmc.usage.period7d')], ['30days', t('lmc.usage.period30d')], ['month', t('lmc.usage.periodMonth')]] as const).map(([value, label]) =>
                    <Choice key={value} label={label} selected={props.period === value} onPress={() => props.onPeriod(value)} />)}
                    <Pressable accessibilityRole="button" accessibilityLabel={t('lmc.usage.refreshA11y')} onPress={props.onRefresh} style={styles.chip}>
                        {props.loading ? <ActivityIndicator size="small" color={theme.colors.text} /> : <Ionicons name="refresh-outline" size={17} color={theme.colors.text} />}
                    </Pressable>
                </View>
            </View>
            <View style={styles.spread}>
                <View style={styles.row}>{[['', t('lmc.usage.allEngines')], ['claude', 'Claude'], ['codex', 'Codex'], ['agy', 'Antigravity']].map(([id, label]) => <Choice key={id} label={label} selected={engine === id} onPress={() => setEngine(id)} />)}</View>
                <View style={styles.row}><Choice label={t('lmc.usage.allDevices')} selected={!machineId} onPress={() => setMachine('')} />{machines.map(id => <Choice key={id} label={props.machineNames[id] ?? t('lmc.usage.deviceFallback', { id: id.slice(-6) })} selected={machineId === id} onPress={() => setMachine(id)} />)}</View>
            </View>
            {sessionId && <View style={styles.row}><Caption>{t('lmc.usage.filteredSession', { name: sessionName(sessionId) })}</Caption><Choice label={t('lmc.usage.clearSessionFilter')} onPress={() => setSession('')} /></View>}
            {props.period === '5hours' && <View testID="usage-window" style={styles.spread}>
                <Text style={styles.text}>{window.official ? t('lmc.usage.official5hWindow', { engine: engine === 'claude' ? 'Claude' : 'Codex' }) : t('lmc.usage.rolling5hWindow')}</Text>
                <Caption>{timeLabel(summary.range.start)} – {timeLabel(summary.range.end - 1)}{window.official ? t('lmc.usage.windowUpToNow') : engine ? t('lmc.usage.windowNoOfficial') : t('lmc.usage.windowSelectSingleEngine')}</Caption>
            </View>}
            {props.error && <View accessibilityRole="alert" {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={[styles.card, { borderColor: lmcColors(theme).attention }]}><Text style={styles.text}>{props.error}{ready ? t('lmc.usage.errorKeepingPrevious') : ''}</Text><Choice label={t('lmc.usage.reload')} onPress={props.onRefresh} /></View>}
            {!ready && props.loading && <Caption>{t('lmc.usage.loadingRecords')}</Caption>}
            {ready && !summary.count && <View {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={styles.card}><Text style={styles.title}>{t('lmc.usage.emptyRangeTitle')}</Text><Caption>{t('lmc.usage.emptyRangeBody')}</Caption></View>}
            <QuotaEfficiencyCard records={props.records} range={summary.range} machineNames={props.machineNames} />
            <View style={{ flexDirection: wide ? 'row' : 'column', gap: 14 }}>
                {!(props.period === 'month' && monthOffset < 0) && <View testID="usage-live-card" {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={[...card(wide, 1.12), { justifyContent: 'space-between' }]}>
                    <View style={styles.spread}><Text style={styles.title}>{t('lmc.usage.liveUsage')}</Text><View style={styles.row}><View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: props.error ? lmcColors(theme).attention : lmcColors(theme).brand }} /><Caption>{t('lmc.usage.last10m')}</Caption></View></View>
                    <View style={styles.row}><Text testID="usage-rate" style={[styles.number, { fontSize: phone ? 44 : 54 }]}>{display(summary.perMinute)}</Text><Caption>{t('lmc.usage.tokensPerMinute')}</Caption></View>
                    <Trend buckets={summary.pulse} small emptyLabel={emptyChartLabel} />
                    <Caption>{t('lmc.usage.pulseCaption')}</Caption>
                </View>}
                <View style={[{ gap: 14, minWidth: 0, flexShrink: 0 }, wide && { flexGrow: 1.3, flexBasis: 0 }]}>
                    <View style={{ flexDirection: phone ? 'column' : 'row', gap: 14 }}>
                        <View {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={card(!phone)}><Caption>{t('lmc.usage.totalTokens')}</Caption><Text testID="usage-total" style={styles.number}>{display(total)}</Text><Caption>{t('lmc.usage.recordsAndSessions', { records: summary.count.toLocaleString(), sessions: summary.sessions.length })}</Caption></View>
                        <View {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={card(!phone)}><Caption>{t('lmc.usage.inputOutput')}</Caption><Text style={[styles.number, { fontSize: 25 }]}>{display(summary.total.input)} / {display(summary.total.output)}</Text>
                            <View style={{ height: 5, flexDirection: 'row', overflow: 'hidden', borderRadius: 3, backgroundColor: lmcColors(theme).border }}>
                                <View style={{ flex: summary.total.input || 0.001, backgroundColor: palette.input }} /><View style={{ flex: summary.total.output || 0.001, backgroundColor: palette.output }} /></View><Caption>{t('lmc.usage.inputOutputCaption')}</Caption></View>
                    </View>
                    <View {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={[...card(), styles.spread]}><View style={{ gap: 8 }}><Caption>{t('lmc.usage.cacheHitRate')}</Caption><Text style={styles.number}>{summary.cacheRate === null || !ready ? '—' : `${(summary.cacheRate * 100).toFixed(1)}%`}</Text><Caption>{t('lmc.usage.cacheReadWrite', { read: display(summary.total.cacheRead), write: display(summary.total.cacheWrite) })}</Caption></View><Ring value={summary.cacheRate} /></View>
                </View>
            </View>
            <View style={{ flexDirection: phone ? 'column' : 'row', gap: 14 }}>{(['claude', 'codex', 'agy'] as const).map(id => {
                const stats = summary.engines.find(e => e.id === id), tokens = stats?.tokens ?? emptyUsage();
                return <Pressable key={id} accessibilityRole="button" accessibilityState={{ selected: engine === id }} accessibilityLabel={t('lmc.usage.filterEngineA11y', { engine: id === 'claude' ? 'Claude' : id === 'agy' ? 'Antigravity' : 'Codex' })} onPress={() => setEngine(engine === id ? '' : id)} {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={[...card(!phone), engine === id && { borderColor: lmcColors(theme).brand }]}>
                    <View style={styles.spread}><View style={styles.row}><ProviderIcon kind={id} size={22} /><Text style={styles.title}>{id === 'claude' ? 'Claude Code' : id === 'agy' ? 'Antigravity' : 'Codex'}</Text></View><Caption>{t('lmc.usage.sessionsCount', { count: summary.sessions.filter(s => s.engines.includes(id)).length })}</Caption></View>
                    <View style={styles.spread}><Text style={[styles.number, { fontSize: 29 }]}>{display(usageTotal(tokens))}</Text><Caption>{t('lmc.usage.usageRecordsCount', { count: stats?.count ?? 0 })}</Caption></View>
                    <View style={{ height: 4, borderRadius: 3, backgroundColor: lmcColors(theme).border }}><View style={{ height: 4, borderRadius: 3, width: `${total ? usageTotal(tokens) / total * 100 : 0}%`, backgroundColor: id === 'claude' ? palette.output : palette.input }} /></View>
                </Pressable>;
            })}</View>
            {props.period === 'month' && <View {...(Platform.OS === 'web' ? { dataSet: { lmcChromeSurface: 'true' } } : {})} style={styles.card}>
                <UsageCalendar buckets={summary.buckets} now={props.now} monthOffset={monthOffset} onMonth={offset => props.onMonth?.(offset)}
                    selectedAt={selectedBucket?.at ?? null} onSelect={setSelectedAt} collectedSince={props.collectedSince} ready={ready} />
            </View>}
            {selectedBucket && <View style={styles.spread} testID="usage-detail-scope">
                <Text style={styles.title}>{t('lmc.usage.selectedBucketTitle', { label: bucketLabel, tokens: fmt(usageTotal(breakdown.total)), count: breakdown.count })}</Text>
                <Choice label={props.period === 'month' ? t('lmc.usage.backToFullMonth') : t('lmc.usage.clearTimeFilter')} onPress={() => setSelectedAt(null)} />
            </View>}
            <View style={{ flexDirection: wide ? 'row' : 'column', gap: 14, alignItems: 'stretch' }}>
                <View testID="usage-trend-card" {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={card(wide, 2.4)}><View style={styles.spread}><Text style={styles.title}>{t('lmc.usage.usageTrend')}</Text><Caption>{props.period === '5hours' ? t('lmc.usage.granularity15m') : props.period === 'today' ? t('lmc.usage.granularityHourly') : t('lmc.usage.granularityDaily')}</Caption></View><Legend />
                    <Trend buckets={summary.buckets} daily={props.period !== 'today' && props.period !== '5hours'} selected={selected < 0 ? null : selected} onSelect={i => setSelectedAt(selected === i ? null : summary.buckets[i].at)} emptyLabel={emptyChartLabel} />
                    {!!summary.count && <Caption>{selectedBucket ? t('lmc.usage.selectedBucketCaption', { time: new Date(selectedBucket.at).toLocaleString(locale), tokens: fmt(usageTotal(selectedBucket.tokens)), count: selectedBucket.count }) : t('lmc.usage.clickBarHint')}</Caption>}
                </View>
                <View testID="usage-model-card" {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={card(wide)}><Text style={styles.title}>{selectedBucket ? `${dayLabel} · ` : ''}{t('lmc.usage.modelDistribution')}</Text>{breakdown.models.length ? breakdown.models.slice(0, 5).map(m => <View key={m.id} style={{ gap: 5 }}><View style={styles.spread}><Text numberOfLines={1} style={[styles.muted, { flex: 1 }]}>{m.id}</Text><Text style={styles.text}>{fmt(usageTotal(m.tokens))}</Text></View><View style={{ height: 4, backgroundColor: lmcColors(theme).border, borderRadius: 3 }}><View style={{ height: 4, width: `${usageTotal(m.tokens) / Math.max(1, usageTotal(breakdown.total)) * 100}%`, backgroundColor: m.engines[0] === 'claude' ? palette.output : palette.input, borderRadius: 3 }} /></View></View>) : <Caption>{t('lmc.usage.noModelRecords')}</Caption>}
                    {breakdown.models.length > 5 && <Caption>{t('lmc.usage.moreModelsHint', { count: breakdown.models.length - 5 })}</Caption>}
                    <View style={styles.line} /><Caption>{t('lmc.usage.noCostEstimateNote')}</Caption>
                </View>
            </View>
            {props.aiTraffic && props.period !== '5hours' && props.period !== 'month' && <View testID="usage-traffic-card" {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={styles.card}>
                <AiTrafficCard machines={props.aiTraffic} period={props.period} now={props.now} machineId={machineId} phone={phone} />
            </View>}
            <View style={{ flexDirection: wide ? 'row' : 'column', gap: 14, alignItems: 'flex-start' }}>
                <View testID="usage-session-card" {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={card(wide, 2.4)}>
                    <UsageSessionDetails sessions={breakdown.sessions} roles={props.sessionRoles} names={props.sessionNames} total={usageTotal(breakdown.total)} ready={ready}
                        scopeKey={`${props.period}:${monthOffset}:${engine}:${machineId}:${sessionId}:${selectedAt}`} onSession={props.onSession} onFilterSession={setSession} />
                </View>
                {props.quota && <View testID="usage-quota-card" {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={card(wide)}><Text style={styles.title}>{t('lmc.usage.accountQuotaTitle')}</Text><Caption>{t('lmc.usage.accountQuotaCaption')}</Caption>{props.quota}</View>}
            </View>
            <View testID="usage-records-card" {...(Platform.OS === 'web' ? {dataSet: {lmcChromeSurface: 'true'}} : {})} style={styles.card}><View style={styles.spread}><Text style={styles.title}>{selectedBucket ? t('lmc.usage.dayUsageRecords', { day: dayLabel }) : t('lmc.usage.recentUsageRecords')}</Text><Caption>{t('lmc.usage.showingRecords', { shown: Math.min(recordPage * 10, detailRecords.length), total: detailRecords.length })}</Caption></View>
                {detailRecords.slice(0, recordPage * 10).map(r => <View key={`${r.sessionId}:${r.key}`} style={styles.spread}>
                    <View style={{ flex: 1, minWidth: 160 }}><Text numberOfLines={1} style={styles.text}>{sessionName(r.sessionId)}</Text><Caption>{new Date(r.occurredAt).toLocaleString(locale)} · {r.engine} · {r.model ?? t('lmc.usage.unreportedModel')}</Caption></View>
                    <Text style={styles.title}>{fmt(usageTotal(r.tokens))}</Text><Caption>{t('lmc.usage.recordTokenSplit', { input: fmt(r.tokens.input), output: fmt(r.tokens.output), read: fmt(r.tokens.cacheRead), write: fmt(r.tokens.cacheWrite) })}</Caption>
                </View>)}
                {!detailRecords.length && <Caption>{t('lmc.usage.noRecordsInPeriod')}</Caption>}
                {detailRecords.length > recordPage * 10 && <Choice label={t('lmc.usage.showMoreRecords')} onPress={() => setRecordPage(p => p + 1)} />}
            </View>
            <View style={{ gap: 5, paddingBottom: 12 }}>
                <Caption>{props.collectedSince ? t('lmc.usage.collectedSinceNote', { since: new Date(props.collectedSince).toLocaleString(locale) }) : t('lmc.usage.waitingFirstRecordNote')}</Caption>
                <Caption>{t('lmc.usage.methodologyNote')}</Caption>
                <Caption>{props.updatedAt ? t('lmc.usage.lastSyncedNote', { time: new Date(props.updatedAt).toLocaleTimeString(locale) }) : t('lmc.usage.notSyncedYet')}</Caption>
            </View>
        </View>
    </ScrollView>;
}
