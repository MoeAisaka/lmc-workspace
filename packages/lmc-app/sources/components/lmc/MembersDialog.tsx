import React from 'react';
import { View, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';
import { Text } from '@/components/StyledText';
import { Modal } from '@/modal';
import { UtilityDialog } from './UtilityDialog';
import { accountMe, accountList, accountRequest, accountUpdate, type LmcAccount, type AccountInvitation } from '@/sync/apiAccounts';
import { getServerUrl } from '@/sync/serverConfig';
import { t, getDateLocale } from '@/text';
import { openResourceSharingList } from './ResourceSharingDialog';

export function MembersDialog({ onClose }: { onClose?: () => void }) {
    const { theme } = useUnistyles();
    const locale = getDateLocale();
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
        catch (e) { if (active.current) setError(e instanceof Error ? e.message : t('lmc.sharing.actionFailed')); }
        finally { working.current = false; if (active.current) setBusy(false); }
    };
    React.useEffect(() => { active.current = true; void run(load); return () => { active.current = false; }; }, []);
    const button = (label: string, action: () => void) => <Pressable accessibilityRole="button" disabled={busy} onPress={action} style={{ padding: 10, minHeight: 44, justifyContent: 'center', opacity: busy ? 0.5 : 1 }}><Text style={{ color: theme.colors.textLink }}>{label}</Text></Pressable>;
    const update = async (member: LmcAccount, patch: Pick<LmcAccount, 'role' | 'enabled'>) => {
        if (!await Modal.confirm(t('lmc.sharing.updateMemberConfirmTitle'), t('lmc.sharing.updateMemberConfirmBody'), { confirmText: t('lmc.sharing.applyChanges') })) return;
        await run(async () => { await accountUpdate(member, patch); await load(); });
    };
    return <UtilityDialog title={t('lmc.sharing.membersTitle')} onClose={onClose} maxWidth={720} testID="members-dialog">
        <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
            <Text style={{ color: theme.colors.textSecondary }}>{t('lmc.sharing.membersIntro')}</Text>
            <View style={{ flexDirection: 'row', gap: 12 }}>{button(t('lmc.sharing.inviteMember'), () => void run(async () => {
                const invitation = await accountRequest<AccountInvitation>('/v1/lmc/invitations', { method: 'POST' });
                if (invitation.token && active.current) setLink(getServerUrl().replace(/\/$/, '') + '/#lmc-invite=' + encodeURIComponent(invitation.token));
                await load();
            }))}{button(t('lmc.sharing.refresh'), () => void run(load))}{busy && <ActivityIndicator />}</View>
            {!!error && <Text accessibilityRole="alert" style={{ color: theme.colors.textDestructive }}>{error}</Text>}
            {!!link && <View style={{ padding: 14, borderRadius: 12, backgroundColor: theme.colors.surfaceHigh, gap: 8 }}>
                <Text style={{ color: theme.colors.text }}>{t('lmc.sharing.inviteNotice')}</Text>
                <Text selectable style={{ color: theme.colors.textSecondary }}>{link}</Text>
                {button(t('lmc.sharing.copyInviteLink'), () => void Clipboard.setStringAsync(link))}
            </View>}
            {members.map(member => <View key={member.id} style={{ borderBottomWidth: 1, borderColor: theme.colors.divider, paddingBottom: 12, gap: 6 }}>
                <Text style={{ color: theme.colors.text, fontWeight: '600' }}>{member.username ?? member.id}{member.id === me?.id ? t('lmc.sharing.meSuffix') : ''} · {member.role === 'admin' ? t('lmc.sharing.roleAdmin') : t('lmc.sharing.roleMember')}{member.enabled ? '' : t('lmc.sharing.disabledSuffix')}</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {button(t('lmc.sharing.sharedResources'), () => openResourceSharingList(member.id))}
                    {button(member.role === 'admin' ? t('lmc.sharing.makeMember') : t('lmc.sharing.makeAdmin'), () => void update(member, { role: member.role === 'admin' ? 'member' : 'admin', enabled: member.enabled }))}
                    {button(member.enabled ? t('lmc.sharing.disable') : t('lmc.sharing.enable'), () => void update(member, { role: member.role, enabled: !member.enabled }))}
                </View>
            </View>)}
            <Text style={{ fontWeight: '600', color: theme.colors.text }}>{t('lmc.sharing.inviteHistory')}</Text>
            {invites.map(invite => {
                const valid = !invite.consumedAt && !invite.revokedAt && new Date(invite.expiresAt).getTime() > Date.now();
                return <View key={invite.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={{ flex: 1, color: theme.colors.textSecondary }}>{invite.consumedAt ? t('lmc.sharing.inviteUsed') : invite.revokedAt ? t('lmc.sharing.inviteRevoked') : valid ? t('lmc.sharing.invitePending') : t('lmc.sharing.inviteExpired')} · {new Date(invite.expiresAt).toLocaleString(locale)}</Text>
                    {valid && button(t('lmc.sharing.revoke'), () => void run(async () => { await accountRequest('/v1/lmc/invitations/' + invite.id, { method: 'DELETE' }); setLink(''); await load(); }))}
                </View>;
            })}
        </ScrollView>
    </UtilityDialog>;
}
export const openMembers = () => Modal.show({ component: MembersDialog, props: {}, blurBackdrop: true });
