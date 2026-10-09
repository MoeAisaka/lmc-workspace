import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from './StyledText';
import { openClaudeNative } from './ClaudeNativeDialog';
import { lmcSurfaceBorder } from './lmc/elevation';
import { t } from '@/text';
import type { NativeApprovalState } from '@/sync/nativeAppApproval';

export function NativeAppApprovalCard({ sessionId, state, respond, maxWidth }: {
    sessionId: string; state: NativeApprovalState; respond: (choice: 'allow' | 'deny') => unknown; maxWidth?: number | string;
}) {
    const { theme } = useUnistyles();
    const { height } = useWindowDimensions();
    const [expanded, setExpanded] = React.useState(false);
    React.useEffect(() => setExpanded(false), [state.prompt?.raw]);
    const prompt = state.prompt;
    if (!prompt) return null;
    const text = { color: theme.colors.text, fontSize: 14, lineHeight: 21,
        ...(Platform.OS === 'web' ? { overflowWrap: 'anywhere' as const } : {}) };
    const disabled = state.busy || state.unavailable || state.submitted;
    const status = state.unavailable ? 'nativeApprovalOffline' : state.issue === 'unconfirmed' ? 'nativeApprovalUnconfirmed'
        : state.issue === 'changed' ? 'nativeApprovalChanged' : state.issue === 'unavailable' ? 'nativeApprovalUnavailable'
            : state.submitted ? 'nativeApprovalSubmitted' : state.busy ? 'nativeApprovalChecking' : null;
    const button = (label: string, onPress: () => void, isDisabled: boolean, primary = false) => <Pressable
        accessibilityRole="button" accessibilityLabel={label} disabled={isDisabled} onPress={onPress}
        style={{ minHeight: 44, paddingHorizontal: 14, paddingVertical: 8, justifyContent: 'center', borderRadius: 12,
            maxWidth: '100%', flexShrink: 1, opacity: isDisabled ? 0.45 : 1,
            backgroundColor: primary ? (theme.dark ? '#6DA8FF' : '#0060F0') : theme.colors.surfaceHigh }}>
        <Text style={[text, { textAlign: 'center', fontWeight: '600', color: primary ? (theme.dark ? '#10243B' : '#fff') : theme.colors.text }]}>{label}</Text>
    </Pressable>;
    return <View testID="native-app-approval" accessibilityLiveRegion="polite" style={{ width: '100%', maxWidth: maxWidth as any,
        maxHeight: Math.max(220, Math.min(420, height - 150)), padding: 12, gap: 8, borderRadius: 16,
        backgroundColor: theme.colors.surface, ...lmcSurfaceBorder(theme) }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[text, { fontWeight: '600', fontSize: 16, flex: 1 }]}>{t('localFeatures.nativeApprovalTitle')}</Text>
            {state.busy && <ActivityIndicator size="small" />}
        </View>
        <ScrollView testID="native-approval-details" style={{ flexShrink: 1 }} contentContainerStyle={{ gap: 6, paddingRight: 8 }}>
            {!!prompt.apps.length && <Text testID="native-approval-apps" style={[text, { fontWeight: '600' }]}>{prompt.apps.join('、')}</Text>}
            {!!prompt.reason && <Text style={text} numberOfLines={expanded ? undefined : 2}>{prompt.reason}</Text>}
            {prompt.choices ? <>
                <Text style={[text, { color: theme.colors.textSecondary }]}>{t('localFeatures.nativeApprovalScope')}</Text>
                {prompt.hiddenApps !== null && prompt.hiddenApps > 0 && <Text style={[text, { color: theme.colors.textSecondary }]}>{t('localFeatures.nativeApprovalHidden', { count: prompt.hiddenApps })}</Text>}
            </> : <Text style={text}>{t('localFeatures.nativeApprovalUnknown')}</Text>}
            {(expanded || !prompt.choices) && <Text testID="native-approval-raw" selectable style={[text, { color: theme.colors.textSecondary }]}>{prompt.raw}</Text>}
        </ScrollView>
        {!!status && <Text testID="native-approval-status" style={[text, { color: theme.colors.textSecondary }]}>{t(`localFeatures.${status}`)}</Text>}
        {prompt.choices && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {button(t('localFeatures.nativeApprovalAllow'), () => void respond('allow'), disabled, true)}
            {button(t('localFeatures.nativeApprovalDeny'), () => void respond('deny'), disabled)}
        </View>}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {prompt.choices && <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)}
                style={{ minHeight: 36, justifyContent: 'center', paddingHorizontal: 4 }}>
                <Text style={[text, { color: theme.colors.textSecondary }]}>{t(expanded ? 'localFeatures.nativeApprovalLess' : 'localFeatures.nativeApprovalDetails')}</Text>
            </Pressable>}
            <Pressable accessibilityRole="button" disabled={state.busy || state.unavailable} onPress={() => openClaudeNative(sessionId)}
                style={{ minHeight: 36, justifyContent: 'center', paddingHorizontal: 4, opacity: state.busy || state.unavailable ? 0.45 : 1 }}>
                <Text style={[text, { color: theme.colors.textSecondary }]}>{t('localFeatures.nativeApprovalOpen')}</Text>
            </Pressable>
        </View>
    </View>;
}
