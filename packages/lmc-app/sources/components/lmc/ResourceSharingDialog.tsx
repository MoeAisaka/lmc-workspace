import React from 'react';
import { View, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Switch } from '@/components/Switch';
import { Text } from '@/components/StyledText';
import { Modal } from '@/modal';
import { UtilityDialog } from './UtilityDialog';
import { accountDirectory, accountMe, accountRequest, getSharing, putSharing, type SharingPolicy } from '@/sync/apiAccounts';
import { fileSize } from '@/utils/fileSize';

export function ResourceSharingDialog({ kind, id, onClose }: { kind: string; id: string; onClose?: () => void }) {
    const { theme } = useUnistyles();
    const [policy, setPolicy] = React.useState<SharingPolicy | null>(null);
    const [members, setMembers] = React.useState<Array<{ id: string; username: string | null }>>([]);
    const [admin, setAdmin] = React.useState(false);
    const [busy, setBusy] = React.useState(true), [error, setError] = React.useState(''), [notice, setNotice] = React.useState('');
    const [events, setEvents] = React.useState<Array<{ id: string; actorId: string; createdAt: string }>>([]);
    const active = React.useRef(true), working = React.useRef(false);
    const load = async () => {
        const [next, directory, self, audit] = await Promise.all([getSharing(kind, id), accountDirectory(), accountMe(), accountRequest<{ events: Array<{ id: string; actorId: string; createdAt: string }> }>('/v1/lmc/sharing/' + kind + '/' + encodeURIComponent(id) + '/audit')]);
        if (active.current) { setPolicy(next); setMembers(directory.accounts); setAdmin(self.account.role === 'admin'); setEvents(audit.events); }
    };
    const run = async (work: () => Promise<void>) => {
        if (working.current) return; working.current = true; setBusy(true); setError(''); setNotice('');
        try { await work(); } catch (e) { if (active.current) setError(e instanceof Error ? e.message : '操作失败'); }
        finally { working.current = false; if (active.current) setBusy(false); }
    };
    React.useEffect(() => { active.current = true; void run(load); return () => { active.current = false; }; }, [kind, id]);
    const name = (accountId: string) => members.find(m => m.id === accountId)?.username ?? accountId;
    const disabled = busy || !policy?.canManage || !policy.sharingSupported;
    return <UtilityDialog title="共享设置" onClose={onClose} maxWidth={580} testID="resource-sharing-dialog">
        <ScrollView contentContainerStyle={{ padding: 20, gap: 18 }}>
            {busy && <ActivityIndicator />}
            {!!error && <Text accessibilityRole="alert" style={{ color: theme.colors.textDestructive }}>{error}</Text>}
            {!!notice && <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.textLink }}>{notice}</Text>}
            {policy && <>
                <Text style={{ fontSize: 20, fontWeight: '600', color: theme.colors.text }}>{policy.grants.length ? '指定账号共享' : '独占'}</Text>
                <Text style={{ color: theme.colors.textSecondary }}>拥有者：{name(policy.ownerAccountId)}。{kind === 'machine' ? '允许指定账号使用此设备的模型登录和工具环境。每个账号新建的会话默认独占，不会自动分享设备上的其他会话。设备操作须信任使用者；这不是操作系统隔离。' : kind === 'session' ? '共享完整历史及会话上传附件，可分别允许发言、停止和单次审批。模型与工具使用此会话现有设置；已保存文件需分别共享。' : '共享对象须登录各自的 LMC 账号，能够预览、下载此文件，不能转分享或创建公开外链。'}</Text>
                {policy.adminManaged && <Text style={{ color: theme.colors.textSecondary }}>此资源由管理员管理共享范围。</Text>}
                {policy.unavailableReason && <Text style={{ color: theme.colors.textSecondary }}>{policy.unavailableReason}</Text>}
                {members.filter(m => m.id !== policy.ownerAccountId).map(member => <View key={member.id} style={{ gap: 6 }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 }}>
                    <Text style={{ color: theme.colors.text, flex: 1 }}>{member.username ?? member.id}</Text>
                    <Switch accessibilityLabel={'共享给 ' + (member.username ?? member.id)} disabled={disabled} value={policy.grants.some(g => g.accountId === member.id)} onValueChange={checked => setPolicy({ ...policy, grants: checked ? [...policy.grants, { accountId: member.id, actions: ['read'] }] : policy.grants.filter(g => g.accountId !== member.id) })} />
                </View>
                    {(kind === 'session' || kind === 'machine') && policy.grants.some(g => g.accountId === member.id) && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
                        {(kind === 'machine' ? ['execute'] as const : ['send', 'stop', 'approve'] as const).map(action => <View key={action} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Text style={{ color: theme.colors.textSecondary }}>{({ send: '发言', stop: '停止', approve: '单次审批', execute: '运行会话' })[action]}</Text><Switch disabled={disabled} accessibilityLabel={name(member.id) + ' ' + action} value={policy.grants.find(g => g.accountId === member.id)?.actions.includes(action)} onValueChange={checked => setPolicy({ ...policy, grants: policy.grants.map(g => g.accountId !== member.id ? g : { ...g, actions: checked ? [...g.actions, action] : g.actions.filter(a => a !== action) }) })} /></View>)}
                    </View>}
                </View>)}
                {policy.grants.filter(g => !members.some(m => m.id === g.accountId)).map(grant => <View key={grant.accountId} style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Text style={{ flex: 1, color: theme.colors.textSecondary }}>已停用账号 {grant.accountId}</Text>
                    <Pressable accessibilityRole="button" disabled={disabled} onPress={() => setPolicy({ ...policy, grants: policy.grants.filter(g => g.accountId !== grant.accountId) })} style={{ padding: 12 }}><Text style={{ color: theme.colors.textLink }}>移除</Text></Pressable>
                </View>)}
                {admin && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <Text style={{ flex: 1, color: theme.colors.text }}>由管理员管理共享范围</Text>
                    <Switch accessibilityLabel="由管理员管理共享范围" value={policy.adminManaged} disabled={busy || !policy.sharingSupported} onValueChange={value => setPolicy({ ...policy, adminManaged: value })} />
                </View>}
                <Text style={{ color: theme.colors.textSecondary }}>取消选择并保存后恢复独占。撤销会阻止新的读取，已下载的文件无法远程收回。</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
                    <Pressable accessibilityRole="button" disabled={disabled} onPress={() => void run(async () => { await putSharing(policy); await load(); if (active.current) setNotice('共享设置已保存'); })} style={{ padding: 14, borderRadius: 12, backgroundColor: theme.colors.surfaceHigh, opacity: disabled ? 0.5 : 1 }}><Text style={{ color: theme.colors.textLink }}>保存</Text></Pressable>
                    <Pressable accessibilityRole="button" disabled={busy} onPress={() => void run(load)} style={{ padding: 14 }}><Text style={{ color: theme.colors.textLink }}>重新加载</Text></Pressable>
                </View>
                {!!events.length && <><Text style={{ color: theme.colors.text, fontWeight: '600' }}>最近权限变更</Text>{events.slice(0, 10).map(event => <Text key={event.id} style={{ color: theme.colors.textSecondary }}>{name(event.actorId)} · {new Date(event.createdAt).toLocaleString()}</Text>)}</>}
            </>}
        </ScrollView>
    </UtilityDialog>;
}
export const openResourceSharing = (kind: string, id: string) => Modal.show({ component: ResourceSharingDialog, props: { kind, id }, blurBackdrop: true });

function ResourceSharingList({ ownerId, onClose }: { ownerId?: string; onClose?: () => void }) {
    const { theme } = useUnistyles();
    const [files, setFiles] = React.useState<Array<{ id: string; kind: string; createdAt: string; size: number | null }> | null>(null);
    const [error, setError] = React.useState('');
    React.useEffect(() => {
        let active = true;
        void accountRequest<{ resources: NonNullable<typeof files> }>('/v1/lmc/sharing/resources' + (ownerId ? '?ownerId=' + encodeURIComponent(ownerId) : '')).then(result => { if (active) setFiles(result.resources); }).catch(e => { if (active) setError(e.message); });
        return () => { active = false; };
    }, [ownerId]);
    return <UtilityDialog title="资源共享" onClose={onClose} maxWidth={650}>
        <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
            <Text style={{ color: theme.colors.textSecondary }}>可管理设备、会话与已保存文件的共享。模型登录按设备使用；自己的新设备可登录独立的模型账号。</Text>
            {!files && !error && <ActivityIndicator />}
            {!!error && <Text style={{ color: theme.colors.textDestructive }}>{error}</Text>}
            {files?.length === 0 && <Text style={{ color: theme.colors.textSecondary }}>暂无可管理资源</Text>}
            {files?.map(file => <Pressable accessibilityRole="button" key={file.id} onPress={() => openResourceSharing(file.kind, file.id)} style={{ padding: 14, borderRadius: 12, backgroundColor: theme.colors.surfaceHigh, gap: 8 }}>
                <Text numberOfLines={1} style={{ color: theme.colors.text }}>{file.kind === 'session' ? '会话' : file.kind === 'machine' ? '设备' : '文件'} {file.id}</Text>
                <Text style={{ color: theme.colors.textSecondary }}>{file.size === null ? '指定账号共享' : fileSize(file.size)} · {new Date(file.createdAt).toLocaleString()}</Text>
            </Pressable>)}
        </ScrollView>
    </UtilityDialog>;
}
export const openResourceSharingList = (ownerId?: string) => Modal.show({ component: ResourceSharingList, props: { ownerId }, blurBackdrop: true });
