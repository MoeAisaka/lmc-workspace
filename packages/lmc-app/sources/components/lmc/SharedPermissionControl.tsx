import React from 'react';
import { View, Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { sessionAllow, sessionDeny } from '@/sync/ops';

export function SharedPermissionControl({ sessionId, id, allowed }: { sessionId: string; id: string; allowed: boolean }) {
    const { theme } = useUnistyles();
    const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
    async function respond(approve: boolean) {
        if (busy || !allowed) return;
        setBusy(true); setError('');
        try { if (approve) await sessionAllow(sessionId, id); else await sessionDeny(sessionId, id); }
        catch (e) { setError(e instanceof Error ? e.message : '审批未完成'); }
        finally { setBusy(false); }
    }
    return <View style={{ padding: 12, gap: 8 }}>
        {!allowed ? <Text style={{ color: theme.colors.textSecondary }}>等待有审批权限的成员处理</Text> : <View style={{ flexDirection: 'row', gap: 16 }}>
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => void respond(true)} style={{ padding: 12 }}><Text style={{ color: theme.colors.textLink }}>{busy ? '处理中…' : '仅允许此次'}</Text></Pressable>
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => void respond(false)} style={{ padding: 12 }}><Text style={{ color: theme.colors.textDestructive }}>拒绝</Text></Pressable>
        </View>}
        {!!error && <Text accessibilityRole="alert" style={{ color: theme.colors.textDestructive }}>{error}</Text>}
    </View>;
}
