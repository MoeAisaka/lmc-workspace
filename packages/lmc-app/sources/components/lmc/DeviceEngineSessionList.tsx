import * as React from 'react';
import { View, Pressable, ScrollView, TextInput, Platform, Text as RNText } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { usePathname, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { storage, useAllMachines, useAllSessions, useIsDataReady, useSessionUnread, useSetting } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import { getSessionName } from '@/utils/sessionUtils';
import { Image } from 'expo-image';
import { ProjectAvatarButton } from '@/components/ProjectAvatarButton';
import { SortableSessionRows } from '@/components/SortableSessionRows';
import { SortableHubGroups } from './SortableHubGroups';
import { buildDeviceEngineGroups, collectArchivedSessions, engineKeyForSession, flattenDeviceSessions, machineDisplayName, type LmcDeviceGroup, type LmcEngineGroup } from '@/utils/lmc/deviceEngineGroups';
import { splitHubGroups, type LmcHubGroup } from '@/utils/lmc/hubGroups';
import { bindWorker, unbindWorker } from '@/sync/orchestration';
import { sessionUpdateMetadata } from '@/sync/ops';
import { applyDutyPrefix, parseDutyPrefix } from './collaborationDuty';
import { armPendingDuty, clearPendingDuty, PENDING_DUTY_MS, type PendingDutyState } from './pendingDuty';
import { DutyChipRow, fail as reportFailure, showUndoToast } from './CollaborationSheet';
import { useDragTarget } from './dragTargetStore';
import { Modal } from '@/modal';
import type { BoardEntry, Machine } from '@/sync/storageTypes';
import { isClosedState } from './orchestrationTone';
import { hasTaskAttention, resolveSessionRowTone, taskRowTone } from './sessionRowTone';
import { ProviderIcon } from '@/components/ProviderIcon';
import { effortDisplayName, getAvailableModels } from '@/components/modelModeOptions';

/** Keys built at runtime have no static parameter type. */
const tk = (key: string): string => (t as unknown as (k: string) => string)(key);
/** Whether each hub's task list is open; module-level so it survives the list remounting. */
const tasksOpenByWorker = new Map<string, boolean>();
// Which hubs are collapsed, kept outside the component so the choice survives
// the list re-sorting or re-mounting a group, like the task-open map above.
const hubCollapsedById = new Map<string, boolean>();
import { describeLmcSessionStatus } from '@/utils/lmc/sessionStatusLine';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { SESSION_ROW_MENU_STYLE, useSessionRowMenu } from '@/hooks/useSessionRowMenu';
import { SessionActionsPopover } from '@/components/SessionActionsPopover';
import { SessionStatusRing } from './SessionStatusRing';
import { AccountSettingsRow } from './AccountSettingsRow';
import { lmcColors } from './lmcColors';
import { lmcElevation, lmcSurfaceBorder } from './elevation';
import { t } from '@/text';

const TOGGLE_SIZE = 44;

/**
 * A full-width opening bracket carries half a character of blank on its left,
 * so a 【 title starts visibly further right than a PR… or 新… one beside it.
 * `text-spacing-trim` fixes this where it exists — theme.css asks for it — but
 * older Chromium ignores the property, so the offset is applied by hand there.
 */
const CJK_OPENING_BRACKET = /^[【（「『《〈［｛〔〖〘〚〝]/;
const BROWSER_TRIMS_BRACKETS = Platform.OS === 'web'
    && typeof CSS !== 'undefined'
    && typeof CSS.supports === 'function'
    && CSS.supports('text-spacing-trim', 'trim-start');
function bracketTrim(title: string) {
    if (BROWSER_TRIMS_BRACKETS || !CJK_OPENING_BRACKET.test(title)) return null;
    // Half of the 14pt glyph, matching what the property would have removed.
    return { marginLeft: -7 } as const;
}

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, minHeight: 0 },
    scroll: { flex: 1 },
    searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4, position: 'relative', zIndex: 5 },
    // A 40pt bar of flat ink read as a divider rather than the day's main
    // action: taller, fully rounded and in the brand blue it reads as a button.
    // `flex: 1` here dated from when this sat directly in the row. Wrapped in
    // the fade layer it became a column child, so flex-basis:0 fought `height`
    // and the button rendered at half the search toggle's size.
    composePrimary: { alignSelf: 'stretch', minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: TOGGLE_SIZE, borderRadius: TOGGLE_SIZE / 2 },
    composeLabel: { fontSize: 15, ...Typography.default('semiBold') },
    searchToggle: { width: TOGGLE_SIZE, height: TOGGLE_SIZE, borderRadius: TOGGLE_SIZE / 2, alignItems: 'center', justifyContent: 'center' },
    searchPanel: { position: 'absolute', right: 0, top: 0, height: TOGGLE_SIZE, borderRadius: TOGGLE_SIZE / 2, overflow: 'hidden' },
    searchPanelInner: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14, paddingRight: 6 },
    searchInput: { flex: 1, minWidth: 0, height: 32, fontSize: 15, color: theme.colors.text, ...Typography.default(), ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}) },
    newButton: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
    deviceHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 8, paddingRight: 8, paddingTop: 14, paddingBottom: 6, borderRadius: 10 },
    groupChevron: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
    hubChevron: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
    deviceName: { fontSize: 15, color: theme.colors.text, ...Typography.default('semiBold') },
    deviceMeta: { flex: 1, minWidth: 0, fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() },
    badge: { paddingHorizontal: 6, borderRadius: 999, minWidth: 18, alignItems: 'center' },
    badgeText: { fontSize: 11, lineHeight: 16, color: '#fff', ...Typography.default('semiBold') },
    engineHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 8, paddingTop: 8, paddingBottom: 2 },
    engineGroup: { position: 'relative' },
    engineGuide: { position: 'absolute', left: 19, top: 2, bottom: 6, width: StyleSheet.hairlineWidth, zIndex: 2 },
    engineAvatar: { width: 22, height: 22, borderRadius: 7, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
    engineName: { fontSize: 12, color: theme.colors.textSecondary, ...Typography.default('semiBold') },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 24, paddingLeft: 4, paddingRight: 6, paddingVertical: 8, borderRadius: 12, alignSelf: 'stretch', minHeight: 40 },
    // The list's type scale: titles 14, meta 11, pills 10.5. Three steps and no others.
    rowLine: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
    metaText: { fontSize: 11, lineHeight: 15, ...Typography.default() },
    suffix: { fontSize: 11, maxWidth: 120, ...Typography.default() },
    toggle: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    hubGroup: { marginTop: 8, marginHorizontal: 2, borderRadius: 12, borderWidth: 1, borderColor: 'transparent' },
    hubHeader: { gap: 3, paddingLeft: 8, paddingRight: 10, paddingTop: 10, paddingBottom: 8, borderRadius: 10 },
    hubName: { fontSize: 15, color: theme.colors.text, ...Typography.default('semiBold') },
    rolePill: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999 },
    rolePillText: { fontSize: 10.5, lineHeight: 15, ...Typography.default('semiBold') },
    dropHint: { fontSize: 11, paddingLeft: 34, paddingBottom: 6, ...Typography.default('semiBold') },
    taskRow: { marginRight: 4, paddingLeft: 6, paddingRight: 10, paddingVertical: 6, borderRadius: 10, gap: 3 },
    idChip: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 },
    idChipText: { fontSize: 10, lineHeight: 14, fontFamily: 'Menlo', letterSpacing: 0.2 },
    taskTitle: { fontSize: 13, color: theme.colors.text, ...Typography.default() },
    dots: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
    rowPressed: { backgroundColor: theme.colors.surfacePressed },
    title: { fontSize: 14, lineHeight: 20, color: theme.colors.text, ...Typography.default() },
    titleStrong: { ...Typography.default('semiBold') },
    status: { fontSize: 11, lineHeight: 14, ...Typography.default() },
    trailing: { fontSize: 11, lineHeight: 16, ...Typography.default() },
    empty: { padding: 24, fontSize: 13, textAlign: 'center', color: theme.colors.textSecondary, ...Typography.default() },
    footer: { paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider },
}));

export interface SessionSearchRowProps {
    query: string;
    onQueryChange: (value: string) => void;
    onNavigate?: () => void;
}

/** Search field plus the new-session button; the sidebar renders it in its own capsule. */
export const SessionSearchRow = React.memo(({ query, onQueryChange, onNavigate }: SessionSearchRowProps) => {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const router = useRouter();
    // Search is an occasional act; starting a session is the daily one. So the
    // field collapses to its glyph and hands the row over to the new-session
    // button, growing back out of that glyph when actually needed.
    const [searching, setSearching] = React.useState(false);
    const [rowWidth, setRowWidth] = React.useState(0);
    const inputRef = React.useRef<TextInput>(null);
    const open = searching || !!query;
    const progress = useSharedValue(0);
    const [mounted, setMounted] = React.useState(false);

    React.useEffect(() => {
        if (open) {
            setMounted(true);
            progress.value = withTiming(1, { duration: 260, easing: Easing.out(Easing.cubic) });
        } else {
            progress.value = withTiming(0, { duration: 190, easing: Easing.in(Easing.cubic) }, (done) => {
                if (done) runOnJS(setMounted)(false);
            });
        }
    }, [open, progress]);

    // The panel grows leftward out of the toggle, so the glyph reads as the
    // seed of the field rather than a button that swaps a panel in.
    const panelStyle = useAnimatedStyle(() => ({
        width: TOGGLE_SIZE + progress.value * Math.max(0, rowWidth - TOGGLE_SIZE),
        opacity: 0.35 + progress.value * 0.65,
    }));
    const contentStyle = useAnimatedStyle(() => ({ opacity: Math.max(0, (progress.value - 0.45) / 0.55) }));
    const composeStyle = useAnimatedStyle(() => ({ opacity: 1 - progress.value }));

    const close = React.useCallback(() => { setSearching(false); onQueryChange(''); }, [onQueryChange]);

    return (
        <View style={styles.searchRow} onLayout={(event) => setRowWidth(event.nativeEvent.layout.width)}>
            <Animated.View style={[{ flex: 1, minWidth: 0 }, composeStyle]} pointerEvents={open ? 'none' : 'auto'}>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('lmc.list.newSession')}
                    onPress={() => { onNavigate?.(); router.navigate('/new'); }}
                    style={({ pressed }) => [
                        styles.composePrimary,
                        lmcElevation(theme, 2),
                        { backgroundColor: colors.brand, opacity: pressed ? 0.85 : 1 },
                    ]}
                >
                    <Ionicons name="create-outline" size={18} color="#FFFFFF" />
                    <Text style={[styles.composeLabel, { color: '#FFFFFF' }]}>{t('lmc.list.newSession')}</Text>
                </Pressable>
            </Animated.View>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={open ? t('lmc.list.closeSearch') : t('lmc.list.search')}
                accessibilityState={{ expanded: open }}
                onPress={() => { if (open) close(); else { setSearching(true); setTimeout(() => inputRef.current?.focus(), 120); } }}
                style={({ pressed }) => [styles.searchToggle, { backgroundColor: open ? 'transparent' : colors.subtle, opacity: pressed ? 0.75 : 1 }]}
            >
                <Ionicons name={open ? 'close' : 'search-outline'} size={18} color={theme.colors.text} />
            </Pressable>

            {mounted && (
                <Animated.View
                    pointerEvents={open ? 'auto' : 'none'}
                    style={[styles.searchPanel, { backgroundColor: theme.colors.surface }, lmcSurfaceBorder(theme), lmcElevation(theme, 3), panelStyle]}
                >
                    <Animated.View style={[styles.searchPanelInner, contentStyle]}>
                        <Ionicons name="search-outline" size={18} color={colors.tertiary} />
                        <TextInput
                            ref={inputRef}
                            accessibilityLabel={t('lmc.list.search')}
                            placeholder={t('lmc.list.searchPlaceholder')}
                            placeholderTextColor={colors.tertiary}
                            value={query}
                            onChangeText={onQueryChange}
                            style={styles.searchInput}
                        />
                        <Pressable accessibilityRole="button" accessibilityLabel={t('lmc.list.closeSearch')} onPress={close} hitSlop={8} style={styles.newButton}>
                            <Ionicons name="close" size={18} color={colors.tertiary} />
                        </Pressable>
                    </Animated.View>
                </Animated.View>
            )}
        </View>
    );
});

interface DeviceEngineSessionListProps {
    /** Called after any navigation so a drawer can close itself. */
    onNavigate?: () => void;
    /** Hide the search + new-session row (the desktop sidebar has its own). */
    hideSearch?: boolean;
    /** Hide the bottom account/settings row. */
    hideAccount?: boolean;
    /** Search text owned by the caller; without it the list keeps its own field. */
    query?: string;
    contentPaddingBottom?: number;
}

function useSelectedSessionId(): string | undefined {
    const pathname = usePathname();
    return React.useMemo(() => {
        const match = pathname.match(/^\/session\/([^/]+)/);
        return match ? decodeURIComponent(match[1]) : undefined;
    }, [pathname]);
}

/** Re-renders every 15s so the "12s" elapsed counters stay honest. */
function useTicker(active: boolean): number {
    const [now, setNow] = React.useState(() => Date.now());
    React.useEffect(() => {
        if (!active) return;
        const timer = setInterval(() => setNow(Date.now()), 15_000);
        return () => clearInterval(timer);
    }, [active]);
    return now;
}

type RowMeta = {
    /** Device name, drawn with a laptop mark; omitted when the row sits under its device already. */
    device?: string | null;
    /** The engine mark, from ProviderIcon. */
    engine?: 'claude' | 'codex' | null;
    /** Anything else worth a word on the second line: a model name, a task count. */
    extras?: string[];
    /** A collapsible list under the row, with its open state; a chevron alone when there is no label. */
    toggle?: { open: boolean; onToggle: () => void; label?: string } | null;
};

/**
 * One session, on two lines. The first is the title and nothing else but the
 * state pill — at 300px a title shared its line with a device, an engine and
 * a status and was the first thing to be cut. The second carries what the
 * grouping above it does not already say: device, engine, model, and for a
 * worker how many tasks it has.
 */
const SessionRow = React.memo(({ session, selected, now, onNavigate, engineBadge = false, suffix, alert = false, meta, indent = 24 }: { session: Session; selected: boolean; now: number; onNavigate?: () => void; engineBadge?: boolean; suffix?: string | null; /** One of this worker's tasks is waiting on a person. Shown by the task rows, never by the session's own mark. */ alert?: boolean; meta?: RowMeta | null; indent?: number }) => {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const navigate = useNavigateToSession();
    const { anchor, closeMenu, menuProps } = useSessionRowMenu(session.id);
    const line = describeLmcSessionStatus(session, now);
    const unread = useSessionUnread(session.id);
    // The one status mark the whole list uses: working / done-unread / attention.
    // It speaks for the session alone. A task the hub rejected, blocked or
    // failed keeps its own mark on its task row — it is not the session asking
    // for a person, and painting the row orange for it made an idle node look
    // like it was sitting on an approval it had never requested.
    const tone = resolveSessionRowTone({ lineTone: line.tone, unread, taskAttention: alert });
    const [hovered, setHovered] = React.useState(false);
    const background = tone === 'attention' ? colors.attentionSoft : selected ? colors.rowSelected : undefined;
    // The status mark is the row's only trailing element now, so it stays put
    // instead of stepping aside for a hover button.
    const showRing = tone === 'working' || tone === 'attention' || tone === 'done';
    const hoverProps = Platform.OS === 'web' ? ({ onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) } as any) : {};
    const title = getSessionName(session);
    const secondLine = meta && (meta.device || meta.engine || (meta.extras && meta.extras.length) || meta.toggle);
    return (
        <View {...hoverProps} style={{ width: '100%', minWidth: 0 }}>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${title}，${line.text}`}
                onPress={() => { onNavigate?.(); navigate(session.id); }}
                style={({ pressed }) => [styles.row, { marginLeft: indent }, background ? { backgroundColor: background } : hovered ? styles.rowPressed : null, pressed && !background && styles.rowPressed, SESSION_ROW_MENU_STYLE]}
                {...menuProps}
            >
                <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                    <View style={styles.rowLine}>
                        {engineBadge && !meta && <EngineBadge session={session} />}
                        <RNText numberOfLines={1} style={[styles.title, { flexShrink: 1 }, bracketTrim(title), tone === 'attention' && styles.titleStrong, tone === 'offline' && { color: colors.placeholder }]}>{title}</RNText>
                        <View style={{ flex: 1 }} />
                        {!!suffix && !meta && <RNText numberOfLines={1} style={[styles.suffix, { color: colors.tertiary }]}>{suffix}</RNText>}
                    </View>
                    {secondLine && (
                        <View style={styles.rowLine}>
                            {!!meta!.device && <><Ionicons name="laptop-outline" size={12} color={colors.tertiary} /><RNText numberOfLines={1} style={[styles.metaText, { color: colors.tertiary, maxWidth: 96 }]}>{meta!.device}</RNText></>}
                            {!!meta!.engine && <ProviderIcon kind={meta!.engine} size={12} />}
                            {(meta!.extras ?? []).map((extra, index) => <RNText key={index} numberOfLines={1} style={[styles.metaText, { color: colors.tertiary, flexShrink: 1 }]}>{extra}</RNText>)}
                            {meta!.toggle && (
                                <Pressable accessibilityRole="button" accessibilityState={{ expanded: meta!.toggle.open }} onPress={(e) => { e.stopPropagation?.(); meta!.toggle!.onToggle(); }} hitSlop={6} style={({ pressed }) => [styles.toggle, pressed && { opacity: 0.6 }]}>
                                    {!!meta!.toggle.label && <RNText style={[styles.metaText, { color: colors.tertiary }]}>{meta!.toggle.label}</RNText>}
                                    <Ionicons name={meta!.toggle.open ? 'chevron-down' : 'chevron-forward'} size={12} color={colors.tertiary} />
                                </Pressable>
                            )}
                        </View>
                    )}
                </View>
                <View style={styles.dots}>
                    {showRing && <SessionStatusRing tone={tone} size={14} />}
                </View>
            </Pressable>
            {Platform.OS === 'web' && (
                <SessionActionsPopover anchor={anchor} onClose={closeMenu} sessionId={session.id} visible={anchor !== null} />
            )}
        </View>
    );
});

/** The model a session is on, by its display name, or null. */
function modelNameOf(session: Session): string | null {
    const key = session.modelMode ?? session.metadata?.modelMode ?? null;
    if (!key || key === 'default') return null;
    const flavor = session.metadata?.flavor;
    if (flavor !== 'claude' && flavor !== 'codex') return null;
    return getAvailableModels(flavor, session.metadata, t as any, key).find((m) => m.key === key)?.name ?? null;
}

const ENGINE_ICONS: Record<string, number> = {
    claude: require('@/assets/images/icon-claude.png'),
    codex: require('@/assets/images/icon-gpt.png'),
};

/** The engine, when there is no engine header above the row to say it. */
const EngineBadge = React.memo(({ session }: { session: Session }) => {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const source = ENGINE_ICONS[engineKeyForSession(session)];
    return source
        ? <Image source={source} style={{ width: 14, height: 14, borderRadius: 4 }} contentFit="cover" />
        : <Ionicons name="hardware-chip-outline" size={13} color={colors.tertiary} />;
});

/**
 * The "MacMini → Claude" level carries the project avatar: the engine icon by
 * default, or whatever the user picked through the same customize menu the
 * old project cards had. Stored under `projectAvatarOverrides` keyed by
 * device + engine.
 */
const EngineHeader = React.memo(({ group, engine }: { group: LmcDeviceGroup; engine: LmcEngineGroup }) => {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const avatarKey = `lmc:${group.machineId ?? 'unknown'}:${engine.key}`;
    const override = useSetting('projectAvatarOverrides')[avatarKey];
    const source = override?.uri ? { uri: override.uri } : ENGINE_ICONS[engine.key] ?? null;
    return (
        <View style={styles.engineHeader}>
            <ProjectAvatarButton projectId={avatarKey} ordinary projectName={`${group.name} · ${engine.label}`} hasCustomAvatar={!!override}>
                <View style={[styles.engineAvatar, { backgroundColor: colors.subtle }]}>
                    {source
                        ? <Image source={source} placeholder={override?.thumbhash ? { thumbhash: override.thumbhash } : undefined} style={{ width: 22, height: 22 }} contentFit="cover" />
                        : <Ionicons name="hardware-chip-outline" size={14} color={colors.tertiary} />}
                </View>
                <Text style={styles.engineName}>{engine.label}</Text>
                <Text style={[styles.engineName, { color: colors.placeholder, ...Typography.default() }]}>{engine.sessions.length}</Text>
            </ProjectAvatarButton>
        </View>
    );
});

const DeviceSection = React.memo(({ group, selectedSessionId, now, onNavigate, onDropOn }: { group: LmcDeviceGroup; selectedSessionId?: string; now: number; onNavigate?: () => void; onDropOn?: (sessionId: string, target: string) => void }) => {
    const { theme } = useUnistyles();
    const groupByEngine = useSetting('sessionListGroupByEngine');
    const colors = lmcColors(theme);
    const router = useRouter();
    const [collapsed, setCollapsed] = React.useState(false);
    // Collapse animates rather than cutting: the device's rows slide up behind
    // its header, and the chevron turns with them.
    const [bodyHeight, setBodyHeight] = React.useState(0);
    const [expandedSettled, setExpandedSettled] = React.useState(true);
    const progress = useSharedValue(1);
    React.useEffect(() => {
        if (collapsed) setExpandedSettled(false);
        progress.value = withTiming(
            collapsed ? 0 : 1,
            { duration: collapsed ? 200 : 260, easing: Easing.out(Easing.cubic) },
            (done) => { if (done && !collapsed) runOnJS(setExpandedSettled)(true); },
        );
    }, [collapsed, progress]);
    // Once open, the wrapper hands height back to the content so a dragged row
    // can lift out of it without being clipped.
    const bodyStyle = useAnimatedStyle(() => (expandedSettled
        ? { opacity: 1 }
        : { height: bodyHeight ? progress.value * bodyHeight : undefined, opacity: progress.value }));
    const chevronStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${-90 + progress.value * 90}deg` }] }));

    const meta = [group.agentVersion ? `Agent ${group.agentVersion}` : null, group.online ? null : t('lmc.list.offline')].filter(Boolean).join(' · ');
    return (
        <View>
            <View style={styles.deviceHeader}>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('lmc.list.deviceDetail', { name: group.name })}
                    disabled={!group.machineId}
                    onPress={() => { onNavigate?.(); router.push(`/machine/${group.machineId}`); }}
                    style={({ pressed }) => ({ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8, opacity: pressed ? 0.6 : 1 })}
                >
                    <Ionicons name="laptop-outline" size={18} color={group.online ? theme.colors.text : colors.placeholder} />
                    <Text style={[styles.deviceName, !group.online && { color: colors.placeholder }]}>{group.name}</Text>
                    <Text numberOfLines={1} style={styles.deviceMeta}>{meta}</Text>
                </Pressable>
                {group.attentionCount > 0 && (
                    <View style={[styles.badge, { backgroundColor: colors.attention }]}><Text style={styles.badgeText}>{group.attentionCount}</Text></View>
                )}
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={collapsed ? t('lmc.list.expand') : t('lmc.list.collapse')}
                    accessibilityState={{ expanded: !collapsed }}
                    onPress={() => setCollapsed((v) => !v)}
                    hitSlop={8}
                    style={({ pressed }) => [styles.groupChevron, { borderRadius: 8, opacity: pressed ? 0.6 : 1 }]}
                >
                    <Animated.View style={chevronStyle}>
                        <Ionicons name="chevron-down" size={16} color={theme.colors.textSecondary} />
                    </Animated.View>
                </Pressable>
            </View>
            <Animated.View style={[{ overflow: expandedSettled ? 'visible' : 'hidden' }, bodyStyle]}>
            <View onLayout={(event) => {
                const next = Math.round(event.nativeEvent.layout.height);
                setBodyHeight((current) => (Math.abs(current - next) < 1 ? current : next));
            }}>
            {groupByEngine ? group.engines.map((engine) => (
                <View key={engine.key}>
                    <EngineHeader group={group} engine={engine} />
                    <View style={styles.engineGroup}>
                        <SortableSessionRows
                            groupId={`lmc:${group.machineId ?? 'unknown'}:${engine.key}`}
                            sessions={engine.sessions}
                            highlightInset={24}
                            ownDropTarget="ungroup"
                            onDropOn={onDropOn}
                            renderRow={(session) => (
                                <SessionRow key={session.id} session={session} selected={session.id === selectedSessionId} now={now} onNavigate={onNavigate} meta={{ extras: [modelNameOf(session) ?? ''].filter(Boolean) }} />
                            )}
                        />
                        {/* Drawn after the rows so a selected or hovered row never
                            paints over the line that shows what it belongs to. */}
                        <View pointerEvents="none" style={[styles.engineGuide, { backgroundColor: theme.colors.divider }]} />
                    </View>
                </View>
            )) : group.engines.length > 0 && (
                // One list per device, engines interleaved by when work started
                // and named by a badge on the row. Its drag order is kept under
                // the device alone, separate from the per-engine orders above,
                // so switching layouts never reshuffles either.
                <View style={styles.engineGroup}>
                    <SortableSessionRows
                        groupId={`lmc:${group.machineId ?? 'unknown'}`}
                        sessions={flattenDeviceSessions(group)}
                        highlightInset={24}
                        ownDropTarget="ungroup"
                        onDropOn={onDropOn}
                        renderRow={(session) => (
                            <SessionRow key={session.id} session={session} selected={session.id === selectedSessionId} now={now} onNavigate={onNavigate} meta={{ engine: ((k) => k === 'other' ? null : k)(engineKeyForSession(session)), extras: [modelNameOf(session) ?? ''].filter(Boolean) }} />
                        )}
                    />
                    <View pointerEvents="none" style={[styles.engineGuide, { backgroundColor: theme.colors.divider }]} />
                </View>
            )}
            {group.engines.length === 0 && (
                <Text style={[styles.status, { color: colors.placeholder, paddingLeft: 14, paddingBottom: 6 }]}>{t('lmc.list.noSessionsOnDevice')}</Text>
            )}
            </View>
            </Animated.View>
        </View>
    );
});

/**
 * A hub and its workers, at the top of the list whatever devices they run on.
 *
 * The hub row names the session and how many workers it has; each worker row
 * keeps its own title (its duty is the 【…】 prefix the hub gave it) and wears
 * its device and engine as a suffix, since the group no longer says where a
 * session lives. While a row is being dragged over this group the whole group
 * becomes the drop target — releasing binds the row as a worker.
 */
const HubSection = React.memo(({ group, machines, selectedSessionId, now, onNavigate, onDropOn, dragHandleProps, pendingDuty, onPickDuty }: { group: LmcHubGroup; machines: Machine[]; selectedSessionId?: string; now: number; onNavigate?: () => void; onDropOn: (sessionId: string, target: string) => void; /** Spread onto the hub header row, the handle for whole-group reordering. */ dragHandleProps?: Record<string, unknown>; /** Workers just bound by a drag, still waiting on a duty pick, keyed by their session id. */ pendingDuty: PendingDutyState; onPickDuty: (workerId: string, duty: string) => void }) => {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const navigate = useNavigateToSession();
    const target = `hub:${group.hub.id}`;
    const hovered = useDragTarget((state) => state.target) === target;
    // The same right-click / long-press menu every ordinary row gets.
    const { anchor: headerAnchor, closeMenu: closeHeaderMenu, menuProps: headerMenuProps } = useSessionRowMenu(group.hub.id);
    const [headerHovered, setHeaderHovered] = React.useState(false);
    const headerHoverProps = Platform.OS === 'web' ? ({ onMouseEnter: () => setHeaderHovered(true), onMouseLeave: () => setHeaderHovered(false) } as any) : {};
    const deviceOf = (session: Session) => machineDisplayName(machines.find((m) => m.id === session.metadata?.machineId), session.metadata?.host ?? '');
    const engineOf = (session: Session): 'claude' | 'codex' | null => { const k = engineKeyForSession(session); return k === 'other' ? null : k; };
    const hubSelected = group.hub.id === selectedSessionId;
    const hubModel = modelNameOf(group.hub);
    const hubEffort = group.hub.metadata?.effortLevel;
    const orchestration = group.hub.metadata?.orchestration;
    const board: BoardEntry[] = orchestration?.role === 'hub' ? (orchestration.board ?? []) : [];
    const [, bump] = React.useState(0);
    // Each worker's tasks, newest first: everything in progress, then the last few done.
    const tasksOf = (workerId: string | null) => {
        const mine = board.filter((e) => e.counterpart === workerId);
        return [...mine.filter((e) => !isClosedState(e.state)), ...mine.filter((e) => isClosedState(e.state)).slice(0, 3)].sort((a, b) => b.updatedAt - a.updatedAt);
    };
    // Closed by default: the row says what matters (its status mark); the
    // tasks are there for whoever wants to look.
    const isOpen = (workerId: string) => tasksOpenByWorker.get(workerId) ?? false;
    const toggle = (workerId: string) => { tasksOpenByWorker.set(workerId, !isOpen(workerId)); bump((n) => n + 1); };
    // Tasks wear the same three-state mark as sessions: in progress, done, needs a person.
    const taskTone = taskRowTone;
    const needsPerson = hasTaskAttention;
    const pad = (n: number) => String(n).padStart(2, '0');
    const unassigned = tasksOf(null);
    const hubLine = describeLmcSessionStatus(group.hub, now);
    const hubUnread = useSessionUnread(group.hub.id);
    const hubTone = hubLine.tone === 'idle' && hubUnread ? 'done' : hubLine.tone;

    // Collapsing a hub hides its workers the way a device group hides its rows:
    // same animation, same chevron, so the two levels behave alike.
    const [collapsed, setCollapsed] = React.useState(() => hubCollapsedById.get(group.hub.id) ?? false);
    const [bodyHeight, setBodyHeight] = React.useState(0);
    const [expandedSettled, setExpandedSettled] = React.useState(!collapsed);
    const progress = useSharedValue(collapsed ? 0 : 1);
    React.useEffect(() => {
        if (collapsed) setExpandedSettled(false);
        progress.value = withTiming(
            collapsed ? 0 : 1,
            { duration: collapsed ? 200 : 260, easing: Easing.out(Easing.cubic) },
            (done) => { if (done && !collapsed) runOnJS(setExpandedSettled)(true); },
        );
    }, [collapsed, progress]);
    // Once open the wrapper hands height back, so a dragged row can lift out
    // of the group without being clipped.
    const hubBodyStyle = useAnimatedStyle(() => (expandedSettled
        ? { opacity: 1 }
        : { height: bodyHeight ? progress.value * bodyHeight : undefined, opacity: progress.value }));
    const hubChevronStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${-90 + progress.value * 90}deg` }] }));
    const toggleCollapsed = () => setCollapsed((value) => { hubCollapsedById.set(group.hub.id, !value); return !value; });
    const hubRingTone = hubTone === 'working' || hubTone === 'attention' || hubTone === 'done' ? hubTone : null;
    // One slot, shared: the status mark holds it, and pointing at the row swaps
    // in the chevron. Without a mark there is nothing to yield to, and off the
    // web there is no hover at all — either way the chevron simply stays.
    const showHubChevron = Platform.OS === 'web' ? (headerHovered || headerAnchor !== null || !hubRingTone) : true;

    const TaskRows = ({ tasks, indent }: { tasks: BoardEntry[]; indent: number }) => (
        <>
            {tasks.map((entry) => {
                const at = new Date(entry.updatedAt);
                const took = isClosedState(entry.state) ? Math.max(1, Math.round((entry.updatedAt - entry.firstAt) / 60000)) : null;
                return (
                    <Pressable
                        key={entry.id}
                        accessibilityRole="button"
                        onPress={() => { onNavigate?.(); navigate(entry.counterpart ?? group.hub.id); }}
                        style={({ pressed }) => [styles.taskRow, { marginLeft: indent }, pressed && styles.rowPressed]}
                    >
                        <View style={styles.rowLine}>
                            <View style={[styles.idChip, { backgroundColor: colors.subtle }]}><RNText style={[styles.idChipText, { color: colors.tertiary }]}>{entry.id}</RNText></View>
                            <RNText numberOfLines={1} style={[styles.taskTitle, { flexShrink: 1 }]}>{entry.title}</RNText>
                            <View style={{ flex: 1 }} />
                            <SessionStatusRing tone={taskTone(entry)} size={10} />
                        </View>
                        <View style={styles.rowLine}>
                            <RNText numberOfLines={1} style={[styles.metaText, { color: colors.tertiary, flexShrink: 1 }]}>{entry.stage ?? ''}</RNText>
                            <View style={{ flex: 1 }} />
                            <RNText style={[styles.metaText, { color: colors.tertiary }]}>{pad(at.getHours())}:{pad(at.getMinutes())}{took ? ` · ${t('lmc.orchestration.took', { minutes: took })}` : ''}</RNText>
                        </View>
                    </Pressable>
                );
            })}
        </>
    );

    return (
        <View
            {...(Platform.OS === 'web' ? ({ dataSet: { dropTarget: target } } as any) : {})}
            style={[styles.hubGroup, hovered && { backgroundColor: colors.brand + '14', borderColor: colors.brand, borderStyle: 'dashed' }]}
        >
            <View {...headerHoverProps}>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${getSessionName(group.hub)}，${t('lmc.orchestration.hubCount', { n: group.workers.length })}`}
                    onPress={() => { onNavigate?.(); navigate(group.hub.id); }}
                    style={({ pressed }) => [styles.hubHeader, (hubSelected || pressed) && { backgroundColor: hubSelected ? colors.rowSelected : theme.colors.surfacePressed }, SESSION_ROW_MENU_STYLE]}
                    {...headerMenuProps}
                    {...dragHandleProps}
                >
                    <View style={styles.rowLine}>
                        <Ionicons name="disc-outline" size={18} color={colors.brand} />
                        <RNText numberOfLines={1} style={[styles.hubName, { flexShrink: 1 }, bracketTrim(getSessionName(group.hub))]}>{getSessionName(group.hub)}</RNText>
                        <View style={{ flex: 1 }} />
                        <View style={styles.dots}>
                            {!showHubChevron && hubRingTone && <SessionStatusRing tone={hubRingTone} size={14} />}
                            {showHubChevron && (
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityLabel={collapsed ? t('lmc.list.expand') : t('lmc.list.collapse')}
                                    accessibilityState={{ expanded: !collapsed }}
                                    onPress={(e) => { e.stopPropagation?.(); toggleCollapsed(); }}
                                    hitSlop={8}
                                    style={({ pressed }) => [styles.hubChevron, pressed && { opacity: 0.6 }]}
                                >
                                    <Animated.View style={hubChevronStyle}>
                                        <Ionicons name="chevron-down" size={16} color={theme.colors.textSecondary} />
                                    </Animated.View>
                                </Pressable>
                            )}
                        </View>
                    </View>
                    <View style={[styles.rowLine, { paddingLeft: 26 }]}>
                        <Ionicons name="laptop-outline" size={12} color={colors.tertiary} />
                        <RNText numberOfLines={1} style={[styles.metaText, { color: colors.tertiary, maxWidth: 96 }]}>{deviceOf(group.hub)}</RNText>
                        {engineOf(group.hub) && <ProviderIcon kind={engineOf(group.hub)} size={12} />}
                        {hubModel && (
                            <RNText numberOfLines={1} ellipsizeMode="tail" style={[styles.metaText, { color: colors.tertiary, flexShrink: 1 }]}>
                                {hubModel}{hubEffort ? ` · ${effortDisplayName(hubEffort)}` : ''}
                            </RNText>
                        )}
                    </View>
                </Pressable>
                {Platform.OS === 'web' && (
                    <SessionActionsPopover anchor={headerAnchor} onClose={closeHeaderMenu} sessionId={group.hub.id} visible={headerAnchor !== null} />
                )}
            </View>
            {hovered && <RNText style={[styles.dropHint, { color: colors.brand }]}>{t('lmc.orchestration.dropToBind')}</RNText>}
            <Animated.View style={[{ overflow: expandedSettled ? 'visible' : 'hidden' }, hubBodyStyle]}>
            <View onLayout={(event) => {
                const next = Math.round(event.nativeEvent.layout.height);
                setBodyHeight((current) => (Math.abs(current - next) < 1 ? current : next));
            }}>
            <View style={styles.engineGroup}>
                <SortableSessionRows
                    groupId={`lmc:hub:${group.hub.id}`}
                    sessions={group.workers}
                    highlightInset={28}
                    ownDropTarget={target}
                    onDropOn={onDropOn}
                    renderRow={(session) => {
                        const tasks = tasksOf(session.id);
                        const open = isOpen(session.id);
                        return (
                            <View key={session.id}>
                                <SessionRow
                                    session={session}
                                    selected={session.id === selectedSessionId}
                                    now={now}
                                    onNavigate={onNavigate}
                                    indent={28}
                                    alert={needsPerson(tasks)}
                                    meta={{ device: deviceOf(session), engine: engineOf(session), toggle: tasks.length ? { open, onToggle: () => toggle(session.id) } : null }}
                                />
                                {open && <TaskRows tasks={tasks} indent={48} />}
                                {pendingDuty.has(session.id) && (
                                    <DutyChipRow
                                        compact
                                        style={{ paddingHorizontal: 0, marginLeft: 32, marginBottom: 6 }}
                                        onPick={(duty) => onPickDuty(session.id, duty)}
                                    />
                                )}
                            </View>
                        );
                    }}
                />
                {group.workers.length > 0 && <View pointerEvents="none" style={[styles.engineGuide, { left: 21 }, { backgroundColor: theme.colors.divider }]} />}
            </View>
            {unassigned.length > 0 && (
                <>
                    <RNText style={[styles.metaText, { color: colors.tertiary, paddingLeft: 48, paddingTop: 6 }]}>{t('lmc.orchestration.unassigned')}</RNText>
                    <TaskRows tasks={unassigned} indent={48} />
                </>
            )}
            {group.workers.length === 0 && !hovered && (
                <Text style={[styles.status, { color: colors.placeholder, paddingLeft: 30, paddingBottom: 8 }]}>{t('lmc.orchestration.dropToBind')}</Text>
            )}
            </View>
            </Animated.View>
        </View>
    );
});

/**
 * Archived sessions, collapsed by default and animating like a device group.
 * Its rows mount when it opens and unmount once the collapse finishes, so a
 * long archive costs nothing while it is closed.
 */
const ArchivedSection = React.memo(({ sessions, open, onToggle, selectedSessionId, now, onNavigate }: {
    sessions: Session[];
    open: boolean;
    onToggle: () => void;
    selectedSessionId?: string;
    now: number;
    onNavigate?: () => void;
}) => {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const [mounted, setMounted] = React.useState(open);
    const [bodyHeight, setBodyHeight] = React.useState(0);
    const [openSettled, setOpenSettled] = React.useState(open);
    const progress = useSharedValue(open ? 1 : 0);

    React.useEffect(() => {
        if (open) setMounted(true);
        else setOpenSettled(false);
        progress.value = withTiming(
            open ? 1 : 0,
            { duration: open ? 260 : 200, easing: Easing.out(Easing.cubic) },
            (done) => { if (done) runOnJS(open ? setOpenSettled : setMounted)(open); },
        );
    }, [open, progress]);

    const bodyStyle = useAnimatedStyle(() => (openSettled
        ? { opacity: 1 }
        : { height: bodyHeight ? progress.value * bodyHeight : undefined, opacity: progress.value }));
    const chevronStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${-90 + progress.value * 90}deg` }] }));

    return (
        <View>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('lmc.list.archivedToggle', { count: sessions.length, open })}
                accessibilityState={{ expanded: open }}
                onPress={onToggle}
                style={({ pressed }) => [styles.deviceHeader, pressed && styles.rowPressed]}
            >
                <Ionicons name="archive-outline" size={18} color={colors.placeholder} />
                <Text style={[styles.deviceName, { color: colors.tertiary }]}>{t('lmc.list.archived')}</Text>
                <Text numberOfLines={1} style={styles.deviceMeta}>{sessions.length}</Text>
                {/* Same 28pt box the device rows give their chevron, so the two
                    land on one column. */}
                <Animated.View style={[styles.groupChevron, chevronStyle]}>
                    <Ionicons name="chevron-down" size={16} color={theme.colors.textSecondary} />
                </Animated.View>
            </Pressable>
            {mounted && (
                <Animated.View style={[{ overflow: openSettled ? 'visible' : 'hidden' }, bodyStyle]}>
                    <View onLayout={(event) => {
                        const next = Math.round(event.nativeEvent.layout.height);
                        setBodyHeight((current) => (Math.abs(current - next) < 1 ? current : next));
                    }}>
                        {sessions.map((session) => (
                            <SessionRow key={session.id} session={session} selected={session.id === selectedSessionId} now={now} onNavigate={onNavigate} />
                        ))}
                    </View>
                </Animated.View>
            )}
        </View>
    );
});

/**
 * The approved LMC session list: device → Claude / Codex → session, with the
 * status ring and one line of "what the agent is doing" per row. Shared by
 * the desktop sidebar and the phone floating drawer.
 */
export const DeviceEngineSessionList = React.memo(({ onNavigate, hideSearch, hideAccount, query: controlledQuery, contentPaddingBottom = 8 }: DeviceEngineSessionListProps) => {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const router = useRouter();
    const sessions = useAllSessions();
    const machines = useAllMachines({ includeOffline: true });
    const isDataReady = useIsDataReady();
    const selectedSessionId = useSelectedSessionId();
    const [ownQuery, setQuery] = React.useState('');
    const query = controlledQuery ?? ownQuery;

    const hubOrder = useSetting('sessionProjectOrder')['lmc:hubs'];
    const [archivedOpen, setArchivedOpen] = React.useState(false);
    const { hubs, groups, archived } = React.useMemo(() => {
        const q = query.trim().toLowerCase();
        const visible = q ? sessions.filter((s) => getSessionName(s).toLowerCase().includes(q) || (s.metadata?.path ?? '').toLowerCase().includes(q)) : sessions;
        // Hubs and their workers come first, as their own groups; what is left
        // is grouped by device. Archived sessions never mix into either; they
        // sit in one collapsed section at the bottom so the live list stays short.
        const { hubs, rest } = splitHubGroups(visible, hubOrder);
        const built = buildDeviceEngineGroups(rest, machines, { includeArchived: false });
        return { hubs, groups: q ? built.filter((g) => g.engines.length > 0) : built, archived: collectArchivedSessions(visible) };
    }, [sessions, machines, query, hubOrder]);

    // Workers just bound by a drag, with no duty of their own yet: each row
    // grows a pick-a-duty chip strip for a few seconds, then gives up
    // quietly — independently per worker, so two drops landing close
    // together never clear or clobber each other's offer.
    const [pendingDuty, setPendingDuty] = React.useState<PendingDutyState>(() => new Map());
    const pendingDutyTimers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());
    const clearPendingDutyFor = React.useCallback((workerId: string) => {
        const timer = pendingDutyTimers.current.get(workerId);
        if (timer) { clearTimeout(timer); pendingDutyTimers.current.delete(workerId); }
        setPendingDuty((state) => clearPendingDuty(state, workerId));
    }, []);
    const armPendingDutyFor = React.useCallback((workerId: string) => {
        const existing = pendingDutyTimers.current.get(workerId);
        if (existing) clearTimeout(existing);
        setPendingDuty((state) => armPendingDuty(state, workerId, Date.now()));
        pendingDutyTimers.current.set(workerId, setTimeout(() => {
            pendingDutyTimers.current.delete(workerId);
            setPendingDuty((state) => clearPendingDuty(state, workerId));
        }, PENDING_DUTY_MS));
    }, []);
    React.useEffect(() => () => {
        for (const timer of pendingDutyTimers.current.values()) clearTimeout(timer);
        pendingDutyTimers.current.clear();
    }, []);
    const onPickDuty = React.useCallback((workerId: string, duty: string) => {
        clearPendingDutyFor(workerId);
        const worker = storage.getState().sessions[workerId];
        if (!worker) return;
        sessionUpdateMetadata(workerId, (metadata) => ({
            ...metadata,
            summary: { text: applyDutyPrefix(getSessionName(worker), duty), updatedAt: Date.now() },
        })).catch(reportFailure);
    }, [clearPendingDutyFor]);

    // A row released over another group. `hub:<id>` binds it as that hub's
    // worker — freshly bound and unnamed, it offers a duty pick right under
    // its new row. `ungroup` releases a worker back to its device; unbinding
    // takes effect at once, with an undo toast rather than a confirm, since
    // it is reversible for as long as the toast is up.
    const onDropOn = React.useCallback((sessionId: string, target: string) => {
        const dragged = storage.getState().sessions[sessionId];
        const orchestration = dragged?.metadata?.orchestration;
        const role = orchestration?.role;
        void (async () => {
            try {
                if (target.startsWith('hub:')) {
                    const hubId = target.slice(4);
                    if (hubId === sessionId) return;
                    if (role === 'hub') { Modal.alert(t('lmc.orchestration.failed'), t('lmc.orchestration.cannotBindHub')); return; }
                    await bindWorker(hubId, sessionId, 'manual');
                    if (!parseDutyPrefix(getSessionName(dragged!))) armPendingDutyFor(sessionId);
                } else if (target === 'ungroup' && orchestration?.role === 'worker') {
                    const hubId = orchestration.hub.sessionId;
                    await unbindWorker(sessionId);
                    showUndoToast(t('lmc.orchestration.toastUnbound', { name: getSessionName(dragged!) }), () => bindWorker(hubId, sessionId, 'manual'));
                }
            } catch (error) {
                Modal.alert(t('lmc.orchestration.failed'), error instanceof Error ? error.message : String(error));
            }
        })();
    }, [armPendingDutyFor]);

    const anyWorking = React.useMemo(() => sessions.some((s) => s.thinking && s.presence === 'online'), [sessions]);
    const now = useTicker(anyWorking);

    return (
        <View style={styles.root}>
            {!hideSearch && (
                <SessionSearchRow query={query} onQueryChange={setQuery} onNavigate={onNavigate} />
            )}
            {/* The bar moves to the left edge, clear of the row's ⋮ button:
                the scroller runs RTL and the content is flipped back. */}
            <ScrollView
                style={[
                    styles.scroll,
                    // The scroller reaches past its card's padding so the bar
                    // rides the card's inner edge instead of grazing the device
                    // icons; the content is padded back to where it was.
                    // Centred in the card's gutter — flush left it grazed the
                    // border, flush right it grazed the device icons — and held
                    // clear of the top and bottom so it follows the card's radius.
                    Platform.OS === 'web' && ({ direction: 'rtl', marginLeft: -4, marginVertical: 6 } as any),
                ]}
                contentContainerStyle={[
                    { paddingBottom: contentPaddingBottom },
                    Platform.OS === 'web' && ({ direction: 'ltr', paddingLeft: 4 } as any),
                ]}
                keyboardShouldPersistTaps="handled"
            >
                {!isDataReady && (
                    // Placeholder rows while the store hydrates: an empty-state
                    // sentence here would claim there are no devices when we
                    // simply have not read them yet.
                    <View style={{ paddingTop: 8 }}>
                        {[0, 1, 2, 3, 4, 5].map((index) => (
                            <View key={index} style={{ height: index % 3 === 0 ? 26 : 36, marginBottom: 6, marginHorizontal: index % 3 === 0 ? 8 : 20, borderRadius: 8, opacity: 0.5 - index * 0.05, backgroundColor: colors.subtle }} />
                        ))}
                    </View>
                )}
                {isDataReady && groups.length === 0 && (
                    <Text style={styles.empty}>{query ? t('lmc.list.noMatches') : t('lmc.list.noDevices')}</Text>
                )}
                {isDataReady && hubs.length > 0 && (
                    <SortableHubGroups
                        storageKey="lmc:hubs"
                        items={hubs}
                        getId={(group) => group.hub.id}
                        renderItem={(group, dragHandleProps) => (
                            <HubSection
                                key={`hub:${group.hub.id}`}
                                group={group}
                                machines={machines}
                                selectedSessionId={selectedSessionId}
                                now={now}
                                onNavigate={onNavigate}
                                onDropOn={onDropOn}
                                dragHandleProps={dragHandleProps}
                                pendingDuty={pendingDuty}
                                onPickDuty={onPickDuty}
                            />
                        )}
                    />
                )}
                <View {...(Platform.OS === 'web' ? ({ dataSet: { dropTarget: 'ungroup' } } as any) : {})}>
                {isDataReady && groups.map((group) => (
                    <DeviceSection key={group.machineId ?? 'unknown'} group={group} selectedSessionId={selectedSessionId} now={now} onNavigate={onNavigate} onDropOn={onDropOn} />
                ))}
                </View>
                {archived.length > 0 && (
                    <ArchivedSection
                        sessions={archived}
                        open={archivedOpen}
                        onToggle={() => setArchivedOpen((v) => !v)}
                        selectedSessionId={selectedSessionId}
                        now={now}
                        onNavigate={onNavigate}
                    />
                )}
            </ScrollView>
            {!hideAccount && (
                <View style={styles.footer}>
                    <AccountSettingsRow onNavigate={onNavigate} />
                </View>
            )}
        </View>
    );
});
