import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { RuntimeUpdatesRows } from '@/components/RuntimeUpdatesPanel';
import { Modal } from '@/modal';
import { useAllMachines } from '@/sync/storage';
import { machineStopDaemon } from '@/sync/ops';
import { sync } from '@/sync/sync';
import type { Machine } from '@/sync/storageTypes';
import { machineAgentVersion, machineDisplayName } from '@/utils/lmc/deviceEngineGroups';
import { lmcColors } from '../lmcColors';
import { t } from '@/text';

/** Indent for everything belonging to the device above it. */
const NESTED = { paddingLeft: 16 } as const;

/**
 * Devices and their upgrades.
 *
 * One line per device, and everything else behind it. The pane used to open
 * with three rows of detail and a full update panel for every paired Mac at
 * once — daemon PIDs, ports, per-engine detection times — which is a page of
 * text to read before finding the one button that upgrades anything. Now the
 * line says the name, whether it is online and which agent it runs, and opening
 * it reveals the versions and the actions. Only the open device polls.
 */
export function DevicesUpgradePane({ onNavigate }: { onNavigate?: () => void }) {
    const machines = useAllMachines({ includeOffline: true });
    const [open, setOpen] = React.useState<string | null>(null);

    if (machines.length === 0) {
        return <ItemGroup title={t('lmc.devices.section')}><Item title={t('lmc.devices.none')} subtitle={t('lmc.devices.noneHint')} showChevron={false} /></ItemGroup>;
    }

    return (
        <ItemGroup title={t('lmc.devices.section')} footer={t('lmc.updates.footer')}>
            {machines.map((machine) => (
                <DeviceCard
                    key={machine.id}
                    machine={machine}
                    expanded={open === machine.id}
                    onToggle={() => setOpen((current) => (current === machine.id ? null : machine.id))}
                    onNavigate={onNavigate}
                />
            ))}
        </ItemGroup>
    );
}

function DeviceCard({ machine, expanded, onToggle, onNavigate }: {
    machine: Machine;
    expanded: boolean;
    onToggle: () => void;
    onNavigate?: () => void;
}) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const [stopping, setStopping] = React.useState(false);

    const name = machineDisplayName(machine, machine.id.slice(0, 8));
    const online = machine.active;
    const meta = machine.metadata;
    const version = machineAgentVersion(machine);

    // The body stays mounted and its height is animated, rather than being
    // unmounted behind a fade: an exiting element keeps its place in the layout
    // while it plays, so the rows below it sat under a block that was supposed
    // to be gone. Its own height is measured, so nothing has to be guessed.
    const [bodyHeight, setBodyHeight] = React.useState(0);
    const progress = useSharedValue(expanded ? 1 : 0);
    React.useEffect(() => {
        progress.value = withTiming(expanded ? 1 : 0, {
            duration: expanded ? 240 : 180,
            easing: Easing.out(Easing.cubic),
        });
    }, [expanded, progress]);
    const bodyStyle = useAnimatedStyle(() => ({
        height: progress.value * bodyHeight,
        opacity: progress.value,
    }));
    const chevronStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${progress.value * 180}deg` }] }));

    const stopDaemon = () => {
        Modal.alert(t('lmc.devices.stopTitle'), t('lmc.devices.stopBody', { name }), [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('lmc.devices.stop'), style: 'destructive', onPress: async () => {
                setStopping(true);
                try { const result = await machineStopDaemon(machine.id); Modal.alert(t('lmc.devices.stopped'), result.message); await sync.refreshMachines(); }
                catch { Modal.alert(t('lmc.devices.stopFailed'), t('lmc.devices.stopFailedHint')); }
                finally { setStopping(false); }
            } },
        ]);
    };

    return (
        <View>
            <Item
                title={name}
                subtitle={[
                    online ? t('status.online') : t('lmc.devices.offline'),
                    version ? `Agent ${version}` : null,
                    meta?.platform,
                ].filter(Boolean).join(' · ')}
                leftElement={
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: online ? colors.brand : colors.offline }} />
                }
                showChevron={false}
                showDivider={!expanded}
                rightElement={
                    <Animated.View style={chevronStyle}>
                        <Ionicons name="chevron-down" size={16} color={theme.colors.groupped.chevron} />
                    </Animated.View>
                }
                onPress={onToggle}
            />
            <Animated.View
                style={[{ overflow: 'hidden' }, bodyStyle]}
                pointerEvents={expanded ? 'auto' : 'none'}
                accessibilityElementsHidden={!expanded}
                importantForAccessibility={expanded ? 'auto' : 'no-hide-descendants'}
            >
                <View onLayout={(event) => {
                    const next = Math.round(event.nativeEvent.layout.height);
                    setBodyHeight((current) => (Math.abs(current - next) < 1 ? current : next));
                }}>
                    <RuntimeUpdatesRows
                        machineId={machine.id}
                        supported={meta?.managedUpgrades === true}
                        online={online}
                        // A folded device is not worth a request every five
                        // seconds; its rows keep whatever they last showed.
                        polling={expanded}
                        style={NESTED}
                    />
                    <Item
                        title={t('lmc.devices.detail')}
                        style={NESTED}
                        onPress={() => { onNavigate?.(); router.push(`/machine/${machine.id}`); }}
                    />
                    {online && (
                        <Item
                            title={t('lmc.devices.stopDaemon')}
                            style={NESTED}
                            loading={stopping}
                            showChevron={false}
                            showDivider={false}
                            titleStyle={{ color: theme.colors.textDestructive }}
                            onPress={stopDaemon}
                        />
                    )}
                </View>
            </Animated.View>
        </View>
    );
}
