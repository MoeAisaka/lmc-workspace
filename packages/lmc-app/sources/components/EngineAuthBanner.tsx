import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useSession } from '@/sync/storage';
import { checkSessionAuthentication } from '@/sync/engineAuthentication';
import { sessionCapabilities } from '@/sync/sessionCapabilities';
import { lmcElevation, lmcSurfaceBorder } from '@/components/lmc/elevation';
import { t } from '@/text';

/** Same card treatment as the refresh banner; see the note there. */
export function EngineAuthBanner({ sessionId, maxWidth, minHeight }: { sessionId: string; maxWidth?: number | string; minHeight?: number }) {
    const session = useSession(sessionId);
    const { theme } = useUnistyles();
    const [checking, setChecking] = React.useState(false);
    const [error, setError] = React.useState('');
    const metadata = session?.metadata;
    if (!metadata?.engineAuth || metadata.engineAuth.status === 'ready') return null;
    const engine = metadata.flavor === 'codex' ? 'Codex' : 'Claude Code';
    return <View accessibilityLiveRegion="polite" style={{ width: '100%', maxWidth: maxWidth as any, minHeight, justifyContent: minHeight ? 'center' : undefined, padding: 12, gap: 6, backgroundColor: theme.colors.surface, borderRadius: 16, ...lmcSurfaceBorder(theme), ...lmcElevation(theme, 1) }}>
        <Text style={{ color:theme.colors.text, fontWeight:'600' }}>{engine} · {t(metadata.engineAuth.status === 'required' ? 'localFeatures.engineAuthRequired' : 'localFeatures.engineAuthUnknown')}</Text>
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
