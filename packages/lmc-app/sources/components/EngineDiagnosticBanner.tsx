import { Text } from '@/components/StyledText';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useSession } from '@/sync/storage';
import { engineDiagnosticNotice } from '@/sync/engineDiagnosticNotice';
import { lmcSurfaceBorder } from '@/components/lmc/elevation';
import { t } from '@/text';
import { supportsNativeAppApproval } from '@/sync/nativeAppApproval';
import { useNativeAppApproval } from '@/hooks/useNativeAppApproval';
import { NativeAppApprovalCard } from './NativeAppApprovalCard';
import { openClaudeNative } from './ClaudeNativeDialog';

export function EngineDiagnosticBanner({ sessionId, maxWidth, visible = true }: { sessionId: string; maxWidth?: number | string; visible?: boolean }) {
    const session = useSession(sessionId);
    const { theme } = useUnistyles();
    const diagnostics = session?.agentState?.engineDiagnostics;
    const nativeSupported = supportsNativeAppApproval(session);
    const approval = useNativeAppApproval(sessionId, nativeSupported && visible, !!session?.active);
    const [now, setNow] = React.useState(Date.now);
    React.useEffect(() => {
        if (!diagnostics?.noProgress) return;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 15_000);
        return () => clearInterval(timer);
    }, [diagnostics?.noProgress?.since]);
    const notice = engineDiagnosticNotice(diagnostics, now);
    if (approval.prompt) return <NativeAppApprovalCard sessionId={sessionId} state={approval} respond={approval.respond} maxWidth={maxWidth} />;
    if (!notice) return null;
    const color = { color: theme.colors.text };
    const secondary = { color: theme.colors.textSecondary };
    const host = session?.metadata?.host ?? t('lmc.diagnostics.engineMac');
    return (
        <View accessibilityLiveRegion="polite" style={{ width: '100%', maxWidth: maxWidth as any, padding: 12, gap: 6, borderRadius: 16, backgroundColor: theme.colors.surface, ...lmcSurfaceBorder(theme) }}>
            {notice.noProgress && <>
                <Text style={[color, { fontWeight: '600' }]}>{t('lmc.diagnostics.noProgress', { minutes: notice.minutes! })}</Text>
                <Text style={secondary}>{t('lmc.diagnostics.noActivity')}</Text>
                <Text style={secondary}>{notice.noProgress.toolProcesses.status === 'alive'
                    ? t('lmc.diagnostics.toolsAlive', { count: notice.noProgress.toolProcesses.liveCount ?? 0 })
                    : notice.noProgress.toolProcesses.status === 'none' ? t('lmc.diagnostics.toolsNone') : t('lmc.diagnostics.toolsUnknown')}</Text>
            </>}
            {notice.delivery && <Text style={color}>{notice.delivery.reason === 'unresponsive'
                ? t('lmc.diagnostics.unresponsive') : t('lmc.diagnostics.unconfirmed')}</Text>}
            {notice.nativeExit && <Text style={color}>{t('lmc.diagnostics.nativeExit')}</Text>}
            {notice.systemPrompt && <Text style={secondary}>{notice.systemPrompt.status === 'detected'
                ? t('lmc.diagnostics.systemPrompt', { host })
                : notice.systemPrompt.status === 'none' ? t('lmc.diagnostics.noSystemPrompt')
                    : notice.systemPrompt.status === 'unsupported' ? t('lmc.diagnostics.unsupported') : t('lmc.diagnostics.unknown')}</Text>}
            {nativeSupported && <Pressable accessibilityRole="button" disabled={approval.unavailable} onPress={() => openClaudeNative(sessionId)}
                style={{ minHeight: 44, justifyContent: 'center', opacity: approval.unavailable ? 0.45 : 1 }}>
                <Text style={color}>{t('localFeatures.nativeApprovalOpen')}</Text>
            </Pressable>}
            {!nativeSupported && session?.metadata?.flavor === 'claude' && session.metadata.claudeNativeActive &&
                <Text style={secondary}>{t('localFeatures.loginErrorUpgrade')}</Text>}
        </View>
    );
}
