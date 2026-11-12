import * as React from 'react';
import { Platform, View } from 'react-native';
import { InteractionPressable as Pressable } from '@/components/InteractionPressable';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { lmcColors } from '@/components/lmc/lmcColors';
import { compactTokens, usageCalendar, type UsageBucket } from '@/sync/usageAnalytics';
import { getDateLocale, t } from '@/text';
import { usageTotal } from 'lmc-wire';

const styles = StyleSheet.create(theme => ({
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    title: { color: theme.colors.text, fontSize: 15, fontWeight: '600', lineHeight: 22 },
    muted: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 19 },
    arrow: { minWidth: 36, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: lmcColors(theme).subtle },
    grid: { flexDirection: 'row', flexWrap: 'wrap', width: '100%' },
    slot: { width: '14.285714%', padding: 3 },
    weekday: { color: theme.colors.textSecondary, textAlign: 'center', fontSize: 12, lineHeight: 24 },
    day: { minHeight: 58, paddingVertical: 7, paddingHorizontal: 2, borderRadius: 9, borderWidth: 1, borderColor: 'transparent', alignItems: 'center', justifyContent: 'space-between', gap: 3 },
    date: { color: theme.colors.text, fontSize: 13, lineHeight: 18, fontVariant: ['tabular-nums'] },
    amount: { color: theme.colors.textSecondary, fontSize: 10, lineHeight: 15, fontVariant: ['tabular-nums'] },
    footer: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
    swatch: { width: 12, height: 12, borderRadius: 3 },
}));

export function UsageCalendar(props: {
    buckets: UsageBucket[]; now: number; monthOffset: number; onMonth: (offset: number) => void;
    selectedAt: number | null; onSelect: (at: number | null) => void; collectedSince: number | null; ready: boolean;
}) {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const calendar = usageCalendar(props.buckets, props.now, props.monthOffset, props.collectedSince);
    const heat = (level: number) => level === 0 ? colors.subtle : `rgba(0,96,240,${(theme.dark ? [0, .16, .27, .40, .58] : [0, .08, .15, .24, .36])[level]})`;
    const first = new Date(calendar.year, calendar.month, 1).getTime();
    const earliest = props.collectedSince === null ? null : new Date(props.collectedSince);
    const canPrevious = !earliest || first > new Date(earliest.getFullYear(), earliest.getMonth(), 1).getTime();
    const cells = [...Array.from({ length: calendar.leading }, () => null), ...calendar.days];
    while (cells.length % 7) cells.push(null);
    const arrow = (label: string, icon: 'chevron-back' | 'chevron-forward', enabled: boolean, offset: number) =>
        <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !enabled }} disabled={!enabled}
            onPress={() => props.onMonth(offset)} style={({ pressed }) => [styles.arrow, { opacity: enabled ? pressed ? .6 : 1 : .3 }]}>
            <Ionicons name={icon} size={16} color={theme.colors.text} />
        </Pressable>;
    const locale = getDateLocale();
    const monthTitle = new Date(calendar.year, calendar.month, 1).toLocaleDateString(locale, { year: 'numeric', month: 'long' });
    const selectedDateStr = props.selectedAt === null ? '' : new Date(props.selectedAt).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
    return <View testID="usage-calendar" style={{ gap: 10 }}>
        <View style={styles.header}>
            <Text style={styles.title}>{t('lmc.usage.calendarTitle')}</Text>
            <View style={styles.row}>
                {arrow(t('lmc.usage.prevMonthA11y'), 'chevron-back', canPrevious, props.monthOffset - 1)}
                <Text testID="usage-calendar-month" style={styles.title}>{monthTitle}</Text>
                {arrow(t('lmc.usage.nextMonthA11y'), 'chevron-forward', props.monthOffset < 0, props.monthOffset + 1)}
            </View>
        </View>
        <View style={styles.grid}>
            {t('lmc.usage.weekdays').split('|').map(day => <View key={day} style={styles.slot}><Text style={styles.weekday}>{day}</Text></View>)}
            {cells.map((day, index) => {
                if (!day) return <View key={`blank-${index}`} style={styles.slot} />;
                const selected = day.at === props.selectedAt;
                const disabled = !props.ready || day.state === 'future' || day.state === 'uncollected';
                const value = usageTotal(day.tokens);
                const note = !props.ready ? t('lmc.usage.dayWaiting') : day.state === 'future' ? t('lmc.usage.dayFuture') : day.state === 'uncollected' ? t('lmc.usage.dayUncollected') : day.count ? t('lmc.usage.dayRecordsNote', { tokens: compactTokens(value), count: day.count }) : t('lmc.usage.dayNoRecords');
                const dayDateLabel = new Date(calendar.year, calendar.month, day.day).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
                const label = `${dayDateLabel} · ${note}`;
                return <View key={day.at} style={styles.slot}>
                    <Pressable testID={`usage-day-${day.day}`} accessibilityRole="button" accessibilityLabel={label}
                        accessibilityState={{ selected, disabled }} disabled={disabled}
                        {...(Platform.OS === 'web' ? { title: label } : {})}
                        onPress={() => props.onSelect(selected ? null : day.at)}
                        style={({ pressed }) => [styles.day, { backgroundColor: heat(props.ready ? day.level : 0), borderColor: selected ? colors.brand : 'transparent', opacity: disabled ? .35 : pressed ? .65 : 1 }]}>
                        <Text style={styles.date}>{day.day}</Text>
                        <Text numberOfLines={1} style={styles.amount}>{!props.ready || day.state === 'future' ? '—' : day.state === 'uncollected' ? t('lmc.usage.dayUncollected') : day.count ? compactTokens(value) : t('lmc.usage.dayNoRecords')}</Text>
                    </Pressable>
                </View>;
            })}
        </View>
        <View style={styles.footer}>
            <Text style={styles.muted}>{props.selectedAt === null ? t('lmc.usage.selectDateHint') : t('lmc.usage.selectedDateHint', { date: selectedDateStr })}</Text>
            <View style={styles.row}><Text style={styles.muted}>{t('lmc.usage.less')}</Text>{[0, 1, 2, 3, 4].map(level => <View key={level} style={[styles.swatch, { backgroundColor: heat(level) }]} />)}<Text style={styles.muted}>{t('lmc.usage.more')}</Text></View>
        </View>
        <Text style={styles.muted}>{t('lmc.usage.calendarFootnote')}</Text>
    </View>;
}
