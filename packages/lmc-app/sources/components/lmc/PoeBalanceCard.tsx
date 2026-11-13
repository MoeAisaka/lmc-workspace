import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { InteractionPressable as Pressable } from '@/components/InteractionPressable';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { usePoeBalance } from '@/sync/usePoeBalance';

export function PoeBalanceCard() {
    const { theme } = useUnistyles();
    const { balance, loading, failed, available, supported, now, refresh } = usePoeBalance();
    const stale = failed || balance?.stale || (!!balance?.capturedAt && now - balance.capturedAt > 120_000);
    const message = !supported ? t('localFeatures.poeUpgrade') : !available ? t('localFeatures.quotaOffline')
        : balance?.status === 'unconfigured' ? t('localFeatures.poeSetup')
        : balance?.status === 'authentication' ? t('localFeatures.poeAuth')
        : stale ? t('localFeatures.quotaRetryHint') : t('localFeatures.poeShared');
    return <View style={styles.card} testID="quota-poe">
        <View style={styles.heading}>
            <Text style={styles.name}>Poe</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={t('localFeatures.poeRefresh')} onPress={refresh} disabled={loading || !available} style={[{ borderRadius: 8 }, styles.refresh]}>
                {loading ? <ActivityIndicator size="small" color={theme.colors.textSecondary} /> : <Ionicons name="refresh-outline" size={16} color={theme.colors.textSecondary} />}
            </Pressable>
        </View>
        <Text style={styles.label}>{t('localFeatures.poePoints')}</Text>
        <Text style={styles.value}>{balance?.points == null ? '—' : balance.points.toLocaleString()}</Text>
        {balance?.capturedAt && <Text style={styles.note}>
            {stale ? `${t('localFeatures.quotaStale')} · ` : ''}{t('localFeatures.quotaSampled', { date: new Date(balance.capturedAt).toLocaleString() })}
        </Text>}
        <Text style={styles.note}>{message}</Text>
    </View>;
}

const styles = StyleSheet.create(theme => ({
    card: { backgroundColor: theme.dark ? 'rgba(255,255,255,0.045)' : '#F8F8F8', borderRadius: 14, borderWidth: 1, borderColor: theme.dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.04)', padding: 10, gap: 5 },
    heading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    name: { color: theme.colors.text, fontSize: 15, ...Typography.default('semiBold') },
    label: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 16, ...Typography.default() },
    note: { color: theme.colors.textSecondary, fontSize: 11, lineHeight: 16, ...Typography.default() },
    value: { color: theme.colors.text, fontSize: 24, lineHeight: 28, ...Typography.default('semiBold') },
    refresh: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
}));
