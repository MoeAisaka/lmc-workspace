import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useSession, useSessionMessages } from '@/sync/storage';
import { engineSwitchProgress, type EngineSwitchProgress, type SwitchStep } from '@/sync/engineSwitchProgress';
import { ENGINE_NAMES, engineModelGroups } from '@/sync/engineModelCatalog';
import { cancelSessionSwitch, peekPendingEngineModel, retrySessionRefresh, switchSessionEngine } from '@/sync/sessionConfiguration';
import type { UserTextMessage } from '@/sync/typesMessage';
import { lmcColors } from './lmcColors';
import { lmcElevation, lmcSurfaceBorder } from './elevation';
import { ProgressStepRow, formatElapsed } from './ProgressSteps';
import { t } from '@/text';

/**
 * One card for the whole switch, drawn where the request bubble used to be.
 *
 * A switch spends most of its time looking, to the app, like a session that
 * has gone quiet: the old engine is writing, then finishing its turn, then
 * gone; the new one is starting. Each of those used to surface as a different
 * fragment — a bubble, a refresh card, an inactive hint — none of which knew a
 * switch was happening. This card reads them all against the request that
 * started it (see engineSwitchProgress) and lights the four steps in turn.
 *
 * It renders nothing once the switch has completed: the handoff rule that the
 * arriving engine draws is the record, and carries the time it took. A
 * request superseded by a later one collapses to a single muted line.
 */
export function EngineSwitchCard({ sessionId, message }: { sessionId: string; message: UserTextMessage }) {
    const session = useSession(sessionId);
    const { messages } = useSessionMessages(sessionId);
    const [now, setNow] = React.useState(Date.now);
    const progress = React.useMemo(() => engineSwitchProgress({
        request: message,
        messages,
        metadata: session?.metadata,
        session: session ?? {},
        now,
    }), [message, messages, session, now]);
    const running = progress?.phase === 'running';
    React.useEffect(() => {
        if (!running) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [running]);

    if (!progress || progress.phase === 'complete') return null;
    if (progress.phase === 'superseded' || progress.phase === 'cancelled') {
        return <Text style={styles.superseded}>{t(progress.phase === 'cancelled' ? 'lmc.engineSwitch.cancelled' : 'lmc.engineSwitch.superseded')}</Text>;
    }
    return <SwitchCard sessionId={sessionId} progress={progress} active={!!session?.active} host={session?.metadata?.host ?? null} />;
}

function SwitchCard({ sessionId, progress, active, host }: { sessionId: string; progress: Extract<EngineSwitchProgress, { phase: 'running' | 'failed' }>; active: boolean; host: string | null }) {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const [retrying, setRetrying] = React.useState(false);
    const [retryError, setRetryError] = React.useState('');
    const [cancelling, setCancelling] = React.useState(false);
    const [notice, setNotice] = React.useState('');
    const failed = progress.phase === 'failed';
    const to = ENGINE_NAMES[progress.to];
    const from = ENGINE_NAMES[progress.from];
    const modelName = useChosenModelName(sessionId, progress.to);

    const retry = async () => {
        setRetrying(true); setRetryError('');
        try {
            // A live session can be asked again; a dead one can only be brought
            // back, on the engine it was on, and asked after that.
            if (active) await switchSessionEngine(sessionId, progress.to);
            else await retrySessionRefresh(sessionId);
        } catch (error) {
            setRetryError(error instanceof Error ? error.message : t('lmc.engineSwitch.failed'));
        } finally { setRetrying(false); }
    };

    // Say where the session is only when that is known: "still on Claude
    // Code" is a comfort when true and a lie when the relaunch died halfway.
    const cancel = async () => {
        setCancelling(true); setNotice('');
        try {
            const outcome = await cancelSessionSwitch(sessionId);
            if (outcome === 'too-late') setNotice(t('lmc.engineSwitch.cancelTooLate'));
        } catch (error) {
            setNotice(error instanceof Error ? error.message : t('lmc.engineSwitch.cancelFailed'));
        } finally { setCancelling(false); }
    };

    const failureLine = !failed ? null
        : progress.afterRestart ? t('lmc.engineSwitch.failedAfterRestart', { engine: to })
        : progress.stillOn === progress.from ? t('lmc.engineSwitch.failedStill', { engine: from })
        : t('lmc.engineSwitch.failed');

    return (
        <View accessibilityLiveRegion="polite" style={[styles.card, { backgroundColor: theme.colors.surface, ...lmcSurfaceBorder(theme), ...lmcElevation(theme, 1) }]}>
            <View style={styles.header}>
                <View style={styles.route}>
                    <Text style={[styles.engine, { color: theme.colors.textSecondary }]}>{from}</Text>
                    <Ionicons name="arrow-forward" size={13} color={theme.colors.textSecondary} />
                    <Text style={[styles.engine, { color: theme.colors.text }]} numberOfLines={1}>
                        {to}{modelName ? ` · ${modelName}` : ''}
                    </Text>
                </View>
                <Text style={[styles.elapsed, { color: theme.colors.textSecondary }]}>{formatElapsed(progress.elapsedMs)}</Text>
            </View>
            <Text style={[styles.subtitle, { color: failed ? theme.colors.status.error : theme.colors.textSecondary }]}>
                {failureLine ?? t('lmc.engineSwitch.progressTitle')}
            </Text>

            <View style={styles.steps}>
                {progress.steps.map((step) => (
                    <StepRow
                        key={step.key}
                        step={step}
                        to={to}
                        from={from}
                        host={host}
                        loginCommand={progress.to === 'codex' ? 'codex login' : 'claude auth login'}
                        error={failed && step.state === 'failed' && step.detail?.kind !== 'not-logged-in' ? (progress.error || t('lmc.engineSwitch.failedUnknown')) : null}
                    />
                ))}
            </View>

            {!failed && progress.cancellable && (
                <View style={styles.actions}>
                    {notice ? <Text style={[styles.retryError, { color: theme.colors.textSecondary }]}>{notice}</Text> : <View style={{ flex: 1 }} />}
                    <Pressable
                        accessibilityRole="button"
                        disabled={cancelling}
                        onPress={cancel}
                        style={({ pressed }) => [styles.cancel, { borderColor: colors.border, opacity: cancelling ? 0.6 : pressed ? 0.7 : 1 }]}
                    >
                        {cancelling
                            ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                            : <Text style={[styles.cancelLabel, { color: theme.colors.text }]}>{t('lmc.engineSwitch.cancel')}</Text>}
                    </Pressable>
                </View>
            )}
            {!failed && !progress.cancellable && notice ? <Text style={[styles.retryError, { color: theme.colors.textSecondary, paddingTop: 12 }]}>{notice}</Text> : null}

            {failed && (
                <View style={styles.actions}>
                    {retryError ? <Text style={[styles.retryError, { color: theme.colors.status.error }]}>{retryError}</Text> : <View style={{ flex: 1 }} />}
                    <Pressable
                        accessibilityRole="button"
                        disabled={retrying}
                        onPress={retry}
                        style={({ pressed }) => [styles.retry, { backgroundColor: colors.brand, opacity: retrying ? 0.6 : pressed ? 0.85 : 1 }]}
                    >
                        {retrying
                            ? <ActivityIndicator size="small" color="#FFFFFF" />
                            : <Text style={styles.retryLabel}>{t('lmc.engineSwitch.retry')}</Text>}
                    </Pressable>
                </View>
            )}
        </View>
    );
}

function StepRow({ step, to, from, host, loginCommand, error }: { step: SwitchStep; to: string; from: string; host: string | null; loginCommand: string; error: string | null }) {
    const title = ({
        handoff: t('lmc.engineSwitch.stepHandoff', { engine: from }),
        turn: t('lmc.engineSwitch.stepTurn'),
        preflight: t('lmc.engineSwitch.stepPreflight', { engine: to }),
        restart: t('lmc.engineSwitch.stepRestart', { engine: to }),
        read: t('lmc.engineSwitch.stepRead', { engine: to }),
    } as const)[step.key];
    const notLoggedIn = step.detail?.kind === 'not-logged-in';
    return (
        <ProgressStepRow
            tone={step.state}
            title={title}
            detail={error ?? (notLoggedIn ? t('lmc.engineSwitch.stepPreflightNotLoggedIn', { engine: to }) : describeDetail(step))}
            command={notLoggedIn ? { text: loginCommand, host } : null}
        />
    );
}

function describeDetail(step: SwitchStep): string | null {
    const detail = step.detail;
    if (!detail) return null;
    switch (detail.kind) {
        case 'writing': return t('lmc.engineSwitch.stepHandoffWriting');
        case 'engine': return t('lmc.engineSwitch.stepHandoffByEngine');
        case 'compiled': return t('lmc.engineSwitch.stepHandoffCompiled');
        case 'runner': return detail.text;
        case 'checking': return t('lmc.engineSwitch.stepPreflightChecking');
        case 'not-logged-in': return null;
        case 'wait': return t(({
            permission: 'localFeatures.refreshWaitPermission',
            thinking: 'localFeatures.refreshWaitTurn',
            queue: 'localFeatures.refreshWaitHint',
        } as const)[detail.reason]);
        case 'restarting': return t('localFeatures.refreshRestarting');
        case 'verifying': return t('lmc.engineSwitch.stepRestartVerifying');
        case 'reading': return t('lmc.engineSwitch.stepReadWaiting');
    }
}

/** The display name of the model chosen with this switch, when one was and this device chose it. */
function useChosenModelName(sessionId: string, engine: 'claude' | 'codex'): string | null {
    const session = useSession(sessionId);
    const pending = peekPendingEngineModel(sessionId);
    return React.useMemo(() => {
        if (!pending || pending.engine !== engine) return null;
        const groups = engineModelGroups(session?.metadata?.flavor, session?.metadata ?? null, t, pending.modelKey) ?? [];
        for (const group of groups) {
            if (group.engine !== engine) continue;
            const hit = group.models.find((model) => model.key === pending.modelKey);
            if (hit) return hit.name;
        }
        return null;
    }, [pending?.modelKey, pending?.engine, engine, session?.metadata]);
}

const styles = StyleSheet.create((theme) => ({
    card: { marginHorizontal: 16, marginVertical: 8, borderRadius: 16, padding: 16, gap: 4 },
    header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    route: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
    engine: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
    elapsed: { fontSize: 12, fontVariant: ['tabular-nums'] },
    subtitle: { fontSize: 13, lineHeight: 18 },
    steps: { gap: 12, paddingTop: 12 },
    actions: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 16 },
    retryError: { flex: 1, fontSize: 12, lineHeight: 16 },
    retry: { minWidth: 72, height: 36, paddingHorizontal: 16, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
    retryLabel: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
    cancel: { minWidth: 88, height: 36, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
    cancelLabel: { fontSize: 14, fontWeight: '600' },
    superseded: { color: theme.colors.agentEventText, fontSize: 12, textAlign: 'center', paddingVertical: 8 },
}));
