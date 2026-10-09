import * as React from 'react';
import { Platform, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Modal } from '@/modal';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { lmcColors } from '@/components/lmc/lmcColors';
import { storage, useSetting } from '@/sync/storage';
import { useShallow } from 'zustand/react/shallow';
import type { MarkdownBlock } from './parseMarkdown';
import { SANDBOX_FLAGS, isOverSandboxLimit, parseSandboxEvent, resolveInteractiveRef, wrapForSandbox } from './interactiveSandbox';

type Block = Extract<MarkdownBlock, { type: 'interactive' }>;

const MIN_HEIGHT = 96;
/** The block must not swallow the transcript: past this share of the screen it is cut short until expanded. It never scrolls inside, which would stall the transcript at its edge. */
const MAX_SHARE = 0.7;

const styles = StyleSheet.create(theme => ({
    block: { borderRadius: 12, borderWidth: 1, borderColor: lmcColors(theme).border, backgroundColor: theme.colors.surface, marginVertical: 8, overflow: 'hidden', width: '100%' },
    header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 6, paddingVertical: 6, backgroundColor: theme.colors.surfaceHighest },
    dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: lmcColors(theme).brand },
    title: { flex: 1, fontSize: 13, fontWeight: '600', color: theme.colors.text },
    tag: { fontSize: 11, color: theme.colors.textSecondary, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: theme.colors.surface },
    button: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, borderWidth: 1, borderColor: lmcColors(theme).border, backgroundColor: theme.colors.surface },
    buttonText: { fontSize: 12, color: theme.colors.textSecondary },
    note: { fontSize: 13, color: theme.colors.textSecondary, padding: 14 },
    error: { fontSize: 13, color: lmcColors(theme).attention, padding: 14 },
    source: { ...Typography.mono(), fontSize: 12, lineHeight: 18, color: theme.colors.text, padding: 12 },
    expand: { alignItems: 'center', paddingVertical: 8, borderTopWidth: 1, borderTopColor: lmcColors(theme).border, backgroundColor: theme.colors.surfaceHighest },
    collapsed: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 },
    fullscreen: { backgroundColor: theme.colors.surface, overflow: 'hidden' },
    fullscreenHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: lmcColors(theme).border },
    fullscreenTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: theme.colors.text },
}));

/** The sandboxed page itself; web only, the native apps show the source. */
function SandboxFrame(props: { html: string; height: number; fill?: boolean; onEvent: (event: NonNullable<ReturnType<typeof parseSandboxEvent>>) => void; testID?: string }) {
    const frame = React.useRef<any>(null);
    const { onEvent } = props;
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const listen = (message: MessageEvent) => {
            if (!frame.current || message.source !== frame.current.contentWindow) return;
            const event = parseSandboxEvent(message.data);
            if (!event) return;
            // Replayed on the frame so the chat list's own wheel handling scrolls the transcript.
            if (event.type === 'wheel') frame.current.dispatchEvent(new WheelEvent('wheel', { deltaX: event.deltaX, deltaY: event.deltaY, bubbles: true, cancelable: true }));
            else onEvent(event);
        };
        window.addEventListener('message', listen);
        return () => window.removeEventListener('message', listen);
    }, [onEvent]);
    const doc = React.useMemo(() => wrapForSandbox(props.html, !!props.fill), [props.html, props.fill]);
    if (Platform.OS !== 'web') return null;
    return React.createElement('iframe', {
        ref: frame, srcDoc: doc, sandbox: SANDBOX_FLAGS, referrerPolicy: 'no-referrer', title: 'interactive answer',
        'data-testid': props.testID, style: { border: 'none', width: '100%', height: props.fill ? '100%' : props.height, display: 'block', flexShrink: 0, background: 'transparent', colorScheme: 'normal' },
    });
}

function FullscreenInteractive(props: { html: string; title: string; onClose: () => void }) {
    const { theme } = useUnistyles();
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onClose(); } };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
    }, [props.onClose]);
    const window = useWindowDimensions();
    // The modal hugs its content, so the page gets an explicit height: the window less the header.
    const frameHeight = Math.max(200, window.height - 52);
    return <View testID="interactive-fullscreen" style={[styles.fullscreen, { width: Math.min(1400, window.width), height: frameHeight + 52 }]}>
        <View style={styles.fullscreenHeader}>
            <View style={styles.dot} /><Text numberOfLines={1} style={styles.fullscreenTitle}>{props.title}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={t('common.cancel')} onPress={props.onClose} style={styles.button}><Ionicons name="close" size={18} color={theme.colors.textSecondary} /></Pressable>
        </View>
        <View style={{ height: frameHeight }}><SandboxFrame html={props.html} height={frameHeight} fill onEvent={() => {}} testID="interactive-fullscreen-frame" /></View>
    </View>;
}

/**
 * D30: an interactive answer. Four looks: still being written, shown, could
 * not be shown, and collapsed because the person turned the feature off.
 */
export const InteractiveBlock = React.memo((props: { block: Block; sessionId?: string }) => {
    const { theme } = useUnistyles();
    const mode = useSetting('interactiveAnswers');
    const window = useWindowDimensions();
    const { block } = props;
    // A reference reads the session's own record; the hook only re-renders when the resolved page changes.
    const resolved = storage(useShallow(state => block.ref ? resolveInteractiveRef(props.sessionId ? state.sessionMessages[props.sessionId]?.messages : undefined, block.ref) : null));
    const html = block.ref ? resolved?.html ?? '' : block.html;
    const title = block.title ?? resolved?.title ?? (block.ref ? block.ref : block.id) ?? t('lmc.interactive.untitled');
    const [opened, setOpened] = React.useState(false);
    const [showSource, setShowSource] = React.useState(false);
    const [height, setHeight] = React.useState(MIN_HEIGHT);
    const [error, setError] = React.useState<string | null>(null);
    const [network, setNetwork] = React.useState(false);
    const [expanded, setExpanded] = React.useState(false);
    const onEvent = React.useCallback((event: NonNullable<ReturnType<typeof parseSandboxEvent>>) => {
        if (event.type === 'size') setHeight(Math.max(MIN_HEIGHT, Math.ceil(event.height)));
        else if (event.type === 'error') setError(event.message);
        else if (event.type === 'network') setNetwork(true);
    }, []);
    React.useEffect(() => { setError(null); setNetwork(false); setHeight(MIN_HEIGHT); setExpanded(false); }, [html]);
    const cap = Math.round(window.height * MAX_SHARE);
    const cut = height > cap;

    const tooLarge = React.useMemo(() => isOverSandboxLimit(html), [html]);
    const pending = !block.closed && !block.ref;
    const missingRef = !!block.ref && !resolved;
    const failure = error ? t('lmc.interactive.failed') : tooLarge ? t('lmc.interactive.tooLarge') : missingRef ? t('lmc.interactive.missingRef') : Platform.OS !== 'web' ? t('lmc.interactive.webOnly') : null;
    const collapsed = mode === 'off' && !opened;

    const openFullscreen = () => Modal.show({ component: FullscreenInteractive, props: { html, title } });
    const headerButton = (label: string, onPress: () => void, testID: string) => <Pressable accessibilityRole="button" onPress={onPress} style={styles.button} testID={testID}><Text style={styles.buttonText}>{label}</Text></Pressable>;

    if (collapsed) {
        return <Pressable accessibilityRole="button" testID="interactive-collapsed" onPress={() => setOpened(true)} style={[styles.block, styles.collapsed]}>
            <Ionicons name="eye-off-outline" size={16} color={theme.colors.textSecondary} /><Text style={[styles.buttonText, { flex: 1 }]}>{t('lmc.interactive.collapsed', { title })}</Text>
        </Pressable>;
    }
    return <View style={styles.block} testID="interactive-block" {...(Platform.OS === 'web' ? { dataSet: { lmcInteractive: block.ref ? 'ref' : 'page', lmcInteractiveState: pending ? 'pending' : failure ? 'error' : 'shown' } } : {})}>
        <View style={styles.header}>
            <View style={styles.dot} /><Text numberOfLines={1} style={styles.title}>{title}</Text>
            {network && <Text style={styles.tag} testID="interactive-network">{t('lmc.interactive.network')}</Text>}
            {!pending && !!html && headerButton(showSource ? t('lmc.interactive.page') : t('lmc.interactive.source'), () => setShowSource(v => !v), 'interactive-source')}
            {!pending && !failure && headerButton(t('lmc.interactive.fullscreen'), openFullscreen, 'interactive-fullscreen-button')}
        </View>
        {pending ? <Text style={styles.note} testID="interactive-pending">{t('lmc.interactive.pending', { title })}</Text>
            : showSource ? <ScrollView horizontal style={{ maxHeight: Math.round(window.height * MAX_SHARE) }}><Text selectable style={styles.source}>{html}</Text></ScrollView>
            : failure ? <Text style={styles.error} testID="interactive-error">{failure}</Text>
            : <>
                <View testID="interactive-viewport" style={{ height: cut && !expanded ? cap : height, overflow: 'hidden' }}><SandboxFrame html={html} height={height} onEvent={onEvent} testID="interactive-frame" /></View>
                {cut && <Pressable accessibilityRole="button" testID="interactive-expand" onPress={() => setExpanded(v => !v)} style={styles.expand}><Text style={styles.buttonText}>{expanded ? t('lmc.interactive.collapse') : t('lmc.interactive.expand')}</Text></Pressable>}
            </>}
    </View>;
});
