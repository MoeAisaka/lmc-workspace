import * as React from 'react';
import { Platform, View, type ViewProps } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

/** Information stays selectable; only the real actions inside a card are buttons. */
export const DashboardCard = React.forwardRef<View, ViewProps & {
    dataSet?: Record<string, string | number | undefined>;
}>(function DashboardCard({ dataSet, ...props }, ref) {
    return <View {...props} ref={ref} {...(Platform.OS === 'web' ? {
        dataSet: { ...dataSet, 'yulor-card': 'true' },
    } : {})} />;
});

export function DashboardChevron({ expanded, direction = 'down', size = 16, color }: {
    expanded: boolean; direction?: 'down' | 'forward'; size?: number; color: string;
}) {
    return <View {...(Platform.OS === 'web' ? { dataSet: { 'yulor-disclosure': 'chevron' } } : {})}
        style={{ transform: [{ rotate: `${expanded ? direction === 'forward' ? 90 : 180 : 0}deg` }] }}>
        <Ionicons name={direction === 'forward' ? 'chevron-forward' : 'chevron-down'} size={size} color={color} />
    </View>;
}
