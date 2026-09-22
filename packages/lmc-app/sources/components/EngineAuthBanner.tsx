import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useSession, useMachine } from '@/sync/storage';
import { checkSessionAuthentication } from '@/sync/engineAuthentication';
import { sessionCapabilities } from '@/sync/sessionCapabilities';
import { lmcElevation, lmcSurfaceBorder } from '@/components/lmc/elevation';
import { t } from '@/text';
import { Modal } from '@/modal';
import { EngineLoginDialog } from './engineLogin/EngineLoginDialog';
import { useEngineLogin } from './engineLogin/useEngineLogin';
import { engineLoginError, shouldAutoRecover } from '@/sync/engineLogin';
import { loginIsTerminal } from 'lmc-wire';

/** Same card treatment as the refresh banner; see the note there. */
export function EngineAuthBanner({ sessionId, maxWidth, minHeight }: { sessionId: string; maxWidth?: number | string; minHeight?: number }) {
    const session = useSession(sessionId);
    const { theme } = useUnistyles();
    const [checking, setChecking] = React.useState(false);
    const [error, setError] = React.useState('');
    const metadata = session?.metadata;
    const machine = useMachine(metadata?.machineId ?? '');
    const engineKey = metadata?.flavor === 'codex' ? 'codex' : 'claude';
    const supported = !!metadata?.sessionCapabilities?.authenticationRecovery && !!machine?.metadata?.engineLogin?.[engineKey];
    const needsAuth = !!metadata?.engineAuth && metadata.engineAuth.status !== 'ready';
    const login = useEngineLogin(sessionId, supported && needsAuth);
    const relevant = login.flow?.sourceSessionId === sessionId || login.flow?.sessions.some(job => job.sessionId === sessionId);
    const inProgress = relevant && login.flow && !loginIsTerminal(login.flow.state);
    const recovering = inProgress && login.flow?.state === 'recovering';
    const checkingAuth = inProgress && ['checking', 'verifying'].includes(login.flow!.state);
    React.useEffect(() => {
        if (supported && needsAuth && machine?.active && metadata?.engineAuth && shouldAutoRecover(sessionId, metadata.engineAuth.checkedAt)) void login.request('auto');
    }, [sessionId, supported, needsAuth, machine?.active, metadata?.engineAuth?.checkedAt, login.request]);
    if (!metadata?.engineAuth || (!needsAuth && !inProgress)) return null;
    if (supported) return <View accessibilityLiveRegion="polite" style={{ width: '100%', maxWidth: maxWidth as any, padding: 16, gap: 10, backgroundColor: theme.colors.surface, borderRadius: 16, ...lmcSurfaceBorder(theme) }}>
        <Text style={{ color: theme.colors.text, fontWeight: '600', fontSize: 16 }}>{engineKey === 'claude' ? 'Claude Code' : 'Codex'} · {t(recovering ? 'localFeatures.loginRecovering' : checkingAuth ? 'localFeatures.loginAutoCheck' : inProgress ? 'localFeatures.loginWaiting' : metadata.engineAuth.status === 'unknown' ? 'localFeatures.engineAuthUnknown' : 'localFeatures.loginTitle')}</Text>
        <Text style={{ color: theme.colors.textSecondary }}>{metadata.host} · {t(recovering ? 'localFeatures.loginSafeHint' : 'localFeatures.loginHint')}</Text>
        {login.flow?.state === 'checking' && <ActivityIndicator size="small" />}
        {!machine?.active && <Text style={{ color: theme.colors.textSecondary }}>{engineLoginError('offline')}</Text>}
        {(login.error || login.flow?.error) && <Text style={{ color: theme.colors.textSecondary }}>{engineLoginError(login.error ?? login.flow!.error!)}</Text>}
        <View style={{ gap: 8, flexDirection: 'row', flexWrap: 'wrap' }}>
            <Pressable accessibilityRole="button" disabled={!machine?.active} onPress={() => Modal.show({ component: EngineLoginDialog, props: { sessionId } })} style={{ minHeight: 44, paddingHorizontal: 16, justifyContent: 'center', borderRadius: 22, backgroundColor: theme.dark ? '#6DA8FF' : '#0060F0', opacity: machine?.active ? 1 : 0.45 }}>
                <Text style={{ color: theme.dark ? '#10243B' : '#FFFFFF', fontWeight: '600' }}>{t(recovering ? 'localFeatures.loginViewRecovery' : inProgress ? 'localFeatures.loginContinue' : 'localFeatures.loginTitle')} {metadata.host}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" disabled={!machine?.active || login.busy} onPress={() => Modal.show({ component: EngineLoginDialog, props: { sessionId, initialAction: 'check' } })} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 }}><Text style={{ color: theme.colors.text }}>{t('localFeatures.loginRecheck')}</Text></Pressable>
        </View>
    </View>;
    const engine = metadata.flavor === 'codex' ? 'Codex' : 'Claude Code';
    return <View accessibilityLiveRegion="polite" style={{ width: '100%', maxWidth: maxWidth as any, minHeight, justifyContent: minHeight ? 'center' : undefined, padding: 12, gap: 6, backgroundColor: theme.colors.surface, borderRadius: 16, ...lmcSurfaceBorder(theme), ...lmcElevation(theme, 1) }}>
        <Text style={{ color:theme.colors.text, fontWeight:'600' }}>{engine} · {t(metadata.engineAuth.status === 'required' ? 'localFeatures.engineAuthRequired' : 'localFeatures.engineAuthUnknown')}</Text>
        <Text style={{ color:theme.colors.textSecondary }}>{t('localFeatures.loginErrorUpgrade')}</Text>
        <Text style={{ color:theme.colors.textSecondary }}>{t('localFeatures.engineAuthHint')} {metadata.host}</Text>
        <Text selectable style={{ color:theme.colors.text }}>{metadata.flavor === 'codex' ? 'codex login' : 'claude auth login'}</Text>
        {!!error && <Text style={{color:theme.colors.status.error}}>{error}</Text>}
        <Pressable accessibilityRole="button" disabled={checking || !session?.active || !sessionCapabilities(metadata).authentication} onPress={async()=>{
            setChecking(true);setError('');
            try { await checkSessionAuthentication(sessionId); }
            catch { setError(t('localFeatures.engineAuthCheckFailed')); }
            finally { setChecking(false); }
        }} style={{ minHeight:44, flexDirection:'row', alignItems:'center', gap:8 }}>
            {checking && <ActivityIndicator size="small" />}
            <Text style={{color:theme.colors.text}}>{t(checking ? 'localFeatures.engineAuthChecking' : 'localFeatures.engineAuthCheck')}</Text>
        </Pressable>
    </View>;
}
