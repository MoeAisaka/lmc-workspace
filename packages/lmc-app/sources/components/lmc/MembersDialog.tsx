import React from 'react';
import { View, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';
import { Text } from '@/components/StyledText';
import { Modal } from '@/modal';
import { UtilityDialog } from './UtilityDialog';
import { accountMe, accountList, accountRequest, accountUpdate, type LmcAccount, type AccountInvitation } from '@/sync/apiAccounts';
import { getServerUrl } from '@/sync/serverConfig';
import { openResourceSharingList } from './ResourceSharingDialog';

export function MembersDialog({ onClose }: { onClose?: () => void }) {
    const { theme } = useUnistyles();
    const [me, setMe] = React.useState<LmcAccount | null>(null);
    const [members, setMembers] = React.useState<LmcAccount[]>([]);
    const [invites, setInvites] = React.useState<AccountInvitation[]>([]);
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(true);
    const [link, setLink] = React.useState('');
    const active = React.useRef(true), working = React.useRef(false);
    const load = async () => {
        const [self, list, invitations] = await Promise.all([accountMe(), accountList(), accountRequest<{ invitations: AccountInvitation[] }>('/v1/lmc/invitations')]);
        if (active.current) { setMe(self.account); setMembers(list.accounts); setInvites(invitations.invitations); }
    };
    const run = async (work: () => Promise<unknown>) => {
        if (working.current) return;
        working.current = true; setBusy(true); setError('');
        try { await work(); }
        catch (e) { if (active.current) setError(e instanceof Error ? e.message : '操作失败'); }
        finally { working.current = false; if (active.current) setBusy(false); }
    };
    React.useEffect(() => { active.current = true; void run(load); return () => { active.current = false; }; }, []);
    const button = (label: string, action: () => void) => <Pressable accessibilityRole="button" disabled={busy} onPress={action} style={{ padding: 10, minHeight: 44, justifyContent: 'center', opacity: busy ? 0.5 : 1 }}><Text style={{ color: theme.colors.textLink }}>{label}</Text></Pressable>;
    const update = async (member: LmcAccount, patch: Pick<LmcAccount, 'role' | 'enabled'>) => {
        if (!await Modal.confirm('修改成员权限', '角色或状态变更会使该账号的现有登录和设备授权失效，需要重新登录。现有会话内容会保留。', { confirmText: '应用修改' })) return;
        await run(async () => { await accountUpdate(member, patch); await load(); });
    };
    return <UtilityDialog title="成员与权限" onClose={onClose} maxWidth={720} testID="members-dialog">
        <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
            <Text style={{ color: theme.colors.textSecondary }}>成员管理自己的资源共享；管理员可设置成员共享。新成员不会自动获得已有设备、会话或模型账号。</Text>
            <View style={{ flexDirection: 'row', gap: 12 }}>{button('邀请成员', () => void run(async () => {
                const invitation = await accountRequest<AccountInvitation>('/v1/lmc/invitations', { method: 'POST' });
                if (invitation.token && active.current) setLink(getServerUrl().replace(/\/$/, '') + '/#lmc-invite=' + encodeURIComponent(invitation.token));
                await load();
            }))}{button('刷新', () => void run(load))}{busy && <ActivityIndicator />}</View>
            {!!error && <Text accessibilityRole="alert" style={{ color: theme.colors.textDestructive }}>{error}</Text>}
            {!!link && <View style={{ padding: 14, borderRadius: 12, backgroundColor: theme.colors.surfaceHigh, gap: 8 }}>
                <Text style={{ color: theme.colors.text }}>邀请有效期 24 小时，只能加入一次。新成员自行设置密码。</Text>
                <Text selectable style={{ color: theme.colors.textSecondary }}>{link}</Text>
                {button('复制邀请链接', () => void Clipboard.setStringAsync(link))}
            </View>}
            {members.map(member => <View key={member.id} style={{ borderBottomWidth: 1, borderColor: theme.colors.divider, paddingBottom: 12, gap: 6 }}>
                <Text style={{ color: theme.colors.text, fontWeight: '600' }}>{member.username ?? member.id}{member.id === me?.id ? '（我）' : ''} · {member.role === 'admin' ? '管理员' : '成员'}{member.enabled ? '' : ' · 已停用'}</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {button('共享资源', () => openResourceSharingList(member.id))}
                    {button(member.role === 'admin' ? '设为成员' : '设为管理员', () => void update(member, { role: member.role === 'admin' ? 'member' : 'admin', enabled: member.enabled }))}
                    {button(member.enabled ? '停用' : '恢复', () => void update(member, { role: member.role, enabled: !member.enabled }))}
                </View>
            </View>)}
            <Text style={{ fontWeight: '600', color: theme.colors.text }}>邀请记录</Text>
            {invites.map(invite => {
                const valid = !invite.consumedAt && !invite.revokedAt && new Date(invite.expiresAt).getTime() > Date.now();
                return <View key={invite.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={{ flex: 1, color: theme.colors.textSecondary }}>{invite.consumedAt ? '已使用' : invite.revokedAt ? '已撤销' : valid ? '待加入' : '已过期'} · {new Date(invite.expiresAt).toLocaleString()}</Text>
                    {valid && button('撤销', () => void run(async () => { await accountRequest('/v1/lmc/invitations/' + invite.id, { method: 'DELETE' }); setLink(''); await load(); }))}
                </View>;
            })}
        </ScrollView>
    </UtilityDialog>;
}
export const openMembers = () => Modal.show({ component: MembersDialog, props: {}, blurBackdrop: true });
