import * as React from 'react';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';
import type { AccountQuotaSnapshot } from 'lmc-wire';
import { Text } from '@/components/StyledText';
import { ProviderIcon } from '@/components/ProviderIcon';
import { Typography } from '@/constants/Typography';
import { weeklyRemaining, quotaTone, quotaToneColor } from '@/sync/quotaDisplay';
import { t } from '@/text';

const SIZE = 22;
const STROKE = 2.5;

function Ring({ remaining, color, track }: { remaining: number | null; color: string; track: string }) {
    const radius = (SIZE - STROKE) / 2;
    const circumference = 2 * Math.PI * radius;
    const progress = remaining == null ? 0 : Math.max(0, Math.min(100, remaining)) / 100;
    return (
        <Svg width={SIZE} height={SIZE} style={{ position: 'absolute' }}>
            <Circle cx={SIZE / 2} cy={SIZE / 2} r={radius} stroke={track} strokeWidth={STROKE} fill="none" />
            {progress > 0 && <Circle
                cx={SIZE / 2} cy={SIZE / 2} r={radius} stroke={color} strokeWidth={STROKE} fill="none" strokeLinecap="round"
                strokeDasharray={`${circumference} ${circumference}`} strokeDashoffset={circumference * (1 - progress)}
                rotation="-90" originX={SIZE / 2} originY={SIZE / 2}
            />}
        </Svg>
    );
}

/**
 * Claude and Codex at a glance in the avatar row (Figma D23): each ring is
 * the weekly window, coloured by urgency; grey
 * with a dash when there is no fresh reading. Tapping belongs to the row.
 */
export const QuotaRings = React.memo(function QuotaRings({ snapshot, now, showPercent }: {
    snapshot: AccountQuotaSnapshot | null; now: number; showPercent: boolean;
}) {
    const { theme } = useUnistyles();
    if (!snapshot) return null;
    const track = theme.dark ? '#3A3A3F' : '#E8E8E8';
    return (
        <View testID="avatar-quota-rings" style={{ flexDirection: 'row', alignItems: 'center', gap: showPercent ? 10 : 6 }}>
            {(['claude', 'codex'] as const).map((engine) => {
                const remaining = weeklyRemaining(snapshot.providers.find((p) => p.engine === engine), now);
                const tone = quotaTone(remaining);
                const color = quotaToneColor(tone, theme.dark);
                const value = remaining == null ? '—' : `${Math.round(remaining)}%`;
                return (
                    <View key={engine} accessibilityLabel={t('localFeatures.quotaRing', { engine: engine === 'claude' ? 'Claude' : 'Codex', value })}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <View style={{ width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' }}>
                            <Ring remaining={remaining} color={color} track={track} />
                            <ProviderIcon kind={engine} size={11} />
                        </View>
                        {showPercent && <Text numberOfLines={1} style={{
                            fontSize: 12, ...Typography.default('semiBold'),
                            color: tone === 'low' ? color : tone === 'unknown' ? theme.colors.textSecondary : theme.colors.text,
                        }}>{value}</Text>}
                    </View>
                );
            })}
        </View>
    );
});
