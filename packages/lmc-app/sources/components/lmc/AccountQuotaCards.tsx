import * as React from 'react';
import { Pressable, View, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { fableWeeklyShare, quotaDailyPace, type AccountQuotaSnapshot, type AccountQuotaWindow } from 'lmc-wire';
import { Text } from '@/components/StyledText';
import { ProviderIcon } from '@/components/ProviderIcon';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { lmcColors } from './lmcColors';

const styles = StyleSheet.create(theme => ({
    section: { gap: 10, paddingVertical: 10 },
    heading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    card: { backgroundColor: theme.dark ? 'rgba(255,255,255,0.045)' : '#F8F8F8', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, gap: 10 },
    provider: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    name: { color: theme.colors.text, fontSize: 15, ...Typography.default('semiBold') },
    label: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 16, ...Typography.default() },
    note: { color: theme.colors.textSecondary, fontSize: 11, lineHeight: 15, ...Typography.default() },
    value: { color: theme.colors.text, fontSize: 24, lineHeight: 30, ...Typography.default('semiBold') },
    columns: { flexDirection: 'row', gap: 20 },
    window: { flex: 1, minWidth: 0, gap: 4 },
    track: { height: 5, borderRadius: 3, backgroundColor: theme.dark ? '#404044' : '#E4E4E7', marginVertical: 3 },
    legend: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    dot: { width: 5, height: 5, borderRadius: 3 },
    refresh: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
}));
const n = (v: number) => String(Math.round(v * 10) / 10);
const date = (value: number, now: number) => new Date(value).toLocaleString(undefined, {
    ...(new Date(value).toDateString() === new Date(now).toDateString() ? {} : { month: 'numeric' as const, day: 'numeric' as const }),
    hour: '2-digit', minute: '2-digit',
});

export function AccountQuotaCards({ snapshot, loading, failed, available, now, onRefresh }: {
    snapshot: AccountQuotaSnapshot | null; loading: boolean; failed: boolean; available: boolean; now: number; onRefresh: () => void;
}) {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const purple = theme.dark ? '#AC98E9' : '#9981CF';
    const warn = theme.dark ? '#E6AE66' : '#A16C24';
    const renderWindow = (w: AccountQuotaWindow | undefined, label: string, overlay?: { left: number; width: number; color: string }[]) => {
        const expired = !!w?.resetsAt && w.resetsAt <= now && !w.pending;
        const remaining = w?.remaining ?? null;
        const pace = w ? quotaDailyPace(w, now) : null;
        const diff = remaining !== null && pace ? remaining - pace.floor : null;
        return <View style={styles.window}>
            <View>
                <Text style={styles.label}>{label}</Text>
                <Text style={styles.value}>{remaining === null ? '—' : `${Math.round(remaining)}%`}</Text>
            </View>
            <View accessibilityRole="progressbar" accessibilityLabel={label}
                accessibilityValue={remaining === null ? { text: t('localFeatures.quotaUnknown') } : { min: 0, max: 100, now: remaining }} style={styles.track}>
                <View style={{ position: 'absolute', height: 5, borderRadius: 3, width: `${remaining ?? 0}%`, backgroundColor: colors.brand, opacity: expired ? 0.4 : 1 }} />
                {remaining !== null && !expired && overlay?.filter(s => s.width > 0).map((s, i) => <View key={i} style={{ position: 'absolute', height: 5, left: `${s.left}%`, width: `${s.width}%`, backgroundColor: s.color, borderRadius: 2 }} />)}
                {pace && <View accessibilityLabel={t('localFeatures.quotaPaceMarker', { floor: n(pace.floor) })} style={{ position: 'absolute', width: 2, height: 11, top: -3, left: `${pace.floor}%`, backgroundColor: diff !== null && diff < 0 ? warn : theme.colors.textSecondary }} />}
            </View>
            <Text style={styles.note}>{w?.pending ? t('localFeatures.quotaPending') : expired ? t('localFeatures.quotaAwaitReset') : w?.resetsAt ? t('localFeatures.quotaReset', { date: date(w.resetsAt, now) }) : t('localFeatures.quotaUnknown')}</Text>
            {pace && diff !== null && <Text style={[styles.note, diff < 0 && { color: warn }]}>{diff < 0 ? t('localFeatures.quotaOver', { points: n(-diff) }) : t('localFeatures.quotaToday', { points: n(diff) })}</Text>}
        </View>;
    };
    return <View style={styles.section} testID="account-quota-cards">
        <View style={styles.heading}>
            <Text style={styles.label}>{t('localFeatures.quotaTitle')}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={t('localFeatures.quotaRefresh')} disabled={loading || !available} onPress={onRefresh} style={({ pressed }) => [styles.refresh, pressed && { backgroundColor: theme.colors.surfacePressed }]}>
                {loading ? <ActivityIndicator size="small" color={colors.brand} /> : <Ionicons name="refresh-outline" size={16} color={available ? theme.colors.textSecondary : colors.placeholder} />}
            </Pressable>
        </View>
        {(['codex', 'claude'] as const).map(engine => {
            const p = snapshot?.providers.find(p => p.engine === engine);
            const weekly = p?.windows.find(w => w.id === 'seven_day');
            const fable = p?.windows.find(w => w.id === 'fable_week');
            // A reset invalidates the comparison; keep the last read visible with its age.
            const comparable = !weekly?.pending && !fable?.pending && weekly?.resetsAt && fable?.resetsAt && weekly.resetsAt > now && fable.resetsAt > now && Math.abs(weekly.resetsAt - fable.resetsAt) < 60_000;
            const share = comparable ? fableWeeklyShare(weekly?.remaining ?? null, fable?.remaining ?? null) : null;
            const stale = p?.stale || !p?.capturedAt || now - p.capturedAt > (engine === 'codex' ? 65 : 30) * 60_000;
            return <View key={engine} style={styles.card} testID={`quota-${engine}`}>
                <View style={styles.provider}>
                    <ProviderIcon kind={engine} size={18} /><Text style={styles.name}>{engine === 'codex' ? 'Codex' : 'Claude'}</Text><View style={{ flex: 1 }} />
                    <Text style={[styles.note, { flexShrink: 1, textAlign: 'right' }]}>{[p?.plan?.toUpperCase(), p?.capturedAt ? t('localFeatures.quotaSampled', { date: date(p.capturedAt, now) }) : null].filter(Boolean).join(' · ')}</Text>
                </View>
                <View style={styles.columns}>
                    {renderWindow(p?.windows.find(w => w.id === 'five_hour'), t('localFeatures.quotaFiveHour'))}
                    {renderWindow(weekly, t('localFeatures.quotaWeekly'), share ? [{ left: 0, width: share.covered, color: purple }, { left: weekly!.remaining!, width: share.overflow, color: warn }] : undefined)}
                </View>
                {engine === 'claude' && <View style={styles.legend} testID="quota-fable-legend">
                    <View style={[styles.dot, { backgroundColor: share ? purple : theme.colors.textSecondary }]} />
                    <Text style={[styles.note, { flex: 1 }]} accessibilityLabel={`${t('localFeatures.quotaFable')}: ${fable?.remaining == null ? t('localFeatures.quotaUnknown') : `${n(fable.remaining)}%`}. ${t('localFeatures.quotaFableConvention')}`}>
                        Fable {fable?.remaining == null ? '—' : `${n(fable.remaining)}%`}
                        {share ? <> · {t('localFeatures.quotaFableShare', { points: n(share.need) })}{share.overflow > 0 && <Text style={{ color: warn }}> · {t('localFeatures.quotaFableGap', { points: n(share.overflow) })}</Text>}</> : fable?.remaining != null ? ` · ${t('localFeatures.quotaFableSyncPending')}` : ''}
                    </Text>
                </View>}
                {p?.resetCredits && <Text style={styles.note}>{t('localFeatures.quotaCredits', { count: p.resetCredits.count })}{p.resetCredits.expiresAt ? ` · ${t('localFeatures.quotaExpires', { date: date(p.resetCredits.expiresAt, now) })}` : ''}</Text>}
                {(!p?.capturedAt || failed || p.refreshFailed || stale) && <Text style={styles.note}>{p?.capturedAt ? t('localFeatures.quotaStale') : t('localFeatures.quotaWaiting')}</Text>}
            </View>;
        })}
        <Text style={styles.note}>{!available ? t('localFeatures.quotaOffline') : failed ? t('localFeatures.quotaRetryHint') : t('localFeatures.quotaShared')}</Text>
    </View>;
}
