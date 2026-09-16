import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { apiSocket } from '@/sync/apiSocket';
import { Modal } from '@/modal';
import { Typography } from '@/constants/Typography';
import { lmcColors } from './lmc/lmcColors';
import { ItemGroup } from './ItemGroup';
import { Item } from './Item';
import { t } from '@/text';

type Component = 'agent' | 'codex' | 'claude';
const NAMES: Record<Component, string> = { agent: 'LMC Agent', codex: 'Codex', claude: 'Claude Code' };
const COMPONENTS: Component[] = ['agent', 'claude', 'codex'];

const stateLabel = (state: string): string => ({
    installing: t('lmc.updates.stateInstalling'),
    activating: t('lmc.updates.stateActivating'),
    refreshing: t('lmc.updates.stateRefreshing'),
    complete: t('lmc.updates.stateComplete'),
    error: t('lmc.updates.stateError'),
    pending: t('lmc.updates.statePending'),
    waiting: t('lmc.updates.stateWaiting'),
    blocked: t('lmc.updates.stateBlocked'),
} as Record<string, string>)[state] ?? state;

/** The one action a version row offers, sized to sit inside it. */
function UpgradeButton({ label, name, disabled, onPress }: { label: string; name: string; disabled: boolean; onPress: () => void }) {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('lmc.updates.upgradeOne', { name })}
            disabled={disabled}
            onPress={onPress}
            style={({ pressed }) => ({
                height: 28,
                paddingHorizontal: 12,
                borderRadius: 14,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: colors.brand,
                opacity: disabled ? 0.35 : pressed ? 0.8 : 1,
            })}
        >
            <Text style={{ fontSize: 12.5, color: '#FFFFFF', ...Typography.default('semiBold') }}>{label}</Text>
        </Pressable>
    );
}

/**
 * Versions installed on one device and the upgrade for each.
 *
 * Rows rather than a panel: the settings pane folds these under the device they
 * belong to, and everything a run reports — which sessions are waiting, when it
 * last moved — collapses to the single line that says whether it is still
 * going. Polling lives here, so a folded device costs nothing.
 */
export function RuntimeUpdatesRows({ machineId, supported, online, polling = true, style }: {
    machineId: string;
    supported: boolean;
    online: boolean;
    /** False while the device is folded away: the rows keep their last answer. */
    polling?: boolean;
    style?: { paddingLeft?: number };
}) {
    const { theme } = useUnistyles();
    const [status, setStatus] = React.useState<any>(null);
    const [latest, setLatest] = React.useState<any>(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');

    const rpc = (method: string, params = {}) => apiSocket.machineRPC<any, any>(machineId, method, params);

    const load = React.useCallback(async () => {
        if (!supported || !online || !polling) return;
        try { setStatus(await apiSocket.machineRPC<any, {}>(machineId, 'runtime-status', {})); setError(''); }
        catch (failure) { setError(failure instanceof Error ? failure.message : t('lmc.updates.noResponse')); }
    }, [machineId, supported, online, polling]);

    React.useEffect(() => {
        if (!polling) return;
        void load();
        const timer = setInterval(() => void load(), 5000);
        return () => clearInterval(timer);
    }, [load, polling]);

    const perform = async (method: string, params = {}) => {
        setBusy(true);
        try { await rpc(method, params); await load(); }
        catch (failure) { Modal.alert(t('lmc.updates.actionFailed'), failure instanceof Error ? failure.message : t('lmc.updates.retry')); }
        finally { setBusy(false); }
    };

    if (!supported) {
        return <Item title={t('lmc.updates.unsupported')} subtitle={t('lmc.updates.unsupportedHint')} showChevron={false} style={style} />;
    }

    const job = status?.job;
    const active = status?.agentSwitching || ['installing', 'activating', 'refreshing'].includes(job?.state);
    const waiting = job?.sessions?.length ?? 0;

    return <>
        {COMPONENTS.map((engine) => {
            const installed = engine === 'agent'
                ? status?.agentVersion
                : status?.engines?.find((entry: any) => entry.engine === engine)?.version;
            const target = latest?.[engine];
            const upgradeable = Boolean(target) && target !== installed;
            return (
                <Item
                    key={engine}
                    title={NAMES[engine]}
                    subtitle={upgradeable ? t('lmc.updates.availableVersion', { version: (engine === 'claude' ? 'SDK ' : '') + target }) : undefined}
                    style={style}
                    showChevron={false}
                    rightElement={
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                            <Text style={{ fontSize: 13, color: theme.colors.textSecondary, ...Typography.default() }}>
                                {installed || t('lmc.updates.installedPending')}
                            </Text>
                            <UpgradeButton
                                label={t('lmc.updates.upgrade')}
                                name={NAMES[engine]}
                                disabled={!online || busy || active}
                                onPress={() => void perform('runtime-upgrade', { engine })}
                            />
                        </View>
                    }
                />
            );
        })}

        <Item
            title={t('lmc.updates.checkLatest')}
            style={style}
            loading={busy && !active}
            disabled={!online || busy}
            showChevron={false}
            onPress={() => {
                setBusy(true);
                void rpc('runtime-latest').then(setLatest).catch((failure) => setError(failure.message)).finally(() => setBusy(false));
            }}
        />

        {/* One line for a run in progress: the per-session list belongs to the
            device page, not to a settings row. */}
        {status?.agentSwitching && !job && (
            <Item title={t('lmc.updates.agentSwitching')} style={style} showChevron={false} titleStyle={{ color: theme.colors.textSecondary }} />
        )}
        {job && (
            <Item
                title={`${NAMES[job.engine as Component]} · ${stateLabel(job.state)}`}
                subtitle={[
                    t('lmc.updates.updatedAt', { time: new Date(job.updatedAt).toLocaleTimeString() }),
                    waiting > 0 ? t('lmc.updates.sessionsWaiting', { count: waiting }) : null,
                    job.error || null,
                ].filter(Boolean).join(' · ')}
                style={style}
                showChevron={false}
                titleStyle={job.state === 'error' ? { color: theme.colors.textDestructive } : undefined}
                onPress={job.state === 'error' && online && !busy ? () => void perform('runtime-retry') : undefined}
                detail={job.state === 'error' ? t('lmc.updates.retryRefresh') : undefined}
            />
        )}

        <Item
            title={t('lmc.updates.rollback')}
            style={style}
            disabled={busy || active || !online}
            showChevron={false}
            onPress={() => {
                void Modal.confirm(t('lmc.updates.rollbackTitle'), t('lmc.updates.rollbackBody'), {
                    confirmText: t('lmc.updates.rollbackConfirm'),
                    cancelText: t('common.cancel'),
                }).then((ok) => { if (ok) void perform('runtime-rollback'); });
            }}
        />

        {!!error && (
            <Item title={error} style={style} showChevron={false} titleStyle={{ color: theme.colors.textSecondary }} />
        )}
    </>;
}

/** The device page's version section: the same rows, in a group of their own. */
export function RuntimeUpdatesPanel(props: { machineId: string; supported: boolean; online: boolean }) {
    return (
        <ItemGroup title={t('lmc.updates.section')} footer={t('lmc.updates.footer')}>
            <RuntimeUpdatesRows {...props} />
        </ItemGroup>
    );
}
