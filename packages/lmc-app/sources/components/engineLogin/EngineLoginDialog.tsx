import * as React from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, TextInput, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { QRCode } from '@/components/qr/QRCode';
import { lmcSurfaceBorder } from '@/components/lmc/elevation';
import { useMachine, useSession } from '@/sync/storage';
import { engineLoginError } from '@/sync/engineLogin';
import { useEngineLogin } from './useEngineLogin';
import { isEngineLoginUrl, loginIsTerminal, type EngineLoginError, type EngineLoginSnapshot } from 'lmc-wire';
import { t } from '@/text';

type Action = 'start' | 'check' | 'submit' | 'cancel';
type PanelProps = {
    engine: 'claude' | 'codex'; host: string; online: boolean;
    flow: EngineLoginSnapshot | null; error?: EngineLoginError; busy?: boolean;
    onAction(action: Action, extra?: { id?: string; code?: string }): Promise<unknown> | void;
    onClose?(): void;
};

/** D21 presentation is shared by mobile and desktop, including exceptional states. */
export function EngineLoginPanel({ engine, host, online, flow, error, busy, onAction, onClose }: PanelProps) {
    const { theme } = useUnistyles();
    const { width, height } = useWindowDimensions();
    const desktop = width >= 720;
    const [codeMode, setCodeMode] = React.useState(false);
    const [code, setCode] = React.useState('');
    const [copied, setCopied] = React.useState(false);
    const [linkError, setLinkError] = React.useState(false);
    const [now, setNow] = React.useState(Date.now());
    React.useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
    React.useEffect(() => { setCode(''); setCodeMode(false); setCopied(false); setLinkError(false); }, [flow?.id]);
    React.useEffect(() => { if (flow?.state !== 'waiting') setCode(''); }, [flow?.state]);
    const brand = theme.dark ? '#6DA8FF' : '#0060F0';
    const muted = theme.dark ? 'rgba(255,255,255,0.06)' : '#F5F6F8';
    const text = { color: theme.colors.text, fontSize: 14, lineHeight: 21, ...Typography.default() };
    const secondary = { ...text, color: theme.colors.textSecondary, fontSize: 13, lineHeight: 19 };
    const state = flow?.state ?? 'starting';
    const terminal = flow && loginIsTerminal(state);
    const recovering = state === 'recovering' || state === 'complete';
    const effectiveError = !online ? 'offline' : error ?? flow?.error;
    const url = flow?.authorizationUrl && isEngineLoginUrl(engine, flow.authorizationUrl) ? flow.authorizationUrl : undefined;
    const seconds = Math.max(0, Math.ceil(((flow?.expiresAt ?? now) - now) / 1000));
    const canAuthorize = online && !!url && !terminal && seconds > 0 && (state === 'waiting' || state === 'submitting');
    const engineName = engine === 'claude' ? 'Claude Code' : 'Codex';
    const title = recovering ? t(state === 'complete' ? 'localFeatures.loginComplete' : 'localFeatures.loginRecovering') : codeMode ? t('localFeatures.loginCodeTitle') : `${engineName} · ${t('localFeatures.loginTitle')}`;
    const button = (label: string, onPress: () => void, primary = false, disabled = false, testID?: string) => <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: primary ? brand : muted, opacity: disabled ? 0.45 : pressed ? 0.7 : 1 })}>
        <Text style={{ ...text, textAlign: 'center', color: primary ? (theme.dark ? '#10243B' : '#FFFFFF') : theme.colors.text, ...Typography.default('semiBold') }}>{label}</Text>
    </Pressable>;
    const open = () => { if (canAuthorize && url) { setLinkError(false); void Linking.openURL(url).catch(() => setLinkError(true)); } };
    const waiting = ['checking', 'starting', 'submitting', 'verifying'].includes(state);
    const statusLabel = state === 'checking' ? t('localFeatures.loginAutoCheck') : state === 'starting' ? t('localFeatures.loginStarting') : state === 'submitting' ? t('localFeatures.loginSubmitting') : state === 'verifying' ? t('localFeatures.loginVerifying') : t('localFeatures.loginWaiting');
    const failures = flow?.sessions.filter(s => s.state === 'failed' || s.state === 'upgrade').length ?? 0;
    return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 16 }}>
        <View testID="engine-login-panel" style={{ width: Math.min(desktop ? 680 : 406, width - 32), maxHeight: height - 48, borderRadius: 20, backgroundColor: theme.colors.surface, ...lmcSurfaceBorder(theme), overflow: 'hidden' }}>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: desktop ? 24 : 20, gap: 16 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text accessibilityRole="header" style={{ ...text, fontSize: 20, lineHeight: 28, flex: 1, ...Typography.default('semiBold') }}>{title}</Text>
                    <Pressable accessibilityRole="button" accessibilityLabel={t('localFeatures.loginClose')} onPress={onClose} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><Ionicons name="close-outline" size={24} color={theme.colors.textSecondary} /></Pressable>
                </View>
                <View style={{ backgroundColor: muted, borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <Ionicons name="laptop-outline" size={22} color={theme.colors.textSecondary} />
                    <View style={{ flex: 1 }}><Text style={text}>{host} · {engineName}</Text><Text style={secondary}>{t('localFeatures.loginDevice')} · {t(online ? 'localFeatures.onlineState' : 'localFeatures.offlineState')}</Text></View>
                    <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: online ? '#288C60' : theme.colors.textSecondary }} />
                </View>
                {effectiveError && <View accessibilityLiveRegion="polite" testID="engine-login-error" style={{ backgroundColor: muted, borderRadius: 12, padding: 12 }}><Text style={text}>{engineLoginError(effectiveError)}</Text></View>}
                {recovering ? <>
                    <Text style={secondary}>{t('localFeatures.loginSafeHint')}</Text>
                    {!flow?.sessions.length && <ActivityIndicator color={brand} />}
                    {(['restored', 'waiting', 'failed', 'upgrade'] as const).map(status => {
                        const count = flow?.sessions.filter(s => s.state === status).length ?? 0;
                        if (!count) return null;
                        return <View key={status} testID={`engine-login-${status}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 }}>
                            <Ionicons name={status === 'restored' ? 'checkmark-circle-outline' : status === 'waiting' ? 'time-outline' : 'alert-circle-outline'} size={22} color={status === 'restored' ? '#288C60' : theme.colors.textSecondary} />
                            <Text style={{ ...text, flex: 1 }}>{count} · {t(status === 'restored' ? 'localFeatures.loginRestored' : status === 'waiting' ? 'localFeatures.loginWaitTurn' : status === 'upgrade' ? 'localFeatures.engineAgentUpgrade' : 'localFeatures.loginFailedSession')}</Text>
                        </View>;
                    })}
                    <Text style={secondary}>{t('localFeatures.loginNoResend')}</Text>
                    {failures > 0 && state === 'complete' && button(t('localFeatures.loginRetryRecovery'), () => void onAction('check'), false, busy || !online)}
                    {button(t('localFeatures.loginReturn'), () => onClose?.(), true)}
                </> : terminal ? <>
                    {button(t('localFeatures.loginRetry'), () => { setCodeMode(false); void onAction('start'); }, true, busy || !online || effectiveError === 'upgrade' || effectiveError === 'unsupported')}
                    {button(t('localFeatures.loginRecheck'), () => void onAction('check'), false, busy || !online)}
                    <Text style={secondary}>{t('localFeatures.loginNoResend')}</Text>
                </> : <>
                    {canAuthorize && <View style={{ flexDirection: desktop ? 'row' : 'column', gap: 24 }}>
                        {desktop && !codeMode && <View style={{ alignItems: 'center', gap: 10, width: 192 }}><View testID="engine-login-qr" style={{ padding: 8, backgroundColor: '#FFFFFF', borderRadius: 12 }}><QRCode data={url!} size={176} errorCorrectionLevel="medium" /></View><Text style={{ ...secondary, textAlign: 'center' }}>{t('localFeatures.loginQr')}</Text></View>}
                        <View style={{ flex: 1, gap: 12, minWidth: 0 }}>
                            <Text style={text}>{t(codeMode ? 'localFeatures.loginCodeHint' : engine === 'codex' ? 'localFeatures.loginDeviceHint' : 'localFeatures.loginOfficialHint')}</Text>
                            {engine === 'claude' && !codeMode && <Text style={secondary}>{t('localFeatures.loginGoogleHint')}</Text>}
                            {engine === 'codex' && flow?.userCode && <Text selectable testID="engine-login-device-code" style={{ ...text, fontSize: 24, letterSpacing: 3, textAlign: 'center', backgroundColor: muted, borderRadius: 12, padding: 12, ...Typography.default('semiBold') }}>{flow.userCode}</Text>}
                            {codeMode && engine === 'claude' ? <>
                                <TextInput testID="engine-login-code" accessibilityLabel={t('localFeatures.loginCodePlaceholder')} placeholder={t('localFeatures.loginCodePlaceholder')} placeholderTextColor={theme.colors.textSecondary} value={code} onChangeText={setCode} autoCapitalize="none" autoCorrect={false} autoComplete="off" secureTextEntry editable={state === 'waiting' && !busy} maxLength={4096} style={{ ...text, minHeight: 48, padding: 12, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 12 }} />
                                {button(t('localFeatures.loginSubmit'), () => { const once = code; setCode(''); void onAction('submit', { id: flow!.id, code: once }); }, true, busy || state !== 'waiting' || !code.trim(), 'engine-login-submit')}
                                {button(t('localFeatures.loginBack'), () => { setCode(''); setCodeMode(false); })}
                            </> : <>
                                {button(t('localFeatures.loginOpen'), open, true, busy, 'engine-login-open')}
                                {button(t(copied ? 'localFeatures.loginCopied' : 'localFeatures.loginCopyLink'), () => { void Clipboard.setStringAsync(url!).then(() => setCopied(true)).catch(() => setLinkError(true)); })}
                                {engine === 'claude' && button(t('localFeatures.loginHasCode'), () => setCodeMode(true), false, state !== 'waiting', 'engine-login-has-code')}
                            </>}
                            {linkError && <Text style={secondary}>{t('localFeatures.loginCopyLink')} · {url ? new URL(url).host : ''}</Text>}
                        </View>
                    </View>}
                    <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                        {waiting && !effectiveError ? <ActivityIndicator size="small" color={brand} /> : <Ionicons name="time-outline" size={18} color={theme.colors.textSecondary} />}
                        <Text style={{ ...secondary, flex: 1 }}>{effectiveError && !flow ? t('localFeatures.loginHint') : statusLabel}</Text>
                    </View>
                    {flow && <Text style={secondary}>{t('localFeatures.loginLifetime')} · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</Text>}
                    <Text style={secondary}>{t('localFeatures.loginKeepRunning')}</Text>
                    {flow && button(t('localFeatures.loginCancel'), () => { setCode(''); void onAction('cancel', { id: flow.id }); }, false, busy || !online)}
                    {!flow && effectiveError && button(t('localFeatures.loginRecheck'), () => void onAction('check'), false, busy || !online || effectiveError === 'upgrade')}
                </>}
            </ScrollView>
        </View>
    </KeyboardAvoidingView>;
}

export function EngineLoginDialog({ sessionId, initialAction = 'start', onClose }: { sessionId: string; initialAction?: 'start' | 'check'; onClose?: () => void }) {
    const session = useSession(sessionId);
    const machine = useMachine(session?.metadata?.machineId ?? '');
    const login = useEngineLogin(sessionId);
    React.useEffect(() => { void login.request(initialAction); }, [sessionId, initialAction, login.request]);
    return <EngineLoginPanel engine={session?.metadata?.flavor === 'codex' ? 'codex' : 'claude'} host={machine?.metadata?.displayName || session?.metadata?.host || ''} online={!!machine?.active} flow={login.flow} error={login.error} busy={login.busy} onAction={login.request} onClose={onClose} />;
}
