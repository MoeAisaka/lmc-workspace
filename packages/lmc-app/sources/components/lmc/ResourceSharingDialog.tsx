import React from 'react';
import { View, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Switch } from '@/components/Switch';
import { Text } from '@/components/StyledText';
import { Modal } from '@/modal';
import { UtilityDialog } from './UtilityDialog';
import { accountDirectory, accountMe, accountRequest, getSharing, putSharing, type SharingPolicy } from '@/sync/apiAccounts';
import { fileSize } from '@/utils/fileSize';
import { t, getDateLocale } from '@/text';
import { translateLmcServerMessage } from '@/utils/lmc/serverErrorText';

export function ResourceSharingDialog({ kind, id, onClose }: { kind: string; id: string; onClose?: () => void }) {
    const { theme } = useUnistyles();
    const locale = getDateLocale();
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
        try { await work(); } catch (e) { if (active.current) setError(e instanceof Error ? e.message : t('lmc.sharing.actionFailed')); }
        finally { working.current = false; if (active.current) setBusy(false); }
    };
    React.useEffect(() => { active.current = true; void run(load); return () => { active.current = false; }; }, [kind, id]);
    const name = (accountId: string) => members.find(m => m.id === accountId)?.username ?? accountId;
    const disabled = busy || !policy?.canManage || !policy.sharingSupported;
    return <UtilityDialog title={t('lmc.sharing.settingsTitle')} onClose={onClose} maxWidth={580} testID="resource-sharing-dialog">
        <ScrollView contentContainerStyle={{ padding: 20, gap: 18 }}>
            {busy && <ActivityIndicator />}
            {!!error && <Text accessibilityRole="alert" style={{ color: theme.colors.textDestructive }}>{error}</Text>}
            {!!notice && <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.textLink }}>{notice}</Text>}
            {policy && <>
                <Text style={{ fontSize: 20, fontWeight: '600', color: theme.colors.text }}>{policy.grants.length ? t('lmc.sharing.sharedWithAccounts') : t('lmc.sharing.privateOnly')}</Text>
                <Text style={{ color: theme.colors.textSecondary }}>{kind === 'machine' ? t('lmc.sharing.ownerMachineBody', { owner: name(policy.ownerAccountId) }) : kind === 'session' ? t('lmc.sharing.ownerSessionBody', { owner: name(policy.ownerAccountId) }) : t('lmc.sharing.ownerFileBody', { owner: name(policy.ownerAccountId) })}</Text>
                {policy.adminManaged && <Text style={{ color: theme.colors.textSecondary }}>{t('lmc.sharing.adminManagedNotice')}</Text>}
                {policy.unavailableReason && <Text style={{ color: theme.colors.textSecondary }}>{translateLmcServerMessage(policy.unavailableReason) ?? policy.unavailableReason}</Text>}
                {members.filter(m => m.id !== policy.ownerAccountId).map(member => <View key={member.id} style={{ gap: 6 }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 }}>
                    <Text style={{ color: theme.colors.text, flex: 1 }}>{member.username ?? member.id}</Text>
                    <Switch accessibilityLabel={t('lmc.sharing.shareWithMember', { name: member.username ?? member.id })} disabled={disabled} value={policy.grants.some(g => g.accountId === member.id)} onValueChange={checked => setPolicy({ ...policy, grants: checked ? [...policy.grants, { accountId: member.id, actions: ['read'] }] : policy.grants.filter(g => g.accountId !== member.id) })} />
                </View>
                    {(kind === 'session' || kind === 'machine') && policy.grants.some(g => g.accountId === member.id) && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
                        {(kind === 'machine' ? ['execute'] as const : ['send', 'stop', 'approve'] as const).map(action => <View key={action} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Text style={{ color: theme.colors.textSecondary }}>{({ send: t('lmc.sharing.actionSend'), stop: t('lmc.sharing.actionStop'), approve: t('lmc.sharing.actionApprove'), execute: t('lmc.sharing.actionExecute') })[action]}</Text><Switch disabled={disabled} accessibilityLabel={name(member.id) + ' ' + action} value={policy.grants.find(g => g.accountId === member.id)?.actions.includes(action)} onValueChange={checked => setPolicy({ ...policy, grants: policy.grants.map(g => g.accountId !== member.id ? g : { ...g, actions: checked ? [...g.actions, action] : g.actions.filter(a => a !== action) }) })} /></View>)}
                    </View>}
                </View>)}
                {policy.grants.filter(g => !members.some(m => m.id === g.accountId)).map(grant => <View key={grant.accountId} style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Text style={{ flex: 1, color: theme.colors.textSecondary }}>{t('lmc.sharing.disabledAccount', { id: grant.accountId })}</Text>
                    <Pressable accessibilityRole="button" disabled={disabled} onPress={() => setPolicy({ ...policy, grants: policy.grants.filter(g => g.accountId !== grant.accountId) })} style={{ padding: 12 }}><Text style={{ color: theme.colors.textLink }}>{t('lmc.sharing.remove')}</Text></Pressable>
                </View>)}
                {admin && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <Text style={{ flex: 1, color: theme.colors.text }}>{t('lmc.sharing.adminManagedToggle')}</Text>
                    <Switch accessibilityLabel={t('lmc.sharing.adminManagedToggle')} value={policy.adminManaged} disabled={busy || !policy.sharingSupported} onValueChange={value => setPolicy({ ...policy, adminManaged: value })} />
                </View>}
                <Text style={{ color: theme.colors.textSecondary }}>{t('lmc.sharing.revokeHint')}</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
                    <Pressable accessibilityRole="button" disabled={disabled} onPress={() => void run(async () => { await putSharing(policy); await load(); if (active.current) setNotice(t('lmc.sharing.savedNotice')); })} style={{ padding: 14, borderRadius: 12, backgroundColor: theme.colors.surfaceHigh, opacity: disabled ? 0.5 : 1 }}><Text style={{ color: theme.colors.textLink }}>{t('common.save')}</Text></Pressable>
                    <Pressable accessibilityRole="button" disabled={busy} onPress={() => void run(load)} style={{ padding: 14 }}><Text style={{ color: theme.colors.textLink }}>{t('lmc.sharing.reload')}</Text></Pressable>
                </View>
                {!!events.length && <><Text style={{ color: theme.colors.text, fontWeight: '600' }}>{t('lmc.sharing.recentChanges')}</Text>{events.slice(0, 10).map(event => <Text key={event.id} style={{ color: theme.colors.textSecondary }}>{name(event.actorId)} · {new Date(event.createdAt).toLocaleString(locale)}</Text>)}</>}
            </>}
        </ScrollView>
    </UtilityDialog>;
}
export const openResourceSharing = (kind: string, id: string) => Modal.show({ component: ResourceSharingDialog, props: { kind, id }, blurBackdrop: true });

function ResourceSharingList({ ownerId, onClose }: { ownerId?: string; onClose?: () => void }) {
    const { theme } = useUnistyles();
    const locale = getDateLocale();
    const [files, setFiles] = React.useState<Array<{ id: string; kind: string; createdAt: string; size: number | null }> | null>(null);
    const [error, setError] = React.useState('');
    React.useEffect(() => {
        let active = true;
        void accountRequest<{ resources: NonNullable<typeof files> }>('/v1/lmc/sharing/resources' + (ownerId ? '?ownerId=' + encodeURIComponent(ownerId) : '')).then(result => { if (active) setFiles(result.resources); }).catch(e => { if (active) setError(e.message); });
        return () => { active = false; };
    }, [ownerId]);
    return <UtilityDialog title={t('lmc.sharing.resourceSharingTitle')} onClose={onClose} maxWidth={650}>
        <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
            <Text style={{ color: theme.colors.textSecondary }}>{t('lmc.sharing.resourceSharingIntro')}</Text>
            {!files && !error && <ActivityIndicator />}
            {!!error && <Text style={{ color: theme.colors.textDestructive }}>{error}</Text>}
            {files?.length === 0 && <Text style={{ color: theme.colors.textSecondary }}>{t('lmc.sharing.noManageableResources')}</Text>}
            {files?.map(file => <Pressable accessibilityRole="button" key={file.id} onPress={() => openResourceSharing(file.kind, file.id)} style={{ padding: 14, borderRadius: 12, backgroundColor: theme.colors.surfaceHigh, gap: 8 }}>
                <Text numberOfLines={1} style={{ color: theme.colors.text }}>{file.kind === 'session' ? t('lmc.sharing.kindSession') : file.kind === 'machine' ? t('lmc.sharing.kindMachine') : t('lmc.sharing.kindFile')} {file.id}</Text>
                <Text style={{ color: theme.colors.textSecondary }}>{file.size === null ? t('lmc.sharing.sharedWithAccounts') : fileSize(file.size)} · {new Date(file.createdAt).toLocaleString(locale)}</Text>
            </Pressable>)}
        </ScrollView>
    </UtilityDialog>;
}
export const openResourceSharingList = (ownerId?: string) => Modal.show({ component: ResourceSharingList, props: { ownerId }, blurBackdrop: true });
