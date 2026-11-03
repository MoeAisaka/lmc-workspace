import React from 'react';
import { View, ScrollView, Pressable, ActivityIndicator, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Switch } from '@/components/Switch';
import { Text } from '@/components/StyledText';
import { FileIcon } from '@/components/FileIcon';
import { Modal } from '@/modal';
import { UtilityDialog } from './UtilityDialog';
import { lmcSurfaceBorder } from './elevation';
import { useSettingsNavigation } from './settings/settingsNavigation';
import {
    accountDirectory,
    accountMe,
    accountRequest,
    getSharing,
    putSharing,
    type ShareableResourceSummary,
    type SharingPolicy,
} from '@/sync/apiAccounts';
import { getFileAsset, listFileAssets } from '@/sync/apiFileAssets';
import { storage, useAllMachines, useAllSessions, useMachine, useSession } from '@/sync/storage';
import type { Machine, Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { isSessionArchived } from '@/sync/sessionArchive';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { fileSize } from '@/utils/fileSize';
import { formatPathRelativeToHome, getSessionName } from '@/utils/sessionUtils';
import { machineDisplayName } from '@/utils/lmc/deviceEngineGroups';
import { t, getDateLocale } from '@/text';
import { translateLmcServerMessage } from '@/utils/lmc/serverErrorText';

export type ResourceFilterKind = 'all' | 'shared' | 'session' | 'machine' | 'file';

export interface ManagedResourceDescriptor {
    kind: string;
    id: string;
    shortId: string;
    title: string;
    contextLine: string;
    fileName?: string;
    isOnline: boolean;
    isArchived: boolean;
    sortTimestamp: number;
    searchText: string;
}

export function shortenResourceId(id: string): string {
    if (!id || id.length <= 14) return id;
    return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function engineDisplayLabel(flavor?: string | null): string | null {
    if (!flavor) return null;
    if (flavor === 'codex') return 'Codex';
    if (flavor === 'claude') return 'Claude Code';
    if (flavor === 'agy' || flavor === 'antigravity') return 'Antigravity';
    return flavor;
}

export function describeManagedResource(
    item: Pick<ShareableResourceSummary, 'id' | 'kind' | 'createdAt' | 'updatedAt' | 'active' | 'size'>,
    lookups: {
        sessionsById: Record<string, Session | undefined>;
        machinesById: Record<string, Machine | undefined>;
        filesById: Record<string, { name: string; size: number } | undefined>;
        sharedMachinesById?: Record<string, { name: string; platform: string; active: boolean } | undefined>;
    },
): ManagedResourceDescriptor {
    const shortId = shortenResourceId(item.id);
    const createdMs = Date.parse(item.createdAt) || 0;
    const updatedMs = (item.updatedAt ? Date.parse(item.updatedAt) : 0) || createdMs;

    if (item.kind === 'session') {
        const session = lookups.sessionsById[item.id];
        if (session) {
            const title = getSessionName(session);
            const machine = session.metadata?.machineId ? lookups.machinesById[session.metadata.machineId] : undefined;
            const host = machine
                ? machineDisplayName(machine, session.metadata?.host || '')
                : (session.metadata?.host?.trim() || '');
            const engine = engineDisplayLabel(session.metadata?.flavor);
            const path = session.metadata?.path?.trim()
                ? formatPathRelativeToHome(session.metadata.path, session.metadata.homeDir)
                : '';
            const contextParts = [host, engine, path].filter(Boolean);
            const isOnline = Boolean(session.active ?? item.active);
            const isArchived = isSessionArchived(session);
            const activityMs = session.metadata?.lastMeaningfulMessageAt || session.updatedAt || updatedMs;
            return {
                kind: item.kind,
                id: item.id,
                shortId,
                title,
                contextLine: contextParts.join(' · '),
                isOnline,
                isArchived,
                sortTimestamp: activityMs,
                searchText: [title, host, engine, path, item.id].filter(Boolean).join(' ').toLowerCase(),
            };
        }
        const fallbackTitle = t('lmc.sharing.encryptedMemberSession');
        return {
            kind: item.kind,
            id: item.id,
            shortId,
            title: fallbackTitle,
            contextLine: shortId,
            isOnline: Boolean(item.active),
            isArchived: false,
            sortTimestamp: updatedMs,
            searchText: `${fallbackTitle} ${item.id}`.toLowerCase(),
        };
    }

    if (item.kind === 'machine') {
        const machine = lookups.machinesById[item.id];
        const sharedMachine = lookups.sharedMachinesById?.[item.id];
        if (machine || sharedMachine) {
            const title = machine
                ? machineDisplayName(machine, sharedMachine?.name || shortId)
                : (sharedMachine!.name || shortId);
            const platform = machine?.metadata?.platform || sharedMachine?.platform || '';
            const isOnline = Boolean(machine ? machine.active : sharedMachine?.active ?? item.active);
            const contextParts = [
                platform,
                isOnline ? t('lmc.sharing.onlineBadge') : t('lmc.list.offline'),
            ].filter(Boolean);
            return {
                kind: item.kind,
                id: item.id,
                shortId,
                title,
                contextLine: contextParts.join(' · '),
                isOnline,
                isArchived: false,
                sortTimestamp: (machine?.updatedAt ?? updatedMs),
                searchText: [title, platform, item.id].filter(Boolean).join(' ').toLowerCase(),
            };
        }
        const fallbackTitle = t('lmc.sharing.encryptedMemberDevice');
        return {
            kind: item.kind,
            id: item.id,
            shortId,
            title: fallbackTitle,
            contextLine: shortId,
            isOnline: Boolean(item.active),
            isArchived: false,
            sortTimestamp: updatedMs,
            searchText: `${fallbackTitle} ${item.id}`.toLowerCase(),
        };
    }

    const knownFile = lookups.filesById[item.id];
    const sizeText = item.size !== null ? fileSize(item.size) : (knownFile ? fileSize(knownFile.size) : '');
    if (knownFile) {
        return {
            kind: item.kind,
            id: item.id,
            shortId,
            title: knownFile.name,
            fileName: knownFile.name,
            contextLine: sizeText,
            isOnline: false,
            isArchived: false,
            sortTimestamp: createdMs,
            searchText: `${knownFile.name} ${sizeText} ${item.id}`.toLowerCase(),
        };
    }
    const fallbackFileTitle = t('lmc.sharing.encryptedMemberFile');
    return {
        kind: item.kind,
        id: item.id,
        shortId,
        title: fallbackFileTitle,
        contextLine: [sizeText, shortId].filter(Boolean).join(' · '),
        isOnline: false,
        isArchived: false,
        sortTimestamp: createdMs,
        searchText: `${fallbackFileTitle} ${sizeText} ${item.id}`.toLowerCase(),
    };
}

export function formatGrantSummary(
    kind: string,
    grants: Array<{ accountId: string; actions: string[] }> | undefined,
    memberNameOf: (accountId: string) => string,
): string {
    if (!grants || grants.length === 0) return t('lmc.sharing.notSharedYet');
    const targets = grants.map((grant) => {
        const who = memberNameOf(grant.accountId);
        if (kind === 'session') {
            const extras = [
                grant.actions.includes('send') ? t('lmc.sharing.actionSend') : null,
                grant.actions.includes('stop') ? t('lmc.sharing.actionStop') : null,
                grant.actions.includes('approve') ? t('lmc.sharing.actionApprove') : null,
            ].filter(Boolean);
            return extras.length > 0
                ? `${who}（${extras.join('/')}）`
                : `${who}（${t('lmc.sharing.badgeReadOnly')}）`;
        }
        if (kind === 'machine') {
            return grant.actions.includes('execute')
                ? `${who}（${t('lmc.sharing.actionExecute')}）`
                : `${who}（${t('lmc.sharing.viewOnly')}）`;
        }
        return who;
    });
    return t('lmc.sharing.sharedRecipientsSummary', { targets: targets.join('、') });
}

const KIND_PRIORITY: Record<string, number> = { session: 0, machine: 1, file: 2 };

export function sortAndFilterManagedResources<T extends ShareableResourceSummary>(
    items: T[],
    descriptors: Map<string, ManagedResourceDescriptor>,
    grantsByKey: Record<string, Array<{ accountId: string; actions: string[] }> | undefined>,
    memberNameOf: (accountId: string) => string,
    filter: ResourceFilterKind,
    query: string,
): T[] {
    const q = query.trim().toLowerCase();
    return items
        .filter((item) => {
            const key = `${item.kind}:${item.id}`;
            const grants = grantsByKey[key] ?? item.grants;
            if (filter === 'shared' && (!grants || grants.length === 0)) return false;
            if (filter === 'session' && item.kind !== 'session') return false;
            if (filter === 'machine' && item.kind !== 'machine') return false;
            if (filter === 'file' && item.kind !== 'file') return false;
            if (!q) return true;
            const desc = descriptors.get(key);
            const grantNames = (grants ?? []).map((g) => memberNameOf(g.accountId).toLowerCase()).join(' ');
            return Boolean(
                (desc && desc.searchText.includes(q))
                || grantNames.includes(q)
                || item.id.toLowerCase().includes(q),
            );
        })
        .sort((a, b) => {
            const keyA = `${a.kind}:${a.id}`;
            const keyB = `${b.kind}:${b.id}`;
            const sharedA = (grantsByKey[keyA] ?? a.grants)?.length ? 1 : 0;
            const sharedB = (grantsByKey[keyB] ?? b.grants)?.length ? 1 : 0;
            if (sharedA !== sharedB) return sharedB - sharedA;

            const descA = descriptors.get(keyA);
            const descB = descriptors.get(keyB);
            if (filter === 'all') {
                const prioA = KIND_PRIORITY[a.kind] ?? 3;
                const prioB = KIND_PRIORITY[b.kind] ?? 3;
                if (prioA !== prioB) return prioA - prioB;
            }
            if ((descA?.isOnline ? 1 : 0) !== (descB?.isOnline ? 1 : 0) && a.kind === b.kind) {
                return (descB?.isOnline ? 1 : 0) - (descA?.isOnline ? 1 : 0);
            }
            const timeDiff = (descB?.sortTimestamp ?? 0) - (descA?.sortTimestamp ?? 0);
            if (timeDiff !== 0) return timeDiff;
            return a.id.localeCompare(b.id);
        });
}

function renderStatusPill(
    label: string,
    tone: 'blue' | 'green' | 'neutral' | 'danger',
    dark: boolean,
    colors: { textLink: string; textSecondary: string; textDestructive: string },
) {
    const palette =
        tone === 'blue'
            ? {
                bg: dark ? 'rgba(0,96,240,0.22)' : 'rgba(0,96,240,0.09)',
                fg: dark ? '#7DB5FF' : colors.textLink,
            }
            : tone === 'green'
              ? {
                  bg: dark ? 'rgba(52,199,89,0.2)' : 'rgba(52,199,89,0.11)',
                  fg: dark ? '#63E683' : '#1E8E3E',
              }
              : tone === 'danger'
                ? {
                    bg: dark ? 'rgba(255,69,58,0.2)' : 'rgba(244,67,54,0.1)',
                    fg: colors.textDestructive,
                }
                : {
                    bg: dark ? 'rgba(255,255,255,0.08)' : 'rgba(17,24,39,0.06)',
                    fg: colors.textSecondary,
                };
    return (
        <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: palette.bg }}>
            <Text style={{ fontSize: 11, lineHeight: 15, fontWeight: '600', color: palette.fg }}>{label}</Text>
        </View>
    );
}

export function ResourceSharingDialog({
    kind,
    id,
    onClose,
    onSaved,
}: {
    kind: string;
    id: string;
    onClose?: () => void;
    onSaved?: (policy: SharingPolicy) => void;
}) {
    const { theme } = useUnistyles();
    const settingsNav = useSettingsNavigation();
    const locale = getDateLocale();
    const navigateToSession = useNavigateToSession();
    const session = useSession(kind === 'session' ? id : '');
    const machine = useMachine(kind === 'machine' ? id : '');
    const sessionMachine = useMachine(session?.metadata?.machineId ?? '');
    const [fileMeta, setFileMeta] = React.useState<{ name: string; size: number } | null>(null);
    const [policy, setPolicy] = React.useState<SharingPolicy | null>(null);
    const [members, setMembers] = React.useState<Array<{ id: string; username: string | null }>>([]);
    const [admin, setAdmin] = React.useState(false);
    const [busy, setBusy] = React.useState(true);
    const [error, setError] = React.useState('');
    const [notice, setNotice] = React.useState('');
    const [events, setEvents] = React.useState<Array<{ id: string; actorId: string; createdAt: string }>>([]);
    const active = React.useRef(true);
    const working = React.useRef(false);

    const load = async () => {
        const [next, directory, self, audit] = await Promise.all([
            getSharing(kind, id),
            accountDirectory(),
            accountMe(),
            accountRequest<{ events: Array<{ id: string; actorId: string; createdAt: string }> }>(
                '/v1/lmc/sharing/' + kind + '/' + encodeURIComponent(id) + '/audit',
            ),
        ]);
        if (active.current) {
            setPolicy(next);
            setMembers(directory.accounts);
            setAdmin(self.account.role === 'admin');
            setEvents(audit.events);
        }
        return next;
    };

    const run = async (work: () => Promise<unknown>) => {
        if (working.current) return;
        working.current = true;
        setBusy(true);
        setError('');
        setNotice('');
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
        if (kind === 'session' && !storage.getState().sessions[id]) {
            void sync.ensureSessionsLoaded([id]);
        }
        if (kind === 'file') {
            void getFileAsset(id)
                .then((asset) => {
                    if (active.current) setFileMeta({ name: asset.manifest.name, size: asset.manifest.size });
                })
                .catch(() => {});
        }
        return () => {
            active.current = false;
        };
    }, [kind, id]);

    const descriptor = React.useMemo(
        () =>
            describeManagedResource(
                {
                    id,
                    kind,
                    createdAt: new Date().toISOString(),
                    size: fileMeta?.size ?? null,
                },
                {
                    sessionsById: session ? { [id]: session } : {},
                    machinesById: {
                        ...(machine ? { [id]: machine } : {}),
                        ...(session?.metadata?.machineId && sessionMachine
                            ? { [session.metadata.machineId]: sessionMachine }
                            : {}),
                    },
                    filesById: fileMeta ? { [id]: fileMeta } : {},
                },
            ),
        [id, kind, session, machine, sessionMachine, fileMeta],
    );

    const name = (accountId: string) => members.find((m) => m.id === accountId)?.username ?? accountId;
    const disabled = busy || !policy?.canManage || !policy.sharingSupported;
    const cardBg = theme.dark ? theme.colors.surfaceHigh : '#F9FAFC';
    const kindLabel =
        kind === 'session'
            ? t('lmc.sharing.kindSession')
            : kind === 'machine'
              ? t('lmc.sharing.kindMachine')
              : t('lmc.sharing.kindFile');

    return (
        <UtilityDialog title={t('lmc.sharing.settingsTitle')} onClose={onClose} maxWidth={600} testID="resource-sharing-dialog">
            <ScrollView contentContainerStyle={{ padding: 20, gap: 18 }}>
                <View
                    style={{
                        padding: 14,
                        borderRadius: 14,
                        backgroundColor: cardBg,
                        gap: 10,
                        ...lmcSurfaceBorder(theme),
                    }}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                        {descriptor.fileName ? (
                            <FileIcon fileName={descriptor.fileName} size={32} />
                        ) : (
                            <View
                                style={{
                                    width: 38,
                                    height: 38,
                                    borderRadius: 11,
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    backgroundColor: theme.dark ? 'rgba(0,96,240,0.2)' : 'rgba(0,96,240,0.08)',
                                }}
                            >
                                <Ionicons
                                    name={kind === 'session' ? 'chatbubbles-outline' : kind === 'machine' ? 'laptop-outline' : 'document-text-outline'}
                                    size={19}
                                    color={theme.dark ? '#7DB5FF' : theme.colors.textLink}
                                />
                            </View>
                        )}
                        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                                {renderStatusPill(kindLabel, 'neutral', theme.dark, theme.colors)}
                                {descriptor.isOnline ? renderStatusPill(t('lmc.sharing.onlineBadge'), 'green', theme.dark, theme.colors) : null}
                                {descriptor.isArchived ? renderStatusPill(t('lmc.sharing.archivedBadge'), 'neutral', theme.dark, theme.colors) : null}
                                {policy
                                    ? policy.grants.length > 0
                                        ? renderStatusPill(t('lmc.sharing.sharedBadgeCount', { count: policy.grants.length }), 'blue', theme.dark, theme.colors)
                                        : renderStatusPill(t('lmc.sharing.privateOnly'), 'neutral', theme.dark, theme.colors)
                                    : null}
                            </View>
                            <Text numberOfLines={2} style={{ fontSize: 16, lineHeight: 22, fontWeight: '600', color: theme.colors.text }}>
                                {descriptor.title}
                            </Text>
                            <Text numberOfLines={2} style={{ fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary }}>
                                {[descriptor.contextLine, descriptor.shortId].filter(Boolean).join(' · ')}
                            </Text>
                        </View>
                        {kind === 'session' && session ? (
                            <Pressable
                                accessibilityRole="button"
                                onPress={() => {
                                    if (settingsNav) {
                                        settingsNav.closeSettings();
                                    } else {
                                        onClose?.();
                                    }
                                    navigateToSession(id);
                                }}
                                style={({ pressed }) => ({
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    gap: 5,
                                    paddingHorizontal: 11,
                                    paddingVertical: 8,
                                    borderRadius: 10,
                                    borderWidth: 1,
                                    borderColor: theme.colors.divider,
                                    backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface,
                                })}
                            >
                                <Ionicons name="open-outline" size={14} color={theme.colors.textLink} />
                                <Text style={{ fontSize: 12, fontWeight: '600', color: theme.colors.textLink }}>
                                    {t('lmc.sharing.openSession')}
                                </Text>
                            </Pressable>
                        ) : null}
                    </View>
                </View>

                {busy && <ActivityIndicator />}
                {!!error && <Text accessibilityRole="alert" style={{ color: theme.colors.textDestructive }}>{error}</Text>}
                {!!notice && <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.textLink }}>{notice}</Text>}

                {policy && (
                    <>
                        <View style={{ gap: 6 }}>
                            <Text style={{ fontSize: 17, fontWeight: '600', color: theme.colors.text }}>
                                {policy.grants.length ? t('lmc.sharing.sharedWithAccounts') : t('lmc.sharing.privateOnly')}
                            </Text>
                            <Text style={{ fontSize: 13, lineHeight: 20, color: theme.colors.textSecondary }}>
                                {kind === 'machine'
                                    ? t('lmc.sharing.ownerMachineBody', { owner: name(policy.ownerAccountId) })
                                    : kind === 'session'
                                      ? t('lmc.sharing.ownerSessionBody', { owner: name(policy.ownerAccountId) })
                                      : t('lmc.sharing.ownerFileBody', { owner: name(policy.ownerAccountId) })}
                            </Text>
                            {policy.adminManaged && (
                                <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>{t('lmc.sharing.adminManagedNotice')}</Text>
                            )}
                            {policy.unavailableReason && (
                                <Text style={{ fontSize: 13, color: theme.colors.textDestructive }}>
                                    {translateLmcServerMessage(policy.unavailableReason) ?? policy.unavailableReason}
                                </Text>
                            )}
                        </View>

                        <View style={{ gap: 10 }}>
                            {members
                                .filter((m) => m.id !== policy.ownerAccountId)
                                .map((member) => {
                                    const memberDisplay = member.username ?? member.id;
                                    const initial = (memberDisplay.trim()[0] ?? '?').toUpperCase();
                                    const grant = policy.grants.find((g) => g.accountId === member.id);
                                    const isGranted = Boolean(grant);
                                    return (
                                        <View
                                            key={member.id}
                                            style={{
                                                padding: 13,
                                                borderRadius: 13,
                                                backgroundColor: cardBg,
                                                gap: 10,
                                                ...lmcSurfaceBorder(theme),
                                            }}
                                        >
                                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 34 }}>
                                                <View
                                                    style={{
                                                        width: 32,
                                                        height: 32,
                                                        borderRadius: 16,
                                                        alignItems: 'center',
                                                        justifyContent: 'center',
                                                        backgroundColor: isGranted
                                                            ? (theme.dark ? 'rgba(0,96,240,0.28)' : 'rgba(0,96,240,0.12)')
                                                            : (theme.dark ? 'rgba(255,255,255,0.08)' : 'rgba(17,24,39,0.06)'),
                                                    }}
                                                >
                                                    <Text
                                                        style={{
                                                            fontSize: 13,
                                                            fontWeight: '700',
                                                            color: isGranted ? (theme.dark ? '#7DB5FF' : theme.colors.textLink) : theme.colors.text,
                                                        }}
                                                    >
                                                        {initial}
                                                    </Text>
                                                </View>
                                                <Text style={{ color: theme.colors.text, fontSize: 15, fontWeight: '500', flex: 1 }}>
                                                    {memberDisplay}
                                                </Text>
                                                <Switch
                                                    accessibilityLabel={t('lmc.sharing.shareWithMember', { name: memberDisplay })}
                                                    disabled={disabled}
                                                    value={isGranted}
                                                    onValueChange={(checked) =>
                                                        setPolicy({
                                                            ...policy,
                                                            grants: checked
                                                                ? [...policy.grants, { accountId: member.id, actions: ['read'] }]
                                                                : policy.grants.filter((g) => g.accountId !== member.id),
                                                        })
                                                    }
                                                />
                                            </View>

                                            {(kind === 'session' || kind === 'machine') && isGranted && (
                                                <View
                                                    style={{
                                                        flexDirection: 'row',
                                                        flexWrap: 'wrap',
                                                        gap: 14,
                                                        paddingTop: 8,
                                                        borderTopWidth: 1,
                                                        borderTopColor: theme.colors.divider,
                                                    }}
                                                >
                                                    {(kind === 'machine' ? (['execute'] as const) : (['send', 'stop', 'approve'] as const)).map(
                                                        (action) => (
                                                            <View key={action} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                                                <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>
                                                                    {
                                                                        {
                                                                            send: t('lmc.sharing.actionSend'),
                                                                            stop: t('lmc.sharing.actionStop'),
                                                                            approve: t('lmc.sharing.actionApprove'),
                                                                            execute: t('lmc.sharing.actionExecute'),
                                                                        }[action]
                                                                    }
                                                                </Text>
                                                                <Switch
                                                                    disabled={disabled}
                                                                    accessibilityLabel={name(member.id) + ' ' + action}
                                                                    value={Boolean(grant?.actions.includes(action))}
                                                                    onValueChange={(checked) =>
                                                                        setPolicy({
                                                                            ...policy,
                                                                            grants: policy.grants.map((g) =>
                                                                                g.accountId !== member.id
                                                                                    ? g
                                                                                    : {
                                                                                        ...g,
                                                                                        actions: checked
                                                                                            ? [...g.actions, action]
                                                                                            : g.actions.filter((a) => a !== action),
                                                                                    },
                                                                            ),
                                                                        })
                                                                    }
                                                                />
                                                            </View>
                                                        ),
                                                    )}
                                                </View>
                                            )}
                                        </View>
                                    );
                                })}

                            {policy.grants
                                .filter((g) => !members.some((m) => m.id === g.accountId))
                                .map((grant) => (
                                    <View key={grant.accountId} style={{ flexDirection: 'row', alignItems: 'center' }}>
                                        <Text style={{ flex: 1, color: theme.colors.textSecondary }}>
                                            {t('lmc.sharing.disabledAccount', { id: grant.accountId })}
                                        </Text>
                                        <Pressable
                                            accessibilityRole="button"
                                            disabled={disabled}
                                            onPress={() =>
                                                setPolicy({
                                                    ...policy,
                                                    grants: policy.grants.filter((g) => g.accountId !== grant.accountId),
                                                })
                                            }
                                            style={{ padding: 12 }}
                                        >
                                            <Text style={{ color: theme.colors.textLink }}>{t('lmc.sharing.remove')}</Text>
                                        </Pressable>
                                    </View>
                                ))}
                        </View>

                        {admin && (
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                                <Text style={{ flex: 1, color: theme.colors.text }}>{t('lmc.sharing.adminManagedToggle')}</Text>
                                <Switch
                                    accessibilityLabel={t('lmc.sharing.adminManagedToggle')}
                                    value={policy.adminManaged}
                                    disabled={busy || !policy.sharingSupported}
                                    onValueChange={(value) => setPolicy({ ...policy, adminManaged: value })}
                                />
                            </View>
                        )}

                        <Text style={{ fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary }}>
                            {t('lmc.sharing.revokeHint')}
                        </Text>

                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                            <Pressable
                                accessibilityRole="button"
                                disabled={disabled}
                                onPress={() =>
                                    void run(async () => {
                                        await putSharing(policy);
                                        const refreshed = await load();
                                        if (refreshed) onSaved?.(refreshed);
                                        if (active.current) setNotice(t('lmc.sharing.savedNotice'));
                                    })
                                }
                                style={({ pressed }) => ({
                                    paddingHorizontal: 18,
                                    paddingVertical: 11,
                                    borderRadius: 11,
                                    backgroundColor: pressed ? '#0052CC' : theme.colors.textLink,
                                    opacity: disabled ? 0.5 : 1,
                                })}
                            >
                                <Text style={{ color: '#FFFFFF', fontWeight: '600', fontSize: 14 }}>{t('common.save')}</Text>
                            </Pressable>
                            <Pressable
                                accessibilityRole="button"
                                disabled={busy}
                                onPress={() => void run(load)}
                                style={({ pressed }) => ({
                                    paddingHorizontal: 16,
                                    paddingVertical: 11,
                                    borderRadius: 11,
                                    borderWidth: 1,
                                    borderColor: theme.colors.divider,
                                    backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface,
                                    opacity: busy ? 0.5 : 1,
                                })}
                            >
                                <Text style={{ color: theme.colors.text, fontWeight: '500', fontSize: 14 }}>
                                    {t('lmc.sharing.reload')}
                                </Text>
                            </Pressable>
                        </View>

                        {!!events.length && (
                            <View style={{ gap: 6 }}>
                                <Text style={{ color: theme.colors.text, fontWeight: '600', fontSize: 14 }}>
                                    {t('lmc.sharing.recentChanges')}
                                </Text>
                                {events.slice(0, 10).map((event) => (
                                    <Text key={event.id} style={{ fontSize: 12, color: theme.colors.textSecondary }}>
                                        {name(event.actorId)} · {new Date(event.createdAt).toLocaleString(locale)}
                                    </Text>
                                ))}
                            </View>
                        )}
                    </>
                )}
            </ScrollView>
        </UtilityDialog>
    );
}

export const openResourceSharing = (
    kind: string,
    id: string,
    options?: { onSaved?: (policy: SharingPolicy) => void },
) =>
    Modal.show({
        component: ResourceSharingDialog,
        props: { kind, id, onSaved: options?.onSaved },
        blurBackdrop: true,
    });

export function ResourceSharingList({ ownerId, onClose }: { ownerId?: string; onClose?: () => void }) {
    const { theme } = useUnistyles();
    const settingsNav = useSettingsNavigation();
    const locale = getDateLocale();
    const allSessions = useAllSessions();
    const allMachines = useAllMachines();
    const [resources, setResources] = React.useState<ShareableResourceSummary[] | null>(null);
    const [members, setMembers] = React.useState<Array<{ id: string; username: string | null }>>([]);
    const [selfId, setSelfId] = React.useState<string>('');
    const [filesById, setFilesById] = React.useState<Record<string, { name: string; size: number }>>({});
    const [sharedMachinesById, setSharedMachinesById] = React.useState<
        Record<string, { name: string; platform: string; active: boolean }>
    >({});
    const [grantsByKey, setGrantsByKey] = React.useState<
        Record<string, Array<{ accountId: string; actions: string[] }> | undefined>
    >({});
    const [filter, setFilter] = React.useState<ResourceFilterKind>('all');
    const [query, setQuery] = React.useState('');
    const [error, setError] = React.useState('');

    const sessionsById = React.useMemo(() => {
        const map: Record<string, Session> = {};
        for (const s of allSessions) map[s.id] = s;
        return map;
    }, [allSessions]);

    const machinesById = React.useMemo(() => {
        const map: Record<string, Machine> = {};
        for (const m of allMachines) map[m.id] = m;
        return map;
    }, [allMachines]);

    const loadAll = React.useCallback(() => {
        let active = true;
        setError('');
        void Promise.all([
            accountRequest<{ resources: ShareableResourceSummary[] }>(
                '/v1/lmc/sharing/resources' + (ownerId ? '?ownerId=' + encodeURIComponent(ownerId) : ''),
            ),
            accountDirectory().catch(() => ({ accounts: [] as Array<{ id: string; username: string | null }> })),
            accountMe().catch(() => null),
        ])
            .then(([result, directory, me]) => {
                if (!active) return;
                const list = result.resources;
                setResources(list);
                setMembers(directory.accounts);
                const myId = me?.account.id ?? '';
                setSelfId(myId);

                const initialGrants: Record<string, Array<{ accountId: string; actions: string[] }> | undefined> = {};
                const missingPolicyItems: ShareableResourceSummary[] = [];
                for (const item of list) {
                    const key = `${item.kind}:${item.id}`;
                    if (Array.isArray(item.grants)) {
                        initialGrants[key] = item.grants;
                    } else {
                        missingPolicyItems.push(item);
                    }
                }
                setGrantsByKey(initialGrants);

                const isOwnResources = !ownerId || Boolean(myId && ownerId === myId);
                const readableSessionIds = list
                    .filter((r) => {
                        if (r.kind !== 'session') return false;
                        if (isOwnResources) return true;
                        return Boolean(myId && r.grants?.some((g) => g.accountId === myId));
                    })
                    .map((r) => r.id);
                if (readableSessionIds.length > 0) {
                    void sync.ensureSessionsLoaded(readableSessionIds);
                }
                if (list.some((r) => r.kind === 'file')) {
                    void listFileAssets()
                        .then((res) => {
                            if (!active) return;
                            const nextFiles: Record<string, { name: string; size: number }> = {};
                            for (const f of res.files) {
                                nextFiles[f.manifest.id] = { name: f.manifest.name, size: f.manifest.size };
                            }
                            setFilesById(nextFiles);
                        })
                        .catch(() => {});
                }
                if (!isOwnResources && list.some((r) => r.kind === 'machine')) {
                    void accountRequest<{ machines: Array<{ id: string; name: string; platform: string; active: boolean }> }>(
                        '/v1/lmc/shared-machines',
                    )
                        .then((res) => {
                            if (!active) return;
                            const nextMachines: Record<string, { name: string; platform: string; active: boolean }> = {};
                            for (const m of res.machines) nextMachines[m.id] = m;
                            setSharedMachinesById(nextMachines);
                        })
                        .catch(() => {});
                }

                // Hydrate grants for servers that do not inline policy grants in /v1/lmc/sharing/resources yet
                if (missingPolicyItems.length > 0) {
                    const ordered = [...missingPolicyItems].sort(
                        (a, b) => (KIND_PRIORITY[a.kind] ?? 3) - (KIND_PRIORITY[b.kind] ?? 3),
                    );
                    let cursor = 0;
                    const concurrency = 6;
                    const worker = async () => {
                        while (active && cursor < ordered.length) {
                            const target = ordered[cursor++];
                            try {
                                const policy = await getSharing(target.kind, target.id);
                                if (!active) return;
                                setGrantsByKey((prev) => ({
                                    ...prev,
                                    [`${target.kind}:${target.id}`]: policy.grants,
                                }));
                            } catch {
                                // Ignore individual policy fetch error so list stays interactive
                            }
                        }
                    };
                    void Promise.all(
                        Array.from({ length: Math.min(concurrency, ordered.length) }, () => worker()),
                    );
                }
            })
            .catch((e) => {
                if (active) setError(e instanceof Error ? e.message : t('lmc.sharing.actionFailed'));
            });
        return () => {
            active = false;
        };
    }, [ownerId]);

    React.useEffect(() => loadAll(), [loadAll]);

    const memberNameOf = React.useCallback(
        (accountId: string) => members.find((m) => m.id === accountId)?.username ?? shortenResourceId(accountId),
        [members],
    );

    const descriptors = React.useMemo(() => {
        const map = new Map<string, ManagedResourceDescriptor>();
        if (!resources) return map;
        for (const item of resources) {
            map.set(
                `${item.kind}:${item.id}`,
                describeManagedResource(item, {
                    sessionsById,
                    machinesById,
                    filesById,
                    sharedMachinesById,
                }),
            );
        }
        return map;
    }, [resources, sessionsById, machinesById, filesById, sharedMachinesById]);

    const counts = React.useMemo(() => {
        const list = resources ?? [];
        let shared = 0;
        let session = 0;
        let machine = 0;
        let file = 0;
        for (const item of list) {
            const g = grantsByKey[`${item.kind}:${item.id}`] ?? item.grants;
            if (g && g.length > 0) shared++;
            if (item.kind === 'session') session++;
            else if (item.kind === 'machine') machine++;
            else if (item.kind === 'file') file++;
        }
        return { all: list.length, shared, session, machine, file };
    }, [resources, grantsByKey]);

    const visibleResources = React.useMemo(
        () =>
            resources
                ? sortAndFilterManagedResources(resources, descriptors, grantsByKey, memberNameOf, filter, query)
                : [],
        [resources, descriptors, grantsByKey, memberNameOf, filter, query],
    );

    const isManagingOtherMember = Boolean(ownerId && selfId && ownerId !== selfId);
    const cardBg = theme.dark ? theme.colors.surfaceHigh : '#F9FAFC';
    const filterTabs: Array<{ key: ResourceFilterKind; label: string; count: number }> = [
        { key: 'all', label: t('lmc.sharing.filterAll'), count: counts.all },
        { key: 'shared', label: t('lmc.sharing.filterShared'), count: counts.shared },
        { key: 'session', label: t('lmc.sharing.filterSessions'), count: counts.session },
        { key: 'machine', label: t('lmc.sharing.filterDevices'), count: counts.machine },
        { key: 'file', label: t('lmc.sharing.filterFiles'), count: counts.file },
    ];

    return (
        <UtilityDialog title={t('lmc.sharing.resourceSharingTitle')} onClose={onClose} maxWidth={680} testID="resource-sharing-list">
            <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }}>
                <Text style={{ fontSize: 13, lineHeight: 20, color: theme.colors.textSecondary }}>
                    {t('lmc.sharing.resourceSharingIntro')}
                </Text>

                {isManagingOtherMember && (
                    <View
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 8,
                            paddingHorizontal: 12,
                            paddingVertical: 10,
                            borderRadius: 11,
                            backgroundColor: theme.dark ? 'rgba(0,96,240,0.16)' : 'rgba(0,96,240,0.07)',
                        }}
                    >
                        <Ionicons name="person-circle-outline" size={18} color={theme.dark ? '#7DB5FF' : theme.colors.textLink} />
                        <Text style={{ flex: 1, fontSize: 13, fontWeight: '500', color: theme.dark ? '#7DB5FF' : theme.colors.textLink }}>
                            {t('lmc.sharing.managingOwnerBanner', { owner: memberNameOf(ownerId!) })}
                        </Text>
                    </View>
                )}

                {resources && resources.length > 0 && (
                    <View style={{ gap: 10 }}>
                        <View
                            style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                gap: 8,
                                paddingHorizontal: 12,
                                borderRadius: 11,
                                backgroundColor: cardBg,
                                ...lmcSurfaceBorder(theme),
                            }}
                        >
                            <Ionicons name="search-outline" size={16} color={theme.colors.textSecondary} />
                            <TextInput
                                value={query}
                                onChangeText={setQuery}
                                placeholder={t('lmc.sharing.resourceSearchPlaceholder')}
                                placeholderTextColor={theme.colors.textSecondary}
                                style={{
                                    flex: 1,
                                    paddingVertical: 10,
                                    fontSize: 14,
                                    color: theme.colors.text,
                                }}
                            />
                            {!!query && (
                                <Pressable accessibilityRole="button" onPress={() => setQuery('')} hitSlop={8}>
                                    <Ionicons name="close-circle" size={16} color={theme.colors.textSecondary} />
                                </Pressable>
                            )}
                        </View>

                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                            {filterTabs.map((tab) => {
                                const selected = filter === tab.key;
                                return (
                                    <Pressable
                                        key={tab.key}
                                        accessibilityRole="tab"
                                        accessibilityState={{ selected }}
                                        onPress={() => setFilter(tab.key)}
                                        style={({ pressed }) => ({
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            gap: 6,
                                            paddingHorizontal: 12,
                                            paddingVertical: 7,
                                            borderRadius: 999,
                                            borderWidth: 1,
                                            borderColor: selected ? theme.colors.textLink : theme.colors.divider,
                                            backgroundColor: selected
                                                ? (theme.dark ? 'rgba(0,96,240,0.22)' : 'rgba(0,96,240,0.09)')
                                                : pressed
                                                  ? theme.colors.surfacePressed
                                                  : theme.colors.surface,
                                        })}
                                    >
                                        <Text
                                            style={{
                                                fontSize: 13,
                                                fontWeight: selected ? '600' : '500',
                                                color: selected ? (theme.dark ? '#7DB5FF' : theme.colors.textLink) : theme.colors.text,
                                            }}
                                        >
                                            {tab.label}
                                        </Text>
                                        <Text
                                            style={{
                                                fontSize: 11,
                                                fontWeight: '600',
                                                color: selected
                                                    ? (theme.dark ? '#7DB5FF' : theme.colors.textLink)
                                                    : theme.colors.textSecondary,
                                            }}
                                        >
                                            {tab.count}
                                        </Text>
                                    </Pressable>
                                );
                            })}
                        </View>
                    </View>
                )}

                {!resources && !error && <ActivityIndicator />}
                {!!error && <Text accessibilityRole="alert" style={{ color: theme.colors.textDestructive }}>{error}</Text>}
                {resources?.length === 0 && (
                    <Text style={{ color: theme.colors.textSecondary }}>{t('lmc.sharing.noManageableResources')}</Text>
                )}
                {resources && resources.length > 0 && visibleResources.length === 0 && (
                    <Text style={{ color: theme.colors.textSecondary }}>{t('lmc.sharing.noMatchingResources')}</Text>
                )}

                <View style={{ gap: 10 }}>
                    {visibleResources.map((item) => {
                        const key = `${item.kind}:${item.id}`;
                        const desc = descriptors.get(key)!;
                        const grants = grantsByKey[key] ?? item.grants;
                        const isShared = Boolean(grants && grants.length > 0);
                        const kindLabel =
                            item.kind === 'session'
                                ? t('lmc.sharing.kindSession')
                                : item.kind === 'machine'
                                  ? t('lmc.sharing.kindMachine')
                                  : t('lmc.sharing.kindFile');
                        const grantLine =
                            grants !== undefined
                                ? formatGrantSummary(item.kind, grants, memberNameOf)
                                : '';
                        const timeText = new Date(item.updatedAt ?? item.createdAt).toLocaleString(locale);

                        return (
                            <Pressable
                                accessibilityRole="button"
                                key={key}
                                onPress={() => {
                                    const onSaved = (updated: SharingPolicy) => {
                                        setGrantsByKey((prev) => ({
                                            ...prev,
                                            [key]: updated.grants,
                                        }));
                                    };
                                    if (settingsNav) {
                                        settingsNav.openResourceSharing(item.kind, item.id, { onSaved });
                                    } else {
                                        openResourceSharing(item.kind, item.id, { onSaved });
                                    }
                                }}
                                style={({ pressed }) => ({
                                    padding: 14,
                                    borderRadius: 14,
                                    backgroundColor: pressed ? theme.colors.surfacePressed : cardBg,
                                    gap: 8,
                                    ...lmcSurfaceBorder(theme),
                                })}
                            >
                                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                                    {desc.fileName ? (
                                        <View style={{ paddingTop: 2 }}>
                                            <FileIcon fileName={desc.fileName} size={28} />
                                        </View>
                                    ) : (
                                        <View
                                            style={{
                                                width: 34,
                                                height: 34,
                                                borderRadius: 10,
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                backgroundColor: isShared
                                                    ? (theme.dark ? 'rgba(0,96,240,0.22)' : 'rgba(0,96,240,0.09)')
                                                    : (theme.dark ? 'rgba(255,255,255,0.06)' : 'rgba(17,24,39,0.05)'),
                                            }}
                                        >
                                            <Ionicons
                                                name={
                                                    item.kind === 'session'
                                                        ? 'chatbubbles-outline'
                                                        : item.kind === 'machine'
                                                          ? 'laptop-outline'
                                                          : 'document-text-outline'
                                                }
                                                size={17}
                                                color={
                                                    isShared
                                                        ? (theme.dark ? '#7DB5FF' : theme.colors.textLink)
                                                        : theme.colors.textSecondary
                                                }
                                            />
                                        </View>
                                    )}

                                    <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                                            <Text
                                                numberOfLines={1}
                                                style={{
                                                    flexShrink: 1,
                                                    fontSize: 15,
                                                    lineHeight: 21,
                                                    fontWeight: '600',
                                                    color: theme.colors.text,
                                                }}
                                            >
                                                {desc.title}
                                            </Text>
                                            {renderStatusPill(kindLabel, 'neutral', theme.dark, theme.colors)}
                                            {desc.isOnline
                                                ? renderStatusPill(t('lmc.sharing.onlineBadge'), 'green', theme.dark, theme.colors)
                                                : null}
                                            {desc.isArchived
                                                ? renderStatusPill(t('lmc.sharing.archivedBadge'), 'neutral', theme.dark, theme.colors)
                                                : null}
                                            {grants !== undefined
                                                ? isShared
                                                    ? renderStatusPill(
                                                        t('lmc.sharing.sharedBadgeCount', { count: grants.length }),
                                                        'blue',
                                                        theme.dark,
                                                        theme.colors,
                                                    )
                                                    : renderStatusPill(t('lmc.sharing.privateOnly'), 'neutral', theme.dark, theme.colors)
                                                : null}
                                        </View>

                                        {!!desc.contextLine && (
                                            <Text
                                                numberOfLines={1}
                                                style={{ fontSize: 13, lineHeight: 19, color: theme.colors.textSecondary }}
                                            >
                                                {desc.contextLine}
                                            </Text>
                                        )}

                                        <Text
                                            numberOfLines={2}
                                            style={{
                                                fontSize: 12,
                                                lineHeight: 18,
                                                color: isShared
                                                    ? (theme.dark ? '#7DB5FF' : theme.colors.textLink)
                                                    : theme.colors.textSecondary,
                                            }}
                                        >
                                            {[grantLine, timeText, desc.shortId].filter(Boolean).join(' · ')}
                                        </Text>
                                    </View>

                                    <Ionicons
                                        name="chevron-forward"
                                        size={16}
                                        color={theme.colors.textSecondary}
                                        style={{ marginTop: 8 }}
                                    />
                                </View>
                            </Pressable>
                        );
                    })}
                </View>
            </ScrollView>
        </UtilityDialog>
    );
}

export const openResourceSharingList = (ownerId?: string) =>
    Modal.show({ component: ResourceSharingList, props: { ownerId }, blurBackdrop: true });
