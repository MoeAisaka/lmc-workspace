import React from 'react';
import { View, TextInput, ActivityIndicator } from 'react-native';
import { InteractionPressable as Pressable } from '@/components/InteractionPressable';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { sync } from '@/sync/sync';
import { sessionAbort } from '@/sync/ops';
import { randomUUID } from 'expo-crypto';
import { storage } from '@/sync/storage';
import { machineResumeSession } from '@/sync/ops';
import { t } from '@/text';

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
            if (result.type !== 'success') throw new Error(result.type === 'error' ? result.errorMessage : t('lmc.sharing.sessionNotResumed'));
            await sync.refreshSessions();
        } catch (e) { setError(e instanceof Error ? e.message : t('lmc.sharing.resumeFailed')); }
        finally { setBusy(false); }
    }
    async function send() {
        if (busy || !text.trim() || !canSend) return;
        setBusy(true); setError('');
        if (!request.current || request.current.text !== text) request.current = { text, id: randomUUID() };
        try { await sync.sendMessage(sessionId, text, { sharedRequestId: request.current.id }); setText(''); request.current = null; }
        catch (e) { setError(e instanceof Error ? e.message : t('lmc.sharing.sendFailed')); }
        finally { setBusy(false); }
    }
    return <View testID={canSend ? 'shared-session-composer' : 'shared-session-readonly'} style={{ padding: 16, gap: 10, backgroundColor: theme.colors.surface, borderRadius: 20 }}>
        <Text style={{ color: theme.colors.textSecondary }}>{canSend ? t('lmc.sharing.sharedComposerEditableHint') : t('lmc.sharing.sharedComposerReadOnlyHint')}</Text>
        {canSend && <TextInput accessibilityLabel={t('lmc.sharing.sendToSharedSession')} placeholder={t('lmc.sharing.messagePlaceholder')} placeholderTextColor={theme.colors.textSecondary} multiline value={text} editable={!busy} onChangeText={setText} style={{ color: theme.colors.text, fontSize: 16, lineHeight: 28, minHeight: 52, maxHeight: 160, padding: 10 }} />}
        {!!error && <Text accessibilityRole="alert" style={{ color: theme.colors.textDestructive }}>{error}</Text>}
        <View style={{ flexDirection: 'row', gap: 12, justifyContent: 'flex-end' }}>
            {canSend && !connected && <Pressable accessibilityRole="button" disabled={busy} onPress={() => void resume()} style={{ padding: 12 }}><Text style={{ color: theme.colors.textLink }}>{t('lmc.sharing.resumeSession')}</Text></Pressable>}
            {actions.includes('stop') && <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setBusy(true); void sessionAbort(sessionId).catch(e => setError(e.message)).finally(() => setBusy(false)); }} style={{ padding: 12 }}><Text style={{ color: theme.colors.textDestructive }}>{t('lmc.sharing.stopReply')}</Text></Pressable>}
            {canSend && <Pressable accessibilityRole="button" disabled={busy || !text.trim()} onPress={() => void send()} style={{ padding: 12, opacity: busy || !text.trim() ? 0.5 : 1 }}>{busy ? <ActivityIndicator /> : <Text style={{ color: theme.colors.textLink }}>{t('lmc.sharing.send')}</Text>}</Pressable>}
        </View>
    </View>;
}
