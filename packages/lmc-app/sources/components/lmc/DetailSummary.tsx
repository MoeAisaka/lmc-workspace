import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';

/** Compact identity shared by standalone detail pages. */
export function DetailSummary({ title, icon, status, statusColor, subtitle }: {
    title: string; icon: React.ReactNode; status: string; statusColor: string; subtitle?: string;
}) {
    const { theme } = useUnistyles();
    return <View testID="detail-summary" style={{ width: '100%', maxWidth: layout.maxWidth, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12, flexDirection: 'row', gap: 14, alignItems: 'center' }}>
        <View style={{ width: 48, height: 48, borderRadius: 14, overflow: 'hidden', backgroundColor: theme.colors.surfaceHigh, alignItems: 'center', justifyContent: 'center' }}>{icon}</View>
        <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
            <Text style={{ ...Typography.default('semiBold'), fontSize: 20, lineHeight: 28, color: theme.colors.text }}>{title}</Text>
            {subtitle && <Text style={{ fontSize: 13, lineHeight: 19, color: theme.colors.textSecondary }}>{subtitle}</Text>}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: statusColor }} />
                <Text style={{ fontSize: 13, lineHeight: 19, color: theme.colors.textSecondary }}>{status}</Text>
            </View>
        </View>
    </View>;
}
