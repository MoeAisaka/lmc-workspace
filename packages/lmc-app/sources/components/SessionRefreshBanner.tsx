import { Text } from '@/components/StyledText';
import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useSession, useSessionMessages } from '@/sync/storage';
import { engineSwitchProgress, latestSwitchRequest } from '@/sync/engineSwitchProgress';
import { cancelSessionRefresh, retrySessionRefresh } from '@/sync/sessionConfiguration';
import { sessionRefreshSteps, type RefreshStep, type RefreshSteps } from '@/sync/sessionRefreshSteps';
import { isRefreshPending } from '@/sync/sessionRefreshProgress';
import { ENGINE_NAMES } from '@/sync/engineModelCatalog';
import { lmcColors } from '@/components/lmc/lmcColors';
import { lmcElevation, lmcSurfaceBorder } from '@/components/lmc/elevation';
import { ProgressStepRow, formatElapsed } from '@/components/lmc/ProgressSteps';
import { t } from '@/text';

/**
 * The refresh card: four steps at the top of the pane while a CLI refresh runs.
 *
 * A refresh walks the engine switch's road without the handoff — wait for the
 * turn, check the login, relaunch, verify — and used to be shown as one line
 * of state and a counter. Now it is the same step column the switch card
 * draws (see D12), in the same place this card has always lived: a refresh
 * does not change hands and leaves nothing in the transcript, so it has no
 * message to anchor to. It folds to one line when the refresh lands and goes
 * away ten seconds later. A failure stays as a compact receipt; the steps and
 * retry action only expand when asked, so an old failure cannot cover a reply.
 *
 * A card rather than a full-bleed bar: the pane's own controls sit in its
 * top-right corner, and a banner spanning the pane ran its counter under them.
 */
export function SessionRefreshBanner({ sessionId, maxWidth, minHeight }: { sessionId: string; maxWidth?: number | string; minHeight?: number }) {
    const session = useSession(sessionId);
    const { theme } = useUnistyles();
    const [now, setNow] = React.useState(Date.now);
    const meta = session?.metadata;
    const state = meta?.sessionConfigState;

    // When this device first saw the refresh pending — the fallback start for
    // a runner too old to stamp one. Reset whenever a refresh ends.
    const observedAt = React.useRef<number | null>(null);
    if (isRefreshPending(state)) observedAt.current ??= Date.now();
    else if (state === 'applied') observedAt.current = null;

    // A refresh that is part of an engine switch is narrated by the switch
    // card in the transcript; two accounts of one relaunch would disagree on
    // what it is waiting for.
    const { messages } = useSessionMessages(sessionId);
    const switchOwnsRefresh = React.useMemo(() => {
        const request = latestSwitchRequest(messages);
        if (!request) return false;
        const progress = engineSwitchProgress({ request, messages, metadata: meta, session: session ?? {}, now: Date.now() });
        return progress?.phase === 'running' || progress?.phase === 'failed';
    }, [messages, meta, session]);

    const steps = React.useMemo(() => sessionRefreshSteps({ metadata: meta, session: session ?? {}, now, observedAt: observedAt.current }), [meta, session, now]);
    const ticking = steps.phase === 'running' || steps.phase === 'complete';
    React.useEffect(() => {
        if (!ticking) return;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [ticking, meta?.sessionConfigState, meta?.sessionConfigUpdatedAt]);

    if (!meta || switchOwnsRefresh || steps.phase === 'idle') return null;
    const frame = { width: '100%' as const, maxWidth: maxWidth as any, minHeight, justifyContent: minHeight ? 'center' as const : undefined, backgroundColor: theme.colors.surface, borderRadius: 16, ...lmcSurfaceBorder(theme), ...lmcElevation(theme, 1) };
    if (steps.phase === 'complete') {
        return (
            <View accessibilityLiveRegion="polite" style={[styles.card, frame, styles.completeCard]}>
                <Ionicons name="checkmark-circle" size={16} color={lmcColors(theme).brand} />
                <Text style={[styles.completeText, { color: theme.colors.text }]}>
                    {steps.tookMs != null ? t('lmc.refresh.completeTook', { seconds: Math.max(1, Math.round(steps.tookMs / 1000)) }) : t('lmc.refresh.complete')}
                </Text>
            </View>
        );
    }
    return <RefreshCard key={`${sessionId}:${meta.sessionConfigRequestedAt ?? ''}`} sessionId={sessionId} steps={steps} frame={frame} engine={meta.flavor === 'claude' || meta.flavor === 'codex' ? ENGINE_NAMES[meta.flavor] : (meta.flavor ?? '')} host={meta.host ?? null} />;
}

function RefreshCard({ sessionId, steps, frame, engine, host }: {
    sessionId: string;
    steps: Extract<RefreshSteps, { phase: 'running' | 'failed' }>;
    frame: object;
    engine: string;
    host: string | null;
}) {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const [busy, setBusy] = React.useState<'retry' | 'cancel' | 'wait' | 'stop' | null>(null);
    const [notice, setNotice] = React.useState('');
    const [detailsOpen, setDetailsOpen] = React.useState(false);
    const [confirmStop, setConfirmStop] = React.useState(false);
    const failed = steps.phase === 'failed';
    // Claude's own background work is what stands in the way. The card then
    // offers the two ways through instead of a retry that would hit it again.
    const heldByWork = steps.backgroundWork !== null;
    const waitingForWork = !failed && heldByWork;

    const retry = async (choice?: 'wait' | 'stop') => {
        setBusy(choice ?? 'retry'); setNotice(''); setConfirmStop(false);
        try { await retrySessionRefresh(sessionId, choice); }
        catch (error) { setNotice(error instanceof Error ? error.message : t('localFeatures.configFailed')); }
        finally { setBusy(null); }
    };
    // Stopping someone's scheduled work is theirs to confirm: the first press
    // names what would stop, the second does it.
    const stop = () => {
        if (!confirmStop) { setConfirmStop(true); return; }
        void retry('stop');
    };
    const cancel = async () => {
        setBusy('cancel'); setNotice('');
        try {
            const outcome = await cancelSessionRefresh(sessionId);
            if (outcome === 'too-late') setNotice(t('lmc.engineSwitch.cancelTooLate'));
        } catch (error) { setNotice(error instanceof Error ? error.message : t('lmc.engineSwitch.cancelFailed')); }
        finally { setBusy(null); }
    };

    const subtitle = failed ? t('lmc.refresh.failed') : t('lmc.refresh.running');
    const loginCommand = engine === ENGINE_NAMES.codex ? 'codex login' : 'claude auth login';
    if (failed && !detailsOpen) {
        return (
            <View testID="session-refresh-banner" accessibilityLiveRegion="polite" style={[styles.card, frame, styles.compactCard]}>
                <Pressable accessibilityRole="button" accessibilityLabel={t('lmc.refresh.showDetails')} accessibilityState={{ expanded: false }}
                    onPress={() => setDetailsOpen(true)} style={styles.compactSummary}>
                    <Ionicons name="alert-circle-outline" size={18} color={theme.colors.status.error} />
                    <View style={styles.summaryText}>
                        <Text style={[styles.engine, { color: theme.colors.text }]} numberOfLines={1}>{engine} · {t('lmc.refresh.failedShort')}</Text>
                        <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                            {steps.stalled ? t('lmc.refresh.stalled') : steps.error || t('lmc.refresh.failedUnknown')}
                        </Text>
                    </View>
                    <Text style={[styles.elapsed, { color: theme.colors.textSecondary }]}>{formatElapsed(steps.elapsedMs)}</Text>
                    <Ionicons name="chevron-down" size={16} color={theme.colors.textSecondary} />
                </Pressable>
            </View>
        );
    }
    return (
        <View testID="session-refresh-banner" accessibilityLiveRegion="polite" style={[styles.card, frame]}>
            <View style={styles.header}>
                <View style={styles.route}>
                    <Text style={[styles.engine, { color: theme.colors.textSecondary }]}>{engine}</Text>
                    <Text style={[styles.engine, { color: theme.colors.textSecondary }]}>·</Text>
                    <Text style={[styles.engine, { color: theme.colors.text }]} numberOfLines={1}>{t('lmc.refresh.title')}</Text>
                </View>
                <Text style={[styles.elapsed, { color: theme.colors.textSecondary }]}>{formatElapsed(steps.elapsedMs)}</Text>
                {failed && (
                    <Pressable accessibilityRole="button" accessibilityLabel={t('lmc.refresh.hideDetails')} accessibilityState={{ expanded: true }}
                        onPress={() => setDetailsOpen(false)} style={styles.collapse}>
                        <Ionicons name="chevron-up" size={18} color={theme.colors.textSecondary} />
                    </Pressable>
                )}
            </View>
            <Text style={[styles.subtitle, { color: failed ? theme.colors.status.error : theme.colors.textSecondary }]}>{subtitle}</Text>

            <View style={styles.steps}>
                {steps.steps.map((step) => {
                    const notLoggedIn = step.detail?.kind === 'not-logged-in';
                    const error = failed && step.tone === 'failed' && !notLoggedIn
                        ? (step.detail?.kind === 'stalled' ? t('lmc.refresh.stalled') : (steps.error || t('lmc.refresh.failedUnknown')))
                        : null;
                    return (
                        <ProgressStepRow
                            key={step.key}
                            tone={step.tone}
                            title={stepTitle(step, engine)}
                            detail={error ?? (notLoggedIn ? t('lmc.engineSwitch.stepPreflightNotLoggedIn', { engine }) : describeDetail(step))}
                            command={notLoggedIn ? { text: loginCommand, host } : null}
                        />
                    );
                })}
            </View>

            {!failed && steps.slow && !waitingForWork ? <Text style={[styles.note, { color: theme.colors.textSecondary }]}>{t('lmc.refresh.slow')}</Text> : null}
            {heldByWork && (
                <View style={styles.workNote}>
                    <Text style={[styles.note, { color: theme.colors.text, paddingTop: 0 }]}>{waitingForWork ? t('lmc.refresh.waitingForWork') : t('lmc.refresh.backgroundWorkHeld')}</Text>
                    <Text style={[styles.note, { color: confirmStop ? theme.colors.status.error : theme.colors.textSecondary, paddingTop: 4 }]}>
                        {steps.backgroundWork!.length ? t('lmc.refresh.backgroundWorkList', { work: steps.backgroundWork!.join('；') }) : t('lmc.refresh.backgroundWorkUnknown')}
                    </Text>
                </View>
            )}
            {(failed || steps.cancellable || heldByWork || notice) && (
                <View style={[styles.actions, heldByWork && styles.actionsWrap]}>
                    {notice ? <Text style={[styles.notice, { color: failed ? theme.colors.status.error : theme.colors.textSecondary }]}>{notice}</Text> : heldByWork ? null : <View style={{ flex: 1 }} />}
                    {!failed && steps.cancellable && (
                        <Pressable accessibilityRole="button" disabled={busy !== null} onPress={cancel} style={({ pressed }) => [styles.secondary, { borderColor: colors.border, opacity: busy ? 0.6 : pressed ? 0.7 : 1 }]}>
                            {busy === 'cancel' ? <ActivityIndicator size="small" color={theme.colors.textSecondary} /> : <Text style={[styles.buttonLabel, { color: theme.colors.text }]}>{t('lmc.refresh.cancel')}</Text>}
                        </Pressable>
                    )}
                    {failed && heldByWork && (
                        <Pressable accessibilityRole="button" disabled={busy !== null} onPress={() => retry('wait')} style={({ pressed }) => [styles.secondary, { borderColor: colors.border, opacity: busy ? 0.6 : pressed ? 0.7 : 1 }]}>
                            {busy === 'wait' ? <ActivityIndicator size="small" color={theme.colors.textSecondary} /> : <Text style={[styles.buttonLabel, { color: theme.colors.text }]}>{t('lmc.refresh.waitForWork')}</Text>}
                        </Pressable>
                    )}
                    {heldByWork && (
                        <Pressable accessibilityRole="button" disabled={busy !== null} onPress={stop} style={({ pressed }) => [styles.primary, { backgroundColor: confirmStop ? theme.colors.status.error : colors.brand, opacity: busy ? 0.6 : pressed ? 0.85 : 1 }]}>
                            {busy === 'stop' ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Text style={[styles.buttonLabel, { color: '#FFFFFF' }]}>{confirmStop ? t('lmc.refresh.stopWorkConfirm') : t('lmc.refresh.stopWork')}</Text>}
                        </Pressable>
                    )}
                    {failed && !heldByWork && (
                        <Pressable accessibilityRole="button" disabled={busy !== null} onPress={() => retry()} style={({ pressed }) => [styles.primary, { backgroundColor: colors.brand, opacity: busy ? 0.6 : pressed ? 0.85 : 1 }]}>
                            {busy === 'retry' ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Text style={[styles.buttonLabel, { color: '#FFFFFF' }]}>{t('lmc.refresh.retry')}</Text>}
                        </Pressable>
                    )}
                </View>
            )}
        </View>
    );
}

function stepTitle(step: RefreshStep, engine: string): string {
    switch (step.key) {
        case 'turn': return t('lmc.refresh.stepTurn');
        case 'preflight': return t('lmc.refresh.stepPreflight', { engine });
        case 'restart': return t('lmc.refresh.stepRestart');
        case 'verify': return t('lmc.refresh.stepVerify');
    }
}

function describeDetail(step: RefreshStep): string | null {
    const detail = step.detail;
    if (!detail) return null;
    switch (detail.kind) {
        case 'runner': return detail.text;
        case 'wait': return t(({
            permission: 'localFeatures.refreshWaitPermission',
            thinking: 'localFeatures.refreshWaitTurn',
            queue: 'localFeatures.refreshWaitHint',
        } as const)[detail.reason]);
        case 'checking': return t('lmc.engineSwitch.stepPreflightChecking');
        case 'restarting': return t('localFeatures.refreshRestarting');
        case 'verifying': return t('localFeatures.refreshVerifying');
        case 'stalled': return null;
        case 'not-logged-in': return null;
    }
}

const styles = StyleSheet.create(() => ({
    card: { padding: 16, gap: 4 },
    compactCard: { minHeight: 0, paddingVertical: 8, paddingHorizontal: 12 },
    compactSummary: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10 },
    summaryText: { flex: 1, minWidth: 0, gap: 2 },
    collapse: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
    completeCard: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 },
    completeText: { fontSize: 14, fontWeight: '600' },
    header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    route: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
    engine: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
    elapsed: { fontSize: 12, fontVariant: ['tabular-nums'] },
    subtitle: { fontSize: 13, lineHeight: 18 },
    steps: { gap: 12, paddingTop: 12 },
    note: { fontSize: 12, lineHeight: 17, paddingTop: 12 },
    actions: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 16 },
    actionsWrap: { flexWrap: 'wrap', justifyContent: 'flex-end' },
    workNote: { paddingTop: 12 },
    notice: { flex: 1, fontSize: 12, lineHeight: 16 },
    secondary: { minWidth: 88, height: 36, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
    primary: { minWidth: 72, height: 36, paddingHorizontal: 16, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
    buttonLabel: { fontSize: 14, fontWeight: '600' },
}));
