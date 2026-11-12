import { DashboardCard } from '@/components/usage/DashboardCard';
import * as React from 'react';
import { Platform, TextInput, View } from 'react-native';
import { InteractionPressable as Pressable } from '@/components/InteractionPressable';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { usageTotal, type UsageTokens } from 'lmc-wire';
import { Text } from '@/components/StyledText';
import { lmcColors } from '@/components/lmc/lmcColors';
import { compactTokens as fmt, type UsageGroup } from '@/sync/usageAnalytics';
import { groupUsageByHub, type UsageSessionRole } from '@/sync/usageSessionGroups';
import { t } from '@/text';

const styles = StyleSheet.create(theme => ({
    root: { gap: 12, minWidth: 0, flexShrink: 0 },
    heading: { color: theme.colors.text, fontSize: 15, fontWeight: '600', lineHeight: 22 },
    text: { color: theme.colors.text, fontSize: 14, lineHeight: 21 },
    muted: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 19 },
    amount: { color: theme.colors.text, fontSize: 18, lineHeight: 24, fontWeight: '600', fontVariant: ['tabular-nums'] },
    row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
    between: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
    title: { flex: 1, minWidth: 0, gap: 4 },
    amountButton: { alignItems: 'flex-end', gap: 2, flexShrink: 0 },
    choice: { paddingHorizontal: 13, paddingVertical: 8, borderRadius: 10, backgroundColor: lmcColors(theme).subtle },
    selected: { backgroundColor: lmcColors(theme).brand },
    input: { fontSize: 13, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, backgroundColor: lmcColors(theme).subtle, color: theme.colors.text, minWidth: 160, flexGrow: 1, flexShrink: 1, maxWidth: 320 },
    entry: { gap: 8, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: lmcColors(theme).border, flexShrink: 0 },
    breakdown: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, columnGap: 16 },
    total: { flexGrow: 1, flexBasis: 0, minWidth: 84, gap: 5, padding: 10, borderRadius: 10, backgroundColor: lmcColors(theme).subtle },
    group: { gap: 12, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: lmcColors(theme).border },
    members: { paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: lmcColors(theme).border },
}));

function Breakdown({ tokens }: { tokens: UsageTokens }) {
    return <View style={styles.breakdown}>{([
        ['input', t('lmc.usage.catInput')], ['output', t('lmc.usage.catOutput')], ['cacheRead', t('lmc.usage.catCacheRead')], ['cacheWrite', t('lmc.usage.catCacheWrite')],
    ] as const).map(([key, label]) => <Text key={key} style={styles.muted} accessibilityLabel={`${label} ${tokens[key].toLocaleString()} Token`}>{label} {fmt(tokens[key])}</Text>)}</View>;
}

export function UsageSessionDetails({ sessions, roles = {}, names, total, ready, scopeKey, onSession, onFilterSession }: {
    sessions: UsageGroup[]; roles?: Record<string, UsageSessionRole>; names: Record<string, string>;
    total: number; ready: boolean; scopeKey: string; onSession: (id: string) => void; onFilterSession: (id: string) => void;
}) {
    const { theme } = useUnistyles();
    const [mode, setMode] = React.useState<'sessions' | 'hubs'>('sessions');
    const [search, setSearch] = React.useState('');
    const [page, setPage] = React.useState(1);
    const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
    const [memberPages, setMemberPages] = React.useState<Record<string, number>>({});
    React.useEffect(() => { setPage(1); setMemberPages({}); }, [mode, search, scopeKey]);
    React.useEffect(() => { setExpanded({}); }, [search]);
    const grouped = React.useMemo(() => groupUsageByHub(sessions, roles), [sessions, roles]);
    const name = (id: string) => names[id] ?? t('lmc.usage.sessionFallback', { id: id.slice(-8) });
    const otherTitle = t('lmc.usage.otherSessions');
    const query = search.trim().toLocaleLowerCase();
    const matches = (id: string) => name(id).toLocaleLowerCase().includes(query) || id.toLowerCase().includes(query);
    const rows = sessions.filter(s => matches(s.id));
    const groups = grouped.groups.filter(g => (g.hubId ? matches(g.hubId) : otherTitle.toLocaleLowerCase().includes(query)) || g.sessions.some(s => matches(s.id)));
    const count = mode === 'sessions' ? rows.length : groups.length;
    const roleLabel = (id: string) => {
        const role = roles[id];
        return role?.role === 'hub' ? t('lmc.usage.roleHubSelf') : role?.role === 'worker' ? t('lmc.usage.roleWorkerOf', { name: name(role.hubId) })
            : role?.role === 'standalone' ? t('lmc.usage.roleStandalone') : t('lmc.usage.roleUnconfirmed');
    };
    const renderSession = (s: UsageGroup) => <View key={s.id} testID={`usage-session-row-${s.id}`} style={styles.entry}>
        <View style={styles.between}>
            <Pressable accessibilityRole="button" accessibilityLabel={t('lmc.usage.openSessionA11y', { name: name(s.id) })} onPress={() => onSession(s.id)} style={styles.title}>
                <Text numberOfLines={2} style={styles.text}>{name(s.id)}</Text>
                <Text style={styles.muted}>{roleLabel(s.id)}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={t('lmc.usage.filterBySessionA11y', { name: name(s.id) })} accessibilityHint={t('lmc.usage.totalTokensHint', { tokens: usageTotal(s.tokens).toLocaleString() })} onPress={() => onFilterSession(s.id)} style={styles.amountButton}>
                <Text style={styles.amount}>{fmt(usageTotal(s.tokens))}</Text><Text style={styles.muted}>Token · {total ? (usageTotal(s.tokens) / total * 100).toFixed(1) : '0.0'}%</Text>
            </Pressable>
        </View>
        <Breakdown tokens={s.tokens} />
        <Text style={styles.muted}>{s.engines.map(e => e === 'claude' ? 'Claude' : e === 'agy' ? 'Antigravity' : 'Codex').join(' / ')} · {t('lmc.usage.recordsShortCount', { count: s.count.toLocaleString() })}</Text>
    </View>;

    return <View style={styles.root}>
        <View style={styles.row}><Text style={styles.heading}>{t('lmc.usage.sessionUsageTitle')}</Text>
            <TextInput accessibilityLabel={t('lmc.usage.searchSessionOrHub')} placeholder={t('lmc.usage.searchSessionOrHubPlaceholder')} placeholderTextColor={theme.colors.textSecondary} value={search} onChangeText={setSearch} style={styles.input} />
        </View>
        <View style={styles.row}>{([['sessions', t('lmc.usage.bySession')], ['hubs', t('lmc.usage.byHub')]] as const).map(([value, label]) => <Pressable key={value} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: mode === value }}
            onPress={() => setMode(value)} style={({ pressed }) => [styles.choice, mode === value && styles.selected, pressed && { opacity: .75 }]}>
            <Text style={[styles.muted, mode === value && { color: '#FFFFFF' }]}>{label}</Text>
        </Pressable>)}</View>
        <Text style={styles.muted}>{t('lmc.usage.sessionSortCaption')}</Text>
        {mode === 'hubs' && <>
            <View style={styles.row}>{([['hubs', t('lmc.usage.roleHubSelf')], ['workers', t('lmc.usage.roleWorkers')], ['other', otherTitle]] as const).map(([key, label]) => <DashboardCard key={key} testID={`usage-role-${key}`} style={styles.total}>
                <Text style={styles.muted}>{label}</Text><Text style={styles.heading} accessibilityLabel={`${label} ${ready ? usageTotal(grouped.totals[key]).toLocaleString() + ' Token' : t('lmc.usage.noData')}`}>{ready ? fmt(usageTotal(grouped.totals[key])) : '—'}</Text><Text style={styles.muted}>Token</Text>
            </DashboardCard>)}</View>
            <Text style={styles.muted}>{t('lmc.usage.hubGroupingNote')}</Text>
        </>}
        {mode === 'sessions' ? rows.slice(0, page * 10).map(renderSession) : groups.slice(0, page * 10).map(group => {
            const title = group.hubId ? name(group.hubId) : otherTitle;
            const open = expanded[group.id] ?? (!!query && group.sessions.some(s => matches(s.id)));
            const memberLimit = (memberPages[group.id] ?? 1) * 10;
            return <View key={group.id} testID={`usage-hub-group-${group.hubId ?? 'other'}`} style={styles.group}>
                <View style={styles.between}>
                    {group.hubId ? <Pressable accessibilityRole="button" accessibilityLabel={t('lmc.usage.openHubA11y', { title })} onPress={() => onSession(group.hubId!)} style={styles.title}><Text numberOfLines={2} style={styles.heading}>{title}</Text></Pressable>
                        : <Text style={[styles.heading, { flex: 1 }]}>{title}</Text>}
                    <Pressable accessibilityRole="button" accessibilityLabel={t('lmc.usage.toggleGroupA11y', { open, title })} accessibilityHint={t('lmc.usage.groupTotalHint', { tokens: usageTotal(group.tokens).toLocaleString() })} accessibilityState={{ expanded: open }} onPress={() => setExpanded(current => ({ ...current, [group.id]: !open }))} style={[styles.row, { flexShrink: 0 }]}>
                        <View style={styles.amountButton}><Text style={styles.amount}>{fmt(usageTotal(group.tokens))}</Text><Text style={styles.muted}>{t('lmc.usage.tokensAndSessions', { count: group.sessions.length })}</Text></View>
                        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={theme.colors.textSecondary} />
                    </Pressable>
                </View>
                {group.hubId ? <View style={styles.breakdown}><Text style={styles.muted}>{t('lmc.usage.hubOwnAmount', { amount: fmt(usageTotal(group.ownTokens)) })}</Text><Text style={styles.muted}>{t('lmc.usage.workerAmount', { amount: fmt(usageTotal(group.workerTokens)) })}</Text></View>
                    : <Text style={styles.muted}>{t('lmc.usage.otherSessionsNote')}</Text>}
                <Breakdown tokens={group.tokens} />
                {open && <View {...(Platform.OS === 'web' ? { dataSet: { 'yulor-disclosure': 'content' } } : {})} style={styles.members}>
                    {group.sessions.slice(0, memberLimit).map(renderSession)}
                    {group.sessions.length > memberLimit && <Pressable accessibilityRole="button" accessibilityLabel={t('lmc.usage.showMoreGroupSessionsA11y', { title })} onPress={() => setMemberPages(p => ({ ...p, [group.id]: (p[group.id] ?? 1) + 1 }))} style={styles.choice}><Text style={styles.muted}>{t('lmc.usage.showMoreSessionsCount', { count: group.sessions.length - memberLimit })}</Text></Pressable>}
                </View>}
            </View>;
        })}
        {!count && <Text style={styles.muted}>{!ready ? t('lmc.usage.emptyNotReady') : query ? t('lmc.usage.emptyNoMatch') : t('lmc.usage.emptyFiltered')}</Text>}
        {count > page * 10 && <Pressable accessibilityRole="button" accessibilityLabel={t('lmc.usage.showMoreGroupsA11y')} onPress={() => setPage(p => p + 1)} style={styles.choice}><Text style={styles.muted}>{t('lmc.usage.showMoreCount', { count: count - page * 10 })}</Text></Pressable>}
    </View>;
}
