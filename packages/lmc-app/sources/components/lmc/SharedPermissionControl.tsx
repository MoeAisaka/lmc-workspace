import React from 'react';
import { View } from 'react-native';
import { InteractionPressable as Pressable } from '@/components/InteractionPressable';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import { t } from '@/text';

export function SharedPermissionControl({ sessionId, id, allowed }: { sessionId: string; id: string; allowed: boolean }) {
    const { theme } = useUnistyles();
    const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
    async function respond(approve: boolean) {
        if (busy || !allowed) return;
        setBusy(true); setError('');
        try { if (approve) await sessionAllow(sessionId, id); else await sessionDeny(sessionId, id); }
        catch (e) { setError(e instanceof Error ? e.message : t('lmc.sharing.permissionFailed')); }
        finally { setBusy(false); }
    }
    return <View style={{ padding: 12, gap: 8 }}>
        {!allowed ? <Text style={{ color: theme.colors.textSecondary }}>{t('lmc.sharing.awaitingApprover')}</Text> : <View style={{ flexDirection: 'row', gap: 16 }}>
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => void respond(true)} style={{ borderRadius: 8, padding: 12 }}><Text style={{ color: theme.colors.textLink }}>{busy ? t('lmc.sharing.processing') : t('lmc.sharing.allowOnce')}</Text></Pressable>
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => void respond(false)} style={{ borderRadius: 8, padding: 12 }}><Text style={{ color: theme.colors.textDestructive }}>{t('lmc.sharing.deny')}</Text></Pressable>
        </View>}
        {!!error && <Text accessibilityRole="alert" style={{ color: theme.colors.textDestructive }}>{error}</Text>}
    </View>;
}
