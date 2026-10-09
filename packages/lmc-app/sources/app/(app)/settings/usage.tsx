import React from 'react';
import { useRouter } from 'expo-router';
import { UsageDashboard } from '@/components/usage/UsageDashboard';
import { useUsageAnalytics } from '@/sync/useUsageAnalytics';
import type { UsagePeriod } from '@/sync/usageAnalytics';
import { useAllMachines, useAllSessions } from '@/sync/storage';
import { getSessionName } from '@/utils/sessionUtils';
import { machineDisplayName } from '@/utils/lmc/deviceEngineGroups';
import { useAccountQuota } from '@/sync/useAccountQuota';
import { AccountQuotaCards } from '@/components/lmc/AccountQuotaCards';
import { usageSessionRoles } from '@/sync/usageSessionGroups';
import { aiTrafficOf } from '@/utils/lmc/aiTraffic';

export default function UsageSettingsScreen() {
    const [period, setPeriod] = React.useState<UsagePeriod>('today');
    const data = useUsageAnalytics(period);
    const sessions = useAllSessions(), machines = useAllMachines({ includeOffline: true });
    const roles = React.useMemo(() => usageSessionRoles(sessions), [sessions]);
    const quota = useAccountQuota();
    const router = useRouter();
    return <UsageDashboard {...data} period={period} onPeriod={setPeriod} onRefresh={data.refresh}
        sessionNames={Object.fromEntries(sessions.map(s => [s.id, getSessionName(s)]))}
        sessionRoles={roles}
        machineNames={Object.fromEntries(machines.map(m => [m.id, machineDisplayName(m, m.id.slice(-6))]))}
        aiTraffic={machines.map(m => ({ id: m.id, name: machineDisplayName(m, m.id.slice(-6)), traffic: aiTrafficOf(m) }))}
        onSession={id => router.push(`/session/${id}`)}
        quota={<AccountQuotaCards {...quota} onRefresh={quota.refresh} />} />;
}
