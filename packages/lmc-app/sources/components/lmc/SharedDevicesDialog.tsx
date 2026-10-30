import React from 'react';
import { View, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { randomUUID } from 'expo-crypto';
import { Text } from '@/components/StyledText';
import { UtilityDialog } from './UtilityDialog';
import { Modal } from '@/modal';
import { accountMe, accountRequest } from '@/sync/apiAccounts';
import { sync } from '@/sync/sync';

type SharedMachine = { id: string; name: string; platform: string; active: boolean; canExecute: boolean };
function SharedDevicesDialog({ onCreated, onClose }: { onCreated: (id: string) => void; onClose?: () => void }) {
    const { theme } = useUnistyles();
    const [machines, setMachines] = React.useState<SharedMachine[] | null>(null), [selected, setSelected] = React.useState('');
    const [engine, setEngine] = React.useState<'claude' | 'codex' | 'agy'>('codex');
    const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
    const [pendingSession, setPendingSession] = React.useState('');
    const request = React.useRef<{ signature: string; id: string } | null>(null);
    React.useEffect(() => { let active = true; void accountRequest<{ machines: SharedMachine[] }>('/v1/lmc/shared-machines').then(r => { if (active) setMachines(r.machines); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, []);
    async function create() {
        if (!selected || busy) return;
        setBusy(true); setError('');
        const signature = selected + ':' + engine;
        if (request.current?.signature !== signature) request.current = { signature, id: randomUUID() };
        try {
            const result = await accountRequest<{ sessionId: string; state: string }>(`/v1/lmc/machines/${encodeURIComponent(selected)}/runs`, { method: 'POST', signal: AbortSignal.timeout(120000), body: JSON.stringify({ requestId: request.current.id, engine }) });
            await sync.refreshSessions();
            if (result.state !== 'active') { setPendingSession(result.sessionId); setError('会话已创建，设备仍在启动。可以打开会话查看；重试不会重复创建。'); return; }
            onClose?.(); onCreated(result.sessionId);
        } catch (e) { setError(e instanceof Error ? e.message : '创建失败'); }
        finally { setBusy(false); }
    }
    return <UtilityDialog title="使用共享设备" onClose={onClose} maxWidth={600}>
        <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
            <Text style={{ color: theme.colors.textSecondary }}>使用设备现有的模型登录。新会话默认仅你可见，工作目录按账号存放；这仍是设备拥有者的运行环境。</Text>
            {!machines && !error && <ActivityIndicator />}
            {machines?.length === 0 && <Text style={{ color: theme.colors.textSecondary }}>暂无共享设备。管理员或设备拥有者可在设备详情的“共享设置”中授权。</Text>}
            {machines?.map(machine => <Pressable key={machine.id} accessibilityRole="button" disabled={busy || !machine.active || !machine.canExecute} onPress={() => setSelected(machine.id)} style={{ borderWidth: 1, borderColor: selected === machine.id ? theme.colors.textLink : theme.colors.divider, borderRadius: 14, padding: 16, gap: 6, opacity: machine.active && machine.canExecute ? 1 : 0.5 }}>
                <Text style={{ color: theme.colors.text }}>{machine.name}</Text><Text style={{ color: theme.colors.textSecondary }}>{machine.platform} · {machine.active ? machine.canExecute ? '可使用' : '仅查看' : '离线'}</Text>
            </Pressable>)}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>{(['codex', 'claude', 'agy'] as const).map(value => <Pressable key={value} accessibilityRole="button" disabled={busy} onPress={() => setEngine(value)} style={{ padding: 12, backgroundColor: engine === value ? theme.colors.surfaceHigh : undefined, borderRadius: 12 }}><Text style={{ color: theme.colors.text }}>{({ codex: 'Codex', claude: 'Claude Code', agy: 'Antigravity' })[value]}</Text></Pressable>)}</View>
            {!!error && <Text accessibilityRole="alert" style={{ color: theme.colors.textDestructive }}>{error}</Text>}
            {!!pendingSession && <Pressable accessibilityRole="button" onPress={() => { onClose?.(); onCreated(pendingSession); }}><Text style={{ color: theme.colors.textLink }}>打开已创建会话</Text></Pressable>}
            <Pressable accessibilityRole="button" disabled={!selected || busy} onPress={() => void create()} style={{ padding: 14, opacity: !selected || busy ? 0.5 : 1 }}>{busy ? <ActivityIndicator /> : <Text style={{ color: theme.colors.textLink }}>新建独占会话</Text>}</Pressable>
        </ScrollView>
    </UtilityDialog>;
}
export function SharedDeviceEntry({ onCreated }: { onCreated: (id: string) => void }) {
    const { theme } = useUnistyles();
    const [enabled, setEnabled] = React.useState(false);
    React.useEffect(() => { let active = true; void accountMe().then(result => { if (active) setEnabled(result.capabilities.deviceSharing === true); }).catch(() => {}); return () => { active = false; }; }, []);
    if (!enabled) return null;
    return <Pressable accessibilityRole="button" onPress={() => Modal.show({ component: SharedDevicesDialog, props: { onCreated }, blurBackdrop: true })} style={{ paddingVertical: 12 }}><Text style={{ color: theme.colors.textLink }}>使用共享设备</Text></Pressable>;
}
