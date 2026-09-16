import * as React from 'react';
import { Platform, Pressable, ScrollView, TextInput, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { useAllMachines, useAllSessions } from '@/sync/storage';
import type { Machine, Session } from '@/sync/storageTypes';
import { getSessionName } from '@/utils/sessionUtils';
import { engineKeyForSession, isArchivedForList, machineDisplayName } from '@/utils/lmc/deviceEngineGroups';
import { bindWorker, dissolveHub, makeHub, migrateWorkers, unbindWorker } from '@/sync/orchestration';
import { sessionUpdateMetadata } from '@/sync/ops';
import { showToast } from './Toast';
import { lmcColors } from './lmcColors';
import { lmcElevation, lmcSurfaceBorder } from './elevation';
import { applyDutyPrefix, dutyPresetKeyFor, DUTY_PRESET_KEYS, parseDutyPrefix, sanitizeDutyText, snapshotRole, type RoleSnapshot } from './collaborationDuty';
import { t } from '@/text';

/** Replays a snapshot taken before a dissolve/unbind, undoing it. */
async function restoreRole(sessionId: string, snapshot: RoleSnapshot): Promise<void> {
    if (snapshot.role === 'hub') {
        await makeHub(sessionId);
        for (const workerId of snapshot.workerIds) await bindWorker(sessionId, workerId, 'manual');
    } else if (snapshot.role === 'worker') {
        await bindWorker(snapshot.hubId, sessionId, 'manual');
    }
}

function engineLabel(key: 'claude' | 'codex' | 'other'): string {
    return key === 'claude' ? 'Claude' : key === 'codex' ? 'Codex' : t('lmc.common.otherEngine');
}

export function fail(error: unknown) {
    Modal.alert(t('lmc.orchestration.failed'), error instanceof Error ? error.message : String(error));
}

export function showUndoToast(text: string, undo: () => Promise<void>) {
    showToast(text, 'info', { label: t('lmc.orchestration.undo'), onPress: () => { undo().catch(fail); } });
}

interface SessionRowProps {
    session: Session;
    machine: Machine | undefined;
    subtitle?: string;
    selected?: boolean;
    onPress: () => void;
}

/** A session, named and placed, with an optional left radio dot. */
const SessionPickRow = React.memo(({ session, machine, subtitle, selected, onPress }: SessionRowProps) => {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const device = machineDisplayName(machine, session.metadata?.host ?? '');
    const engine = engineLabel(engineKeyForSession(session));
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityState={selected !== undefined ? { selected } : undefined}
            onPress={onPress}
            style={({ pressed }) => [styles.pickRow, pressed && { backgroundColor: colors.subtle }]}
        >
            {selected !== undefined && (
                <Ionicons name={selected ? 'radio-button-on' : 'radio-button-off'} size={16} color={selected ? colors.brand : colors.tertiary} />
            )}
            <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={styles.pickRowTitle}>{getSessionName(session)}</Text>
                <Text numberOfLines={1} style={[styles.pickRowMeta, { color: colors.tertiary }]}>{subtitle ?? `${device} · ${engine}`}</Text>
            </View>
        </Pressable>
    );
});

export const Chip = React.memo(({ label, selected, readOnly, compact, onPress }: { label: string; selected: boolean; readOnly?: boolean; /** The post-drop duty row in the session list runs a notch smaller than the sheet's own chips. */ compact?: boolean; onPress?: () => void }) => {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const content = (
        <Text numberOfLines={1} style={[styles.chipText, compact && styles.chipTextCompact, { color: selected ? colors.onInverse : theme.colors.text }]}>{label}</Text>
    );
    if (readOnly) {
        return <View style={[styles.chip, compact && styles.chipCompact, { backgroundColor: colors.brand, borderColor: colors.brand }]}>{content}</View>;
    }
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={onPress}
            style={({ pressed }) => [
                styles.chip,
                compact && styles.chipCompact,
                { borderColor: selected ? colors.brand : colors.border, backgroundColor: selected ? colors.brand : pressed ? colors.subtle : 'transparent' },
            ]}
        >
            {content}
        </Pressable>
    );
});

/**
 * Duty presets plus "custom…", each a press away from calling back with the
 * word to write into the 【…】 prefix. `selected` is compared against every
 * shipped language's preset text (`dutyPresetKeyFor`), not just the current
 * one, so a duty picked before a language switch still highlights correctly
 * instead of reading as a 5th custom chip.
 *
 * "Custom…" expands into an inline field rather than a global text-prompt
 * dialog: this row is as likely to be rendered inside a custom modal sheet
 * as bare in the session list, and the modal provider renders only the top
 * of its modal stack — stacking a second one on top of the sheet unmounts
 * it, taking any pick made after with it.
 */
export const DutyChipRow = React.memo(({ selected, onPick, compact, style }: { selected?: string | null; onPick: (duty: string) => void; compact?: boolean; style?: React.ComponentProps<typeof View>['style'] }) => {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const [customOpen, setCustomOpen] = React.useState(false);
    const [customText, setCustomText] = React.useState('');
    const presetKey = selected ? dutyPresetKeyFor(selected) : null;
    const customLabel = selected && !presetKey ? selected : null;
    const submitCustom = () => {
        const cleaned = sanitizeDutyText(customText);
        if (cleaned) { onPick(cleaned); setCustomOpen(false); setCustomText(''); }
    };
    return (
        <View style={[styles.chipRow, style]}>
            {DUTY_PRESET_KEYS.map((key) => {
                const label = t(`lmc.orchestration.${key}`);
                return <Chip key={key} label={label} selected={presetKey === key} compact={compact} onPress={() => onPick(label)} />;
            })}
            {customOpen ? (
                <View style={styles.customInputRow}>
                    <TextInput
                        autoFocus
                        value={customText}
                        onChangeText={setCustomText}
                        onSubmitEditing={submitCustom}
                        onBlur={() => { if (!customText.trim()) setCustomOpen(false); }}
                        placeholder={t('lmc.orchestration.dutyCustomPrompt')}
                        placeholderTextColor={colors.placeholder}
                        style={[styles.customInput, compact && styles.customInputCompact, { color: theme.colors.text, borderColor: colors.border }, Platform.OS === 'web' && ({ outlineStyle: 'none' } as any)]}
                    />
                    <Pressable accessibilityRole="button" onPress={submitCustom} hitSlop={6}>
                        <Text style={[styles.customInputConfirm, { color: colors.brand }]}>{t('lmc.orchestration.dutyCustomConfirm')}</Text>
                    </Pressable>
                </View>
            ) : (
                <Chip label={t('lmc.orchestration.dutyCustom')} selected={false} compact={compact} onPress={() => { setCustomText(customLabel ?? ''); setCustomOpen(true); }} />
            )}
            {!!customLabel && !customOpen && <Chip label={customLabel} selected compact={compact} readOnly />}
        </View>
    );
});

const WorkerChip = React.memo(({ label, onRemove }: { label: string; onRemove: () => void }) => {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    return (
        <View style={[styles.chip, styles.workerChip, { borderColor: colors.border }]}>
            <Text numberOfLines={1} style={[styles.chipText, { color: theme.colors.text, maxWidth: 160 }]}>{label}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={t('common.cancel')} hitSlop={8} onPress={onRemove}>
                <Ionicons name="close" size={13} color={colors.tertiary} />
            </Pressable>
        </View>
    );
});

const SEGMENTS: Array<{ key: 'plain' | 'hub' | 'worker'; labelKey: 'plain' | 'hub' | 'worker' }> = [
    { key: 'plain', labelKey: 'plain' },
    { key: 'hub', labelKey: 'hub' },
    { key: 'worker', labelKey: 'worker' },
];

export interface CollaborationSheetProps {
    sessionId: string;
    /** Injected by the modal infra. */
    onClose?: () => void;
}

/**
 * The single sheet that replaces the old role / hub / migrate alert stack:
 * one segmented control for what this session is, expanding into the two
 * fields a worker needs when that segment is picked. Nothing but the worker
 * segment's join button writes anything — the other two segments apply the
 * moment they are picked, since there is nothing left to configure first.
 */
export const CollaborationSheet = React.memo(({ sessionId, onClose }: CollaborationSheetProps) => {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const { width, height } = useWindowDimensions();
    const sessions = useAllSessions();
    const machines = useAllMachines({ includeOffline: true });
    const session = sessions.find((s) => s.id === sessionId);

    const orchestration = session?.metadata?.orchestration;
    const currentRole: 'plain' | 'hub' | 'worker' = orchestration?.role ?? 'plain';
    const [segment, setSegment] = React.useState<'plain' | 'hub' | 'worker'>(currentRole);
    const [pending, setPending] = React.useState(false);
    const [hubChoice, setHubChoice] = React.useState<string | null>(orchestration?.role === 'worker' ? orchestration.hub.sessionId : null);
    const [duty, setDuty] = React.useState<string | null>(() => session ? parseDutyPrefix(getSessionName(session)) : null);
    const [addingWorker, setAddingWorker] = React.useState(false);

    const machineOf = React.useCallback((s: Session) => machines.find((m) => m.id === s.metadata?.machineId), [machines]);

    const hubCandidates = React.useMemo(() => sessions.filter((s) =>
        s.id !== sessionId
        && s.metadata?.orchestration?.role === 'hub'
        && !s.metadata?.isSideChat
        && !isArchivedForList(s)
    ), [sessions, sessionId]);
    const effectiveHubChoice = hubChoice ?? (hubCandidates.length === 1 ? hubCandidates[0].id : null);

    const actualHub = orchestration?.role === 'worker' ? sessions.find((s) => s.id === orchestration.hub.sessionId) : null;
    const hubLost = orchestration?.role === 'worker' && (!actualHub || isArchivedForList(actualHub));

    const workers = orchestration?.role === 'hub'
        ? orchestration.workers.map((w) => sessions.find((s) => s.id === w.sessionId)).filter((s): s is Session => !!s)
        : [];
    const addWorkerCandidates = React.useMemo(() => sessions.filter((s) =>
        s.id !== sessionId
        && s.metadata?.orchestration?.role !== 'hub'
        && s.metadata?.orchestration?.role !== 'worker'
        && !s.metadata?.isSideChat
        && !isArchivedForList(s)
    ), [sessions, sessionId]);

    if (!session) return null;

    const applySegment = (next: 'plain' | 'hub' | 'worker') => {
        if (pending || next === segment) return;
        if (next === 'worker') { setSegment('worker'); return; }
        setPending(true);
        (async () => {
            if (next === 'plain') {
                const snapshot = snapshotRole(orchestration);
                if (snapshot.role === 'hub') await dissolveHub(sessionId);
                else if (snapshot.role === 'worker') await unbindWorker(sessionId);
                if (snapshot.role !== 'plain') {
                    showUndoToast(t('lmc.orchestration.toastBackToPlain'), () => restoreRole(sessionId, snapshot));
                }
            } else if (next === 'hub') {
                if (orchestration?.role === 'worker') await unbindWorker(sessionId);
                await makeHub(sessionId);
            }
            setSegment(next);
        })().catch(fail).finally(() => setPending(false));
    };

    const handleJoin = () => {
        if (pending || !effectiveHubChoice) return;
        setPending(true);
        (async () => {
            if (orchestration?.role === 'hub') await dissolveHub(sessionId);
            if (orchestration?.role === 'worker' && hubLost) {
                await migrateWorkers(orchestration.hub.sessionId, effectiveHubChoice);
            } else {
                await bindWorker(effectiveHubChoice, sessionId, 'manual');
            }
            if (duty) {
                await sessionUpdateMetadata(sessionId, (metadata) => ({
                    ...metadata,
                    summary: { text: applyDutyPrefix(getSessionName(session), duty), updatedAt: Date.now() },
                }));
            }
            onClose?.();
        })().catch(fail).finally(() => setPending(false));
    };

    const handleUnbindWorker = (worker: Session) => {
        if (pending) return;
        setPending(true);
        (async () => {
            await unbindWorker(worker.id);
            showUndoToast(t('lmc.orchestration.toastUnbound', { name: getSessionName(worker) }), () => bindWorker(sessionId, worker.id, 'manual'));
        })().catch(fail).finally(() => setPending(false));
    };

    const handleAddWorker = (candidate: Session) => {
        if (pending) return;
        setPending(true);
        (async () => { await bindWorker(sessionId, candidate.id, 'manual'); setAddingWorker(false); })().catch(fail).finally(() => setPending(false));
    };

    const handleDissolve = () => {
        if (pending || orchestration?.role !== 'hub') return;
        setPending(true);
        const snapshot = snapshotRole(orchestration);
        (async () => {
            await dissolveHub(sessionId);
            showUndoToast(t('lmc.orchestration.toastDissolved', { name: getSessionName(session) }), () => restoreRole(sessionId, snapshot));
            setSegment('plain');
        })().catch(fail).finally(() => setPending(false));
    };

    const isNative = Platform.OS !== 'web';
    const machine = machineOf(session);
    const sessionName = getSessionName(session);

    return (
        <View pointerEvents="box-none" style={isNative ? { width, height, justifyContent: 'flex-end' } : { width, height, alignItems: 'center', justifyContent: 'center' }}>
            {/* This full-screen layout sits above BaseModal's backdrop. Handle
                its empty area here; the sheet itself remains a separate sibling. */}
            <Pressable
                accessible={false}
                focusable={false}
                importantForAccessibility="no"
                onPress={onClose}
                style={StyleSheet.absoluteFillObject}
            />
            <View
                style={[
                    styles.sheet,
                    { backgroundColor: theme.colors.surface, maxHeight: isNative ? height * 0.86 : Math.min(620, height - 64) },
                    isNative ? { width, borderTopLeftRadius: 20, borderTopRightRadius: 20 } : { width: Math.min(420, width - 32), borderRadius: 20, ...lmcElevation(theme, 4), ...lmcSurfaceBorder(theme) },
                ]}
            >
                {isNative && <View style={[styles.handle, { backgroundColor: colors.border }]} />}
                <View style={styles.header}>
                    <View style={styles.headerInfo}>
                        <Text numberOfLines={1} style={[styles.headerTitle, { color: theme.colors.text, flexShrink: 1 }]}>{sessionName}</Text>
                        <Text numberOfLines={1} style={[styles.headerMeta, { color: colors.tertiary, flexShrink: 1 }]}>{`${machineDisplayName(machine, session.metadata?.host ?? '')} · ${engineLabel(engineKeyForSession(session))}`}</Text>
                    </View>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('lmc.common.close')}
                        onPress={onClose}
                        style={({ pressed }) => [styles.closeButton, pressed && { backgroundColor: colors.subtle }]}
                    >
                        <Ionicons name="close" size={20} color={colors.tertiary} />
                    </Pressable>
                </View>

                <ScrollView contentContainerStyle={{ paddingBottom: 20 }} keyboardShouldPersistTaps="handled">
                    <Text style={[styles.sectionLabel, { color: colors.tertiary }]}>{t('lmc.orchestration.sheetRoleQuestion')}</Text>
                    <View style={[styles.segmentTrack, { backgroundColor: colors.subtle }]}>
                        {SEGMENTS.map((s) => (
                            <Pressable
                                key={s.key}
                                accessibilityRole="button"
                                accessibilityState={{ selected: segment === s.key }}
                                disabled={pending}
                                onPress={() => applySegment(s.key)}
                                style={[styles.segmentButton, segment === s.key && { backgroundColor: theme.colors.surface, ...lmcElevation(theme, 1) }]}
                            >
                                <Text style={[styles.segmentLabel, { color: theme.colors.text }]}>{t(`lmc.orchestration.${s.labelKey}`)}</Text>
                            </Pressable>
                        ))}
                    </View>

                    {segment === 'worker' && (
                        <View style={{ marginTop: 16 }}>
                            <Text style={[styles.sectionLabel, { color: colors.tertiary }]}>{t('lmc.orchestration.hubRow')}</Text>
                            {hubCandidates.length === 0 ? (
                                <Text style={[styles.emptyText, { color: colors.tertiary }]}>{t('lmc.orchestration.noHubs')}</Text>
                            ) : hubCandidates.map((hub) => (
                                <SessionPickRow
                                    key={hub.id}
                                    session={hub}
                                    machine={machineOf(hub)}
                                    selected={effectiveHubChoice === hub.id}
                                    subtitle={`${machineDisplayName(machineOf(hub), hub.metadata?.host ?? '')} · ${engineLabel(engineKeyForSession(hub))} · ${t('lmc.orchestration.workerCountLabel', { n: hub.metadata?.orchestration?.role === 'hub' ? hub.metadata.orchestration.workers.length : 0 })}`}
                                    onPress={() => setHubChoice(hub.id)}
                                />
                            ))}

                            <Text style={[styles.sectionLabel, { color: colors.tertiary, marginTop: 14 }]}>{t('lmc.orchestration.sheetDutyLabel')}</Text>
                            <DutyChipRow selected={duty} onPick={setDuty} />

                            <Pressable
                                accessibilityRole="button"
                                disabled={pending || !effectiveHubChoice}
                                onPress={handleJoin}
                                style={({ pressed }) => [
                                    styles.primaryButton,
                                    { backgroundColor: colors.brand, opacity: (pending || !effectiveHubChoice) ? 0.5 : pressed ? 0.85 : 1 },
                                ]}
                            >
                                <Text style={styles.primaryButtonText} numberOfLines={1}>
                                    {effectiveHubChoice ? t('lmc.orchestration.joinButton', { name: getSessionName(sessions.find((s) => s.id === effectiveHubChoice)!) }) : t('lmc.orchestration.hubRow')}
                                </Text>
                            </Pressable>
                        </View>
                    )}

                    {segment === 'hub' && (
                        <View style={{ marginTop: 16 }}>
                            <Text style={[styles.sectionLabel, { color: colors.tertiary }]}>{t('lmc.orchestration.sheetWorkersLabel')}</Text>
                            <View style={styles.chipRow}>
                                {workers.map((worker) => (
                                    <WorkerChip key={worker.id} label={getSessionName(worker)} onRemove={() => handleUnbindWorker(worker)} />
                                ))}
                                <Pressable
                                    accessibilityRole="button"
                                    disabled={pending}
                                    onPress={() => setAddingWorker((v) => !v)}
                                    style={[styles.chip, styles.addWorkerChip, { borderColor: colors.brand }]}
                                >
                                    <Text style={[styles.chipText, { color: colors.brand }]}>{t('lmc.orchestration.addWorker')}</Text>
                                </Pressable>
                            </View>

                            {addingWorker && (
                                <View style={[styles.addWorkerList, { borderColor: colors.border }]}>
                                    {addWorkerCandidates.length === 0 ? (
                                        <Text style={[styles.emptyText, { color: colors.tertiary }]}>{t('lmc.orchestration.addWorkerEmpty')}</Text>
                                    ) : addWorkerCandidates.map((candidate) => (
                                        <SessionPickRow key={candidate.id} session={candidate} machine={machineOf(candidate)} onPress={() => handleAddWorker(candidate)} />
                                    ))}
                                </View>
                            )}

                            <Text style={[styles.hintText, { color: colors.tertiary }]}>{t('lmc.orchestration.spawnHint')}</Text>

                            <Pressable accessibilityRole="button" disabled={pending} onPress={handleDissolve} style={({ pressed }) => [styles.dissolveButton, pressed && { opacity: 0.7 }]}>
                                <Text style={[styles.dissolveButtonText, { color: theme.colors.status.error }]}>{t('lmc.orchestration.dissolveButton')}</Text>
                            </Pressable>
                        </View>
                    )}
                </ScrollView>
            </View>
        </View>
    );
});

export function openCollaborationSheet(sessionId: string) {
    Modal.show({ component: CollaborationSheet, props: { sessionId } });
}

const styles = StyleSheet.create((theme) => ({
    sheet: {
        overflow: 'hidden',
        alignSelf: 'center',
    },
    handle: {
        width: 36,
        height: 4,
        borderRadius: 999,
        alignSelf: 'center',
        marginTop: 10,
        marginBottom: 4,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 18,
        paddingTop: 16,
        paddingBottom: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    headerInfo: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 8 },
    closeButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
    headerTitle: { fontSize: 15, ...Typography.default('semiBold') },
    headerMeta: { fontSize: 11, ...Typography.default() },
    sectionLabel: { fontSize: 11, paddingHorizontal: 18, marginTop: 14, marginBottom: 6, ...Typography.default('semiBold') },
    segmentTrack: { flexDirection: 'row', marginHorizontal: 18, borderRadius: 10, padding: 3, gap: 3 },
    segmentButton: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
    segmentLabel: { fontSize: 13, ...Typography.default('semiBold') },
    pickRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, paddingVertical: 8 },
    pickRowTitle: { fontSize: 14, ...Typography.default() },
    pickRowMeta: { fontSize: 11, marginTop: 1, ...Typography.default() },
    emptyText: { fontSize: 12.5, paddingHorizontal: 18, paddingVertical: 4, ...Typography.default() },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 18 },
    chip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1 },
    chipCompact: { paddingHorizontal: 8, paddingVertical: 4 },
    chipText: { fontSize: 12.5, ...Typography.default('semiBold') },
    chipTextCompact: { fontSize: 11, ...Typography.default() },
    customInputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    customInput: { minWidth: 96, height: 30, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, fontSize: 12.5, ...Typography.default() },
    customInputCompact: { height: 26, fontSize: 11 },
    customInputConfirm: { fontSize: 12.5, ...Typography.default('semiBold') },
    workerChip: { gap: 6 },
    addWorkerChip: { backgroundColor: 'transparent' },
    addWorkerList: { marginHorizontal: 18, marginTop: 8, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
    hintText: { fontSize: 11, paddingHorizontal: 18, marginTop: 14, lineHeight: 16, ...Typography.default() },
    primaryButton: { marginHorizontal: 18, marginTop: 16, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    primaryButtonText: { fontSize: 15, color: '#FFFFFF', ...Typography.default('semiBold') },
    dissolveButton: { alignSelf: 'flex-end', marginHorizontal: 18, marginTop: 18, paddingVertical: 6 },
    dissolveButtonText: { fontSize: 13, ...Typography.default('semiBold') },
}));
