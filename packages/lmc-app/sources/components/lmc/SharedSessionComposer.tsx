import React from 'react';
import { View, TextInput, Pressable, ActivityIndicator } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { sync } from '@/sync/sync';
import { sessionAbort } from '@/sync/ops';
import { randomUUID } from 'expo-crypto';
import { storage } from '@/sync/storage';
import { machineResumeSession } from '@/sync/ops';

export function SharedSessionComposer({ sessionId, actions, connected }: { sessionId: string; actions: string[]; connected: boolean }) {
    const { theme } = useUnistyles();
    const [text, setText] = React.useState(''), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
    const request = React.useRef<{ text: string; id: string } | null>(null);
    const canSend = actions.includes('send');
    async function resume() {
        setBusy(true); setError('');
        try {
            const current = storage.getState().sessions[sessionId];
            const result = await machineResumeSession({ sessionId, machineId: current?.metadata?.machineId ?? '' });
            if (result.type !== 'success') throw new Error(result.type === 'error' ? result.errorMessage : '会话尚未恢复');
            await sync.refreshSessions();
        } catch (e) { setError(e instanceof Error ? e.message : '恢复失败'); }
        finally { setBusy(false); }
    }
    async function send() {
        if (busy || !text.trim() || !canSend) return;
        setBusy(true); setError('');
        if (!request.current || request.current.text !== text) request.current = { text, id: randomUUID() };
        try { await sync.sendMessage(sessionId, text, { sharedRequestId: request.current.id }); setText(''); request.current = null; }
        catch (e) { setError(e instanceof Error ? e.message : '消息未发送，请重试'); }
        finally { setBusy(false); }
    }
    return <View testID={canSend ? 'shared-session-composer' : 'shared-session-readonly'} style={{ padding: 16, gap: 10, backgroundColor: theme.colors.surface, borderRadius: 20 }}>
        <Text style={{ color: theme.colors.textSecondary }}>{canSend ? '共享会话 · 消息依次处理，模型与运行设置沿用此会话' : '共享会话 · 只读，可查看历史和附件'}</Text>
        {canSend && <TextInput accessibilityLabel="发送到共享会话" placeholder="输入消息…" placeholderTextColor={theme.colors.textSecondary} multiline value={text} editable={!busy} onChangeText={setText} style={{ color: theme.colors.text, fontSize: 16, minHeight: 52, maxHeight: 160, padding: 10 }} />}
        {!!error && <Text accessibilityRole="alert" style={{ color: theme.colors.textDestructive }}>{error}</Text>}
        <View style={{ flexDirection: 'row', gap: 12, justifyContent: 'flex-end' }}>
            {canSend && !connected && <Pressable accessibilityRole="button" disabled={busy} onPress={() => void resume()} style={{ padding: 12 }}><Text style={{ color: theme.colors.textLink }}>恢复会话</Text></Pressable>}
            {actions.includes('stop') && <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setBusy(true); void sessionAbort(sessionId).catch(e => setError(e.message)).finally(() => setBusy(false)); }} style={{ padding: 12 }}><Text style={{ color: theme.colors.textDestructive }}>停止当前回复</Text></Pressable>}
            {canSend && <Pressable accessibilityRole="button" disabled={busy || !text.trim()} onPress={() => void send()} style={{ padding: 12, opacity: busy || !text.trim() ? 0.5 : 1 }}>{busy ? <ActivityIndicator /> : <Text style={{ color: theme.colors.textLink }}>发送</Text>}</Pressable>}
        </View>
    </View>;
}
