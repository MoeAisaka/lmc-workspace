import React from 'react';
import { View, ScrollView, ActivityIndicator } from 'react-native';
import { InteractionPressable as Pressable } from '@/components/InteractionPressable';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';
import { Text } from '@/components/StyledText';
import { Modal } from '@/modal';
import { UtilityDialog } from './UtilityDialog';
import { lmcSurfaceBorder } from './elevation';
import { useSettingsNavigation } from './settings/settingsNavigation';
import { accountMe, accountList, accountRequest, accountUpdate, type LmcAccount, type AccountInvitation } from '@/sync/apiAccounts';
import { getServerUrl } from '@/sync/serverConfig';
import { t, getDateLocale } from '@/text';
import { openResourceSharingList } from './ResourceSharingDialog';

type ActionTone = 'primary' | 'secondary' | 'accent' | 'danger';

export function MembersDialog({ onClose }: { onClose?: () => void }) {
    const { theme } = useUnistyles();
    const settingsNav = useSettingsNavigation();
    const locale = getDateLocale();
    const [me, setMe] = React.useState<LmcAccount | null>(null);
    const [members, setMembers] = React.useState<LmcAccount[]>([]);
    const [invites, setInvites] = React.useState<AccountInvitation[]>([]);
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(true);
    const [link, setLink] = React.useState('');
    const [copied, setCopied] = React.useState(false);
    const active = React.useRef(true);
    const working = React.useRef(false);

    const load = async () => {
        const [self, list, invitations] = await Promise.all([
            accountMe(),
            accountList(),
            accountRequest<{ invitations: AccountInvitation[] }>('/v1/lmc/invitations'),
        ]);
        if (active.current) {
            setMe(self.account);
            setMembers(list.accounts);
            setInvites(invitations.invitations);
        }
    };

    const run = async (work: () => Promise<unknown>) => {
        if (working.current) return;
        working.current = true;
        setBusy(true);
        setError('');
        try {
            await work();
        } catch (e) {
            if (active.current) setError(e instanceof Error ? e.message : t('lmc.sharing.actionFailed'));
        } finally {
            working.current = false;
            if (active.current) setBusy(false);
        }
    };

    React.useEffect(() => {
        active.current = true;
        void run(load);
        return () => {
            active.current = false;
        };
    }, []);

    const enabledAdminCount = React.useMemo(
        () => members.filter((m) => m.role === 'admin' && m.enabled).length,
        [members],
    );

    const renderActionButton = (
        label: string,
        action: () => void,
        opts?: { icon?: React.ComponentProps<typeof Ionicons>['name']; tone?: ActionTone; compact?: boolean; disabled?: boolean },
    ) => {
        const tone = opts?.tone ?? 'secondary';
        const compact = opts?.compact ?? false;
        const isDisabled = busy || Boolean(opts?.disabled);
        const bg = (pressed: boolean) => {
            if (tone === 'primary') return pressed ? '#0052CC' : theme.colors.textLink;
            if (tone === 'accent') return pressed ? (theme.dark ? 'rgba(0,96,240,0.26)' : 'rgba(0,96,240,0.12)') : (theme.dark ? 'rgba(0,96,240,0.18)' : 'rgba(0,96,240,0.07)');
            if (tone === 'danger') return pressed ? (theme.dark ? 'rgba(255,69,58,0.22)' : 'rgba(244,67,54,0.11)') : (theme.dark ? 'rgba(255,69,58,0.12)' : 'rgba(244,67,54,0.05)');
            return pressed ? theme.colors.surfacePressed : theme.colors.surface;
        };
        const borderColor =
            tone === 'primary'
                ? theme.colors.textLink
                : tone === 'accent'
                  ? (theme.dark ? 'rgba(82,150,255,0.4)' : 'rgba(0,96,240,0.25)')
                  : tone === 'danger'
                    ? (theme.dark ? 'rgba(255,69,58,0.34)' : 'rgba(244,67,54,0.24)')
                    : theme.colors.divider;
        const fg =
            tone === 'primary'
                ? '#FFFFFF'
                : tone === 'accent'
                  ? (theme.dark ? '#7DB5FF' : theme.colors.textLink)
                  : tone === 'danger'
                    ? theme.colors.textDestructive
                    : theme.colors.text;

        return (
            <Pressable
                accessibilityRole="button"
                disabled={isDisabled}
                onPress={action}
                style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    minHeight: compact ? 32 : 36,
                    minWidth: compact ? 64 : 74,
                    paddingHorizontal: compact ? 12 : 15,
                    paddingVertical: compact ? 5 : 7,
                    borderRadius: compact ? 9 : 10,
                    borderWidth: 1,
                    borderColor,
                    backgroundColor: bg(pressed),
                    opacity: isDisabled ? 0.45 : 1,
                })}
            >
                {opts?.icon ? <Ionicons name={opts.icon} size={compact ? 14 : 16} color={fg} /> : null}
                <Text style={{ fontSize: compact ? 12.5 : 13.5, lineHeight: compact ? 18 : 20, fontWeight: tone === 'primary' ? '600' : '500', color: fg }}>
                    {label}
                </Text>
            </Pressable>
        );
    };

    const renderBadge = (label: string, tone: 'blue' | 'neutral' | 'danger' | 'green') => {
        const palette = {
            blue: {
                bg: theme.dark ? 'rgba(0,96,240,0.22)' : 'rgba(0,96,240,0.09)',
                fg: theme.dark ? '#85BAFF' : '#0055D4',
                border: theme.dark ? 'rgba(82,150,255,0.34)' : 'rgba(0,96,240,0.18)',
            },
            green: {
                bg: theme.dark ? 'rgba(50,215,75,0.18)' : 'rgba(52,199,89,0.11)',
                fg: theme.dark ? '#6EE787' : '#1A7F37',
                border: theme.dark ? 'rgba(50,215,75,0.3)' : 'rgba(52,199,89,0.24)',
            },
            danger: {
                bg: theme.dark ? 'rgba(255,69,58,0.18)' : 'rgba(244,67,54,0.09)',
                fg: theme.colors.textDestructive,
                border: theme.dark ? 'rgba(255,69,58,0.32)' : 'rgba(244,67,54,0.22)',
            },
            neutral: {
                bg: theme.dark ? 'rgba(255,255,255,0.07)' : 'rgba(16,24,40,0.05)',
                fg: theme.colors.textSecondary,
                border: theme.colors.divider,
            },
        }[tone];
        return (
            <View
                style={{
                    paddingHorizontal: 8,
                    paddingVertical: 2,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: palette.border,
                    backgroundColor: palette.bg,
                }}
            >
                <Text style={{ fontSize: 11.5, fontWeight: '600', color: palette.fg }}>{label}</Text>
            </View>
        );
    };

    const update = async (member: LmcAccount, patch: Pick<LmcAccount, 'role' | 'enabled'>) => {
        if (!await Modal.confirm(t('lmc.sharing.updateMemberConfirmTitle'), t('lmc.sharing.updateMemberConfirmBody'), { confirmText: t('lmc.sharing.applyChanges') })) return;
        await run(async () => {
            await accountUpdate(member, patch);
            await load();
        });
    };

    const copyLink = async () => {
        if (!link) return;
        await Clipboard.setStringAsync(link);
        if (active.current) {
            setCopied(true);
            setTimeout(() => {
                if (active.current) setCopied(false);
            }, 2000);
        }
    };

    const cardBg = theme.dark ? theme.colors.surfaceHigh : '#F8F9FB';

    return (
        <UtilityDialog title={t('lmc.sharing.membersTitle')} onClose={onClose} maxWidth={700} testID="members-dialog">
            <ScrollView contentContainerStyle={{ padding: 20, gap: 18 }}>
                <View
                    style={{
                        padding: 16,
                        borderRadius: 14,
                        backgroundColor: cardBg,
                        gap: 14,
                        ...lmcSurfaceBorder(theme),
                    }}
                >
                    <Text style={{ fontSize: 13.5, lineHeight: 20, color: theme.colors.textSecondary }}>
                        {t('lmc.sharing.membersIntro')}
                    </Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
                        {renderActionButton(
                            t('lmc.sharing.inviteMember'),
                            () =>
                                void run(async () => {
                                    const invitation = await accountRequest<AccountInvitation>('/v1/lmc/invitations', { method: 'POST' });
                                    if (invitation.token && active.current) {
                                        setCopied(false);
                                        setLink(getServerUrl().replace(/\/$/, '') + '/#lmc-invite=' + encodeURIComponent(invitation.token));
                                    }
                                    await load();
                                }),
                            { icon: 'person-add-outline', tone: 'primary' },
                        )}
                        {renderActionButton(t('lmc.sharing.refresh'), () => void run(load), { icon: 'refresh-outline', tone: 'secondary' })}
                        {busy ? <ActivityIndicator style={{ marginLeft: 4 }} /> : null}
                    </View>
                </View>

                {!!error && (
                    <View
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 10,
                            paddingVertical: 11,
                            paddingHorizontal: 14,
                            borderRadius: 12,
                            borderWidth: 1,
                            borderColor: theme.dark ? 'rgba(255,69,58,0.34)' : 'rgba(244,67,54,0.24)',
                            backgroundColor: theme.dark ? 'rgba(255,69,58,0.14)' : 'rgba(244,67,54,0.07)',
                        }}
                    >
                        <Ionicons name="alert-circle-outline" size={18} color={theme.colors.textDestructive} />
                        <Text accessibilityRole="alert" style={{ flex: 1, fontSize: 13, lineHeight: 19, color: theme.colors.textDestructive }}>
                            {error}
                        </Text>
                    </View>
                )}

                {!!link && (
                    <View
                        style={{
                            padding: 15,
                            borderRadius: 14,
                            borderWidth: 1,
                            borderColor: theme.dark ? 'rgba(82,150,255,0.36)' : 'rgba(0,96,240,0.2)',
                            backgroundColor: theme.dark ? 'rgba(0,96,240,0.12)' : 'rgba(0,96,240,0.045)',
                            gap: 10,
                        }}
                    >
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <Ionicons name="link-outline" size={17} color={theme.dark ? '#85BAFF' : theme.colors.textLink} />
                            <Text style={{ flex: 1, fontSize: 13, lineHeight: 19, color: theme.colors.text }}>
                                {t('lmc.sharing.inviteNotice')}
                            </Text>
                        </View>
                        <View
                            style={{
                                paddingVertical: 9,
                                paddingHorizontal: 12,
                                borderRadius: 10,
                                borderWidth: 1,
                                borderColor: theme.colors.divider,
                                backgroundColor: theme.colors.surface,
                            }}
                        >
                            <Text selectable style={{ fontSize: 12.5, lineHeight: 18, color: theme.colors.textSecondary }}>
                                {link}
                            </Text>
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            {renderActionButton(
                                copied ? t('lmc.sharing.inviteCopied') : t('lmc.sharing.copyInviteLink'),
                                () => void copyLink(),
                                { icon: copied ? 'checkmark-outline' : 'copy-outline', tone: 'accent', compact: true },
                            )}
                        </View>
                    </View>
                )}

                <View style={{ gap: 10 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Text style={{ fontSize: 14, fontWeight: '600', color: theme.colors.text }}>
                            {t('lmc.sharing.membersSection')}
                        </Text>
                        {renderBadge(String(members.length), 'neutral')}
                    </View>

                    <View style={{ gap: 10 }}>
                        {members.map((member) => {
                            const displayName = member.username ?? member.id;
                            const initial = [...displayName.trim()].slice(0, 1).join('').toUpperCase() || '?';
                            const isSelf = member.id === me?.id;
                            const isSoleEnabledAdmin = member.role === 'admin' && member.enabled && enabledAdminCount <= 1;
                            const avatarBg = !member.enabled
                                ? (theme.dark ? 'rgba(255,255,255,0.08)' : 'rgba(16,24,40,0.06)')
                                : member.role === 'admin'
                                  ? (theme.dark ? 'rgba(0,96,240,0.24)' : 'rgba(0,96,240,0.1)')
                                  : (theme.dark ? 'rgba(255,255,255,0.1)' : 'rgba(16,24,40,0.07)');
                            const avatarFg = !member.enabled
                                ? theme.colors.textSecondary
                                : member.role === 'admin'
                                  ? (theme.dark ? '#85BAFF' : '#0055D4')
                                  : theme.colors.text;

                            return (
                                <View
                                    key={member.id}
                                    style={{
                                        padding: 14,
                                        borderRadius: 14,
                                        backgroundColor: cardBg,
                                        gap: 12,
                                        opacity: member.enabled ? 1 : 0.84,
                                        ...lmcSurfaceBorder(theme),
                                    }}
                                >
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                                        <View
                                            style={{
                                                width: 38,
                                                height: 38,
                                                borderRadius: 19,
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                backgroundColor: avatarBg,
                                            }}
                                        >
                                            <Text style={{ fontSize: 15, fontWeight: '700', color: avatarFg }}>{initial}</Text>
                                        </View>
                                        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                                                <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: theme.colors.text }}>
                                                    {displayName}
                                                </Text>
                                                {isSelf ? renderBadge(t('lmc.sharing.meBadge'), 'neutral') : null}
                                                {renderBadge(
                                                    member.role === 'admin' ? t('lmc.sharing.roleAdmin') : t('lmc.sharing.roleMember'),
                                                    member.role === 'admin' ? 'blue' : 'neutral',
                                                )}
                                                {!member.enabled ? renderBadge(t('lmc.sharing.disabledBadge'), 'danger') : null}
                                            </View>
                                        </View>
                                    </View>

                                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                                        {renderActionButton(
                                            t('lmc.sharing.sharedResources'),
                                            () =>
                                                settingsNav
                                                    ? settingsNav.openResourceSharingList(member.id, displayName)
                                                    : openResourceSharingList(member.id),
                                            { icon: 'share-social-outline', tone: 'secondary', compact: true },
                                        )}
                                        {renderActionButton(
                                            member.role === 'admin' ? t('lmc.sharing.makeMember') : t('lmc.sharing.makeAdmin'),
                                            () => void update(member, { role: member.role === 'admin' ? 'member' : 'admin', enabled: member.enabled }),
                                            {
                                                icon: 'shield-outline',
                                                tone: 'secondary',
                                                compact: true,
                                                disabled: isSoleEnabledAdmin,
                                            },
                                        )}
                                        {renderActionButton(
                                            member.enabled ? t('lmc.sharing.disable') : t('lmc.sharing.enable'),
                                            () => void update(member, { role: member.role, enabled: !member.enabled }),
                                            {
                                                icon: member.enabled ? 'pause-circle-outline' : 'play-circle-outline',
                                                tone: member.enabled ? 'danger' : 'accent',
                                                compact: true,
                                                disabled: isSoleEnabledAdmin,
                                            },
                                        )}
                                    </View>
                                </View>
                            );
                        })}
                    </View>
                </View>

                <View style={{ gap: 10 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Text style={{ fontSize: 14, fontWeight: '600', color: theme.colors.text }}>
                            {t('lmc.sharing.inviteHistory')}
                        </Text>
                        {invites.length > 0 ? renderBadge(String(invites.length), 'neutral') : null}
                    </View>

                    {invites.length === 0 ? (
                        <View
                            style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                gap: 10,
                                paddingVertical: 16,
                                paddingHorizontal: 14,
                                borderRadius: 13,
                                backgroundColor: cardBg,
                                ...lmcSurfaceBorder(theme),
                            }}
                        >
                            <Ionicons name="mail-open-outline" size={18} color={theme.colors.textSecondary} />
                            <Text style={{ flex: 1, fontSize: 13, lineHeight: 19, color: theme.colors.textSecondary }}>
                                {t('lmc.sharing.inviteHistoryEmpty')}
                            </Text>
                        </View>
                    ) : (
                        <View
                            style={{
                                borderRadius: 14,
                                overflow: 'hidden',
                                backgroundColor: cardBg,
                                ...lmcSurfaceBorder(theme),
                            }}
                        >
                            {invites.map((invite, idx) => {
                                const valid = !invite.consumedAt && !invite.revokedAt && new Date(invite.expiresAt).getTime() > Date.now();
                                const statusLabel = invite.consumedAt
                                    ? t('lmc.sharing.inviteUsed')
                                    : invite.revokedAt
                                      ? t('lmc.sharing.inviteRevoked')
                                      : valid
                                        ? t('lmc.sharing.invitePending')
                                        : t('lmc.sharing.inviteExpired');
                                const statusTone = valid ? 'green' : invite.consumedAt ? 'blue' : 'neutral';

                                return (
                                    <View
                                        key={invite.id}
                                        style={{
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            gap: 10,
                                            paddingVertical: 12,
                                            paddingHorizontal: 14,
                                            borderTopWidth: idx === 0 ? 0 : 1,
                                            borderTopColor: theme.colors.divider,
                                        }}
                                    >
                                        {renderBadge(statusLabel, statusTone)}
                                        <Text style={{ flex: 1, fontSize: 13, color: theme.colors.textSecondary }}>
                                            {new Date(invite.expiresAt).toLocaleString(locale)}
                                        </Text>
                                        {valid
                                            ? renderActionButton(
                                                  t('lmc.sharing.revoke'),
                                                  () =>
                                                      void run(async () => {
                                                          await accountRequest('/v1/lmc/invitations/' + invite.id, { method: 'DELETE' });
                                                          setLink('');
                                                          await load();
                                                      }),
                                                  { icon: 'close-circle-outline', tone: 'danger', compact: true },
                                              )
                                            : null}
                                    </View>
                                );
                            })}
                        </View>
                    )}
                </View>
            </ScrollView>
        </UtilityDialog>
    );
}

export const openMembers = () => Modal.show({ component: MembersDialog, props: {}, blurBackdrop: true });
