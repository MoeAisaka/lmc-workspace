import * as React from 'react';
import { Platform, Pressable, ScrollView, TextInput, View, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from './StyledText';
import { Modal } from '@/modal';
import { apiSocket } from '@/sync/apiSocket';
import { t } from '@/text';

type Screen = { active?: boolean; epoch: string; revision: number; ownsInput: boolean; exited: boolean; phase: string; lines: string[] };
export function openClaudeNative(sessionId: string) {
    Modal.show({ animateExit: true, component: ClaudeNativeDialog, props: { sessionId } });
}

export function ClaudeNativeDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
    const { theme } = useUnistyles();
    const { width, height } = useWindowDimensions();
    const clientId = React.useRef(`native_${Date.now()}_${Math.random().toString(36).slice(2)}`).current;
    const [screen, setScreen] = React.useState<Screen | null>(null);
    const latest = React.useRef<Screen | null>(null);
    const [error, setError] = React.useState('');
    const [connectionError, setConnectionError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [text, setText] = React.useState('');
    const [choice, setChoice] = React.useState('');
    const active = React.useRef(true);
    const sending = React.useRef(false);
    const call = React.useCallback(async (data: Record<string, unknown>) => {
        const result = await apiSocket.sessionRPC<any, any>(sessionId, 'native-computer', { clientId, ...data });
        if (result?.error) throw new Error(result.error);
        return result;
    }, [sessionId, clientId]);
    const refresh = React.useCallback(async () => {
        let result = await call({ action: 'screen' });
        if (result.active !== false && !result.exited && !result.ownsInput) result = await call({ action: 'claim' });
        if (active.current) { latest.current = result; setScreen(result); setConnectionError(''); }
    }, [call]);
    React.useEffect(() => {
        active.current = true;
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try { if (!sending.current) await refresh(); }
            catch (reason) { if (active.current) { latest.current = null; setScreen(old => old ? { ...old, ownsInput: false } : old); setConnectionError(String(reason instanceof Error ? reason.message : reason)); } }
            if (active.current) timer = setTimeout(poll, 750);
        };
        void poll();
        return () => { active.current = false; clearTimeout(timer); void call({ action: 'release' }).catch(() => {}); };
    }, [call, refresh]);
    const run = async (action: () => Promise<unknown>) => {
        if (sending.current) return;
        sending.current = true; setBusy(true); setError('');
        try { await action(); await refresh(); }
        catch (reason) { if (active.current) setError(reason instanceof Error ? reason.message : String(reason)); }
        finally { sending.current = false; if (active.current) setBusy(false); }
    };
    const input = (value: Record<string, unknown>) => run(async () => {
        const observed = latest.current;
        if (!observed?.ownsInput) throw new Error(t('localFeatures.nativeReconnect'));
        await call({ action: 'input', epoch: observed.epoch, revision: observed.revision,
            requestId: `input_${Date.now()}_${Math.random().toString(36).slice(2)}`, input: value });
    });
    const enabled = !busy && !!screen?.ownsInput && screen.phase !== 'sending' && !screen.exited;
    const button = (label: string, action: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityLabel={label}
        disabled={disabled} onPress={action} style={{ minHeight: 44, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 8, backgroundColor: theme.colors.surface, opacity: disabled ? 0.4 : 1 }}>
        <Text style={{ color: theme.colors.text }}>{label}</Text>
    </Pressable>;
    return <View testID="claude-native-dialog" style={{ width: Math.min(960, width - 24), height: Math.min(820, height - 32), backgroundColor: theme.colors.surface, borderRadius: 16, padding: 12, gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ fontSize: 18, color: theme.colors.text }}>{t('localFeatures.nativeTitle')}</Text>
            {button(t('lmc.common.close'), onClose)}
        </View>
        <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>{t('localFeatures.nativeHint')}</Text>
        {!!(error || connectionError) && <Text testID="native-error" style={{ color: theme.colors.text, fontSize: 13 }}>{connectionError || error}</Text>}
        {screen?.active === false ? button(t('localFeatures.nativeStart'), () => void run(() => call({ action: 'start' })), busy) : <>
            <ScrollView style={{ flex: 1, backgroundColor: '#141414', borderRadius: 8 }}>
                <ScrollView horizontal>
                    <Text testID="native-screen" selectable style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12, lineHeight: 17, color: '#eee', padding: 10 }}>{screen?.lines?.join('\n') || t('common.loading')}</Text>
                </ScrollView>
            </ScrollView>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
                {button('↑', () => void input({ type: 'key', key: 'up' }), !enabled)}
                {button('↓', () => void input({ type: 'key', key: 'down' }), !enabled)}
                {button('Tab', () => void input({ type: 'key', key: 'tab' }), !enabled)}
                {button('Esc', () => void input({ type: 'key', key: 'escape' }), !enabled)}
                {button(t('localFeatures.nativeEnter'), () => void input({ type: 'key', key: 'enter' }), !enabled)}
                <TextInput accessibilityLabel={t('localFeatures.nativeChoice')} placeholder="1–9" value={choice} onChangeText={setChoice} keyboardType="number-pad" maxLength={1}
                    style={{ width: 45, minHeight: 44, color: theme.colors.text, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 6, textAlign: 'center' }} />
                {button(t('localFeatures.nativeConfirmChoice'), () => void input({ type: 'choice', choice: Number(choice) }), !enabled || !/^[1-9]$/.test(choice))}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <TextInput testID="native-text" accessibilityLabel={t('localFeatures.nativeText')} placeholder={t('localFeatures.nativeText')} multiline value={text} onChangeText={setText}
                    style={{ flex: 1, minHeight: 44, maxHeight: 90, borderWidth: 1, borderRadius: 8, padding: 8, color: theme.colors.text, borderColor: theme.colors.divider }} />
                {button(t('localFeatures.nativePaste'), () => void input({ type: 'text', text }), !enabled || !text)}
            </View>
            {button(t('localFeatures.nativeLeave'), () => void run(() => call({ action: 'leave', epoch: latest.current?.epoch, revision: latest.current?.revision })), !enabled || screen?.phase !== 'idle')}
        </>}
    </View>;
}
