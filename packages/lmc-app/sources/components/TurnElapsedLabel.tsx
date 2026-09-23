import * as React from 'react';
import { Text } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { useElapsedTime } from '@/hooks/useElapsedTime';
import { formatWorkDuration } from '@/hooks/useGroupedMessages';
import type { TurnElapsed } from '@/utils/turnElapsed';
import { t } from '@/text';

/** Owns the one-second clock so the composer and transcript do not rerender. */
export const TurnElapsedLabel = React.memo(function TurnElapsedLabel({ timing, compact = false }: { timing: TurnElapsed; compact?: boolean }) {
    const { theme } = useUnistyles();
    const live = timing.status === 'running' && timing.endedAt === null;
    const seconds = useElapsedTime(live ? timing.startedAt : null);
    const elapsed = timing.startedAt === null ? null : live ? seconds * 1000
        : timing.endedAt === null ? null : Math.max(0, timing.endedAt - timing.startedAt);
    const duration = elapsed === null ? t('toolGroup.timeline.timeUnrecorded')
        : `${timing.approximate ? '≈ ' : ''}${formatWorkDuration(elapsed)}`;
    const status = timing.status === 'unknown' ? '' : ` · ${t(`toolGroup.timeline.${timing.status}`)}`;
    const fullLabel = `${t('toolGroup.timeline.turnElapsed', { duration })}${status}`;
    return <Text testID="turn-elapsed" numberOfLines={1} accessibilityLabel={fullLabel}
        style={{ fontSize: compact ? 11 : 12, lineHeight: 18, color: theme.colors.textSecondary, ...Typography.default() }}>
        {compact ? duration : fullLabel}
    </Text>;
});
