import { resolveTurnElapsed } from '@/utils/turnElapsed';
import { pendingQueuePrompts } from '@/sync/queuedMessageVisibility';
import { useMachine } from '@/sync/storage';
import { withModelCatalogs } from '@/sync/modelCatalogMetadata';
import { EngineAuthBanner } from '@/components/EngineAuthBanner';
import { SessionResourceWindow } from '@/components/SessionResourceWindow';
import { CHAT_WIDE_WIDTH, ChatWidthContext, useChatMaxWidth } from '@/components/ChatWidthContext';
import { Ionicons as SidebarIcon } from '@expo/vector-icons';
import { SessionHeaderActions } from '@/components/SessionHeaderActions';
import { SessionRefreshBanner } from '@/components/SessionRefreshBanner';
import { isRefreshPending } from '@/sync/sessionRefreshProgress';
import { resolveMessageModeMeta, UnsupportedPermissionModeError } from '@/sync/messageMeta';
import { AgentContentView } from '@/components/AgentContentView';
import { MobileGlassBackdrop } from '@/components/MobileGlass';
import { LinearGradient } from 'expo-linear-gradient';
import { AgentGoalBar, type AgentGoalAction } from '@/components/AgentGoalBar';
import { AgentQuestionBanner } from '@/components/AgentQuestionBanner';
import { AgentInput } from '@/components/AgentInput';
import { useSessionDrawer } from '@/components/lmc/sessionDrawerStore';
import { useFocusEffect } from '@react-navigation/native';
import { resolveVisibleAgentGoalStatus } from '@/components/agentGoalStatus';
import type { MultiTextInputHandle } from '@/components/MultiTextInput';
import { layout } from '@/components/layout';
import {
    preserveCodexEffortSelection,
    UnsupportedCodexEffortError,
    getCatalogDefaultEffort,
    getAvailableModels,
    getAvailablePermissionModes,
    getEffortLevelsForModel,
    getRigCurrentModelOptionKey,
    resolveCurrentOption,
    EffortLevel,
} from '@/components/modelModeOptions';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { ChatHeaderView } from '@/components/ChatHeaderView';
import { ChatList } from '@/components/ChatList';
import { Deferred } from '@/components/Deferred';
import { EmptyMessages } from '@/components/EmptyMessages';
import { Avatar } from '@/components/Avatar';
import { VoiceAssistantStatusBar, VOICE_PILL_TOTAL_HEIGHT } from '@/components/VoiceAssistantStatusBar';
import { useDraft } from '@/hooks/useDraft';
import { useImagePicker } from '@/hooks/useImagePicker';
import { Modal } from '@/modal';
import { applyPendingEngineModel, switchSessionEngine } from '@/sync/sessionConfiguration';
import { isSwitchableEngine, type SwitchableEngine } from '@/sync/engineSwitch';
import { ENGINE_NAMES } from '@/sync/engineModelCatalog';
import { sessionCapabilities } from '@/sync/sessionCapabilities';
import { gitStatusSync } from '@/sync/gitStatusSync';
import { sessionAbort, sessionCancelCommunication, sessionGoalAction, sessionSetAgentModes, spawnSideChat, sessionKill, sessionArchive } from '@/sync/ops';
import { queueSteerState, sessionDequeue, sessionPromoteQueued, sessionSetQueueMode, sessionSteerQueued, sessionSupportsTurnQueue, steerFailureKey, type MessageIntent, type QueueMode } from '@/sync/turnQueue';
import { storage, useIsDataReady, useLocalSetting, useRealtimeStatus, useSessionGitStatus, useSessionMessages, useSessionPendingCommunications, useSessionUsage, useSetting, useSideChatSessions } from '@/sync/storage';
import { useSession } from '@/sync/storage';
import { getSessionForkSource } from '@/utils/sessionFork';
import { useLmcAction } from '@/hooks/useLmcAction';
import { LmcError } from '@/utils/errors';
import { Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { supportsImageAttachmentsForFlavor } from '@/sync/attachmentSupport';
import { t } from '@/text';
import { tracking } from '@/track';
import { getVoiceMessageCount, getVoiceOnboardingPromptLoadCount } from '@/sync/persistence';
import { isRunningOnMac } from '@/utils/platform';
import { useDeviceType, useHeaderHeight, useIsLandscape, useIsTablet } from '@/utils/responsive';
import { resolveStatusBarGitBranch } from '@/utils/sessionStatusBar';
import { visibleRigGitLineChanges } from '@/utils/rigGitLineChanges';
import { FilesSidebar, SidebarMode } from '@/components/FilesSidebar';
import { AllFilesDiffView } from '@/components/AllFilesDiffView';
import { FileViewPanel } from '@/components/FileViewPanel';
import { GitFileStatus } from '@/sync/gitStatusFiles';
import { useOverlayNav } from '@/-session/sessionOverlayNav';
import { useSidebarMetrics } from '@/components/lmc/sidebarMetrics';
import { openSessionDrawer } from '@/components/lmc/sessionDrawerStore';
import { useToolOverlay } from '@/components/lmc/toolOverlayStore';
import { SessionToolOverlay } from '@/components/lmc/SessionToolOverlay';
import { lmcElevation, lmcSurfaceBorder } from '@/components/lmc/elevation';
import { formatPathRelativeToHome, getResumeCommandBlock, getSessionAvatarId, getSessionName, useSessionStatus } from '@/utils/sessionUtils';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { isVersionSupported, MINIMUM_CLI_VERSION } from '@/utils/versionUtils';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as React from 'react';
import { useMemo } from 'react';
import { ActivityIndicator, LayoutChangeEvent, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ModelMode, PermissionMode } from '@/components/PermissionModeSelector';
import { resolveAgentDefaultConfig } from '@/sync/agentDefaults';
import { performAgentGoalAction } from './agentGoalActionHandler';
import { DESKTOP_HEADER_HEIGHT, MOBILE_GLASS_HEADER_HEIGHT } from '@/components/navigation/headerMetrics';
import {
    getRigGitSummary,
    getRigReasoningSelection,
    isRigMetadata,
    isRigMetadataV1,
    isRigModelSelectionEnabled,
    isRigPermissionSelectionEnabled,
    isRigReasoningSelectionEnabled,
    rigCanAbort,
    rigCanBrowseFiles,
    rigCanReadFiles,
    rigCanUseAttachments,
    rigCanUseShell,
} from '@/sync/rig';
import { RigActivityBar } from '@/components/RigActivityBar';
import { AnimatedFade } from '@/components/AnimatedOverlay';

/** Matches SidebarNavigator's permanent desktop drawer. */
const DESKTOP_SIDEBAR_WIDTH = 360;
/** The inset SidebarView gives its cards, top and sides. */
const STATUS_CARD_INSET = 8;
/** How much of the gutter a status card may take, and how little is worth it. */
const STATUS_CARD_MIN_WIDTH = 300;
const STATUS_CARD_MAX_WIDTH = 420;

export const SessionView = React.memo((props: { id: string }) => {
    const sessionId = props.id;
    const router = useRouter();
    const session = useSession(sessionId);
    const isDataReady = useIsDataReady();
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const headerHeight = useHeaderHeight();
    const mobileHeaderHeight = deviceType === 'phone' && Platform.OS !== 'web'
        ? Math.max(headerHeight, MOBILE_GLASS_HEADER_HEIGHT)
        : headerHeight;
    // The header is an overlay of pills rather than a bar, so the transcript
    // occupies the whole pane and scrolls beneath it. Its list insets keep the
    // first and last messages clear of the pills and the composer.
    const contentRunsUnderHeader = Platform.OS === 'web'
        || (deviceType === 'phone' && !isLandscape);
    const realtimeStatus = useRealtimeStatus();
    const isTablet = useIsTablet();
    const { width: windowWidth, height: windowHeight } = useWindowDimensions();
    const fileDiffsSidebarEnabled = useSetting('fileDiffsSidebar');
    const zenMode = useLocalSetting('zenMode');
    const [headerBackdropVisible, setHeaderBackdropVisible] = React.useState(false);
    // Measured by the sidebar itself, so the status card stands exactly as tall.
    const sidebarCardHeight = useSidebarMetrics((state) => state.headerCardHeight) || undefined;

    React.useEffect(() => {
        setHeaderBackdropVisible(false);
    }, [sessionId]);

    // Base condition: can we show the diff sidebar at all?
    const canShowSidebar = fileDiffsSidebarEnabled
        && (isRunningOnMac() || Platform.OS === 'web')
        && windowWidth >= SIDEBAR_MIN_WINDOW_WIDTH
        && (!session || (rigCanBrowseFiles(session.metadata) && rigCanUseShell(session.metadata)))
        && isDataReady && !!session;

    const chatWideMode = useLocalSetting('chatWideMode');
    const [resourceBrowser, setResourceBrowser] = React.useState(false);
    const [sidebarExpanded, setSidebarExpanded] = React.useState(false);
    React.useEffect(() => { setSidebarExpanded(false); setResourceBrowser(false); }, [sessionId]);
    const showSidebar = canShowSidebar && !zenMode && sidebarExpanded;

    // Match left sidebar width: 30% of window, clamped to 250–360px
    const sidebarWidth = Math.min(windowWidth - 32, 340);

    // Sidebar panels are user-managed and persisted in local settings so the
    // layout (which panels are open + which is active) survives reloads and
    // long absences. State is device-local, shared across sessions.
    const sidebarPanelsOpen = useLocalSetting('sidebarPanelsOpen') as SidebarMode[];
    const sidebarPanelActiveRaw = useLocalSetting('sidebarPanelActive') as SidebarMode | null;
    // Guard against an inconsistent persisted value: the active panel must be
    // one of the open panels, otherwise fall back to the last opened (or none).
    const sidebarPanelActive = React.useMemo<SidebarMode | null>(() => {
        if (sidebarPanelActiveRaw && sidebarPanelsOpen.includes(sidebarPanelActiveRaw)) {
            return sidebarPanelActiveRaw;
        }
        return sidebarPanelsOpen[sidebarPanelsOpen.length - 1] ?? null;
    }, [sidebarPanelActiveRaw, sidebarPanelsOpen]);

    const openSidebarPanel = React.useCallback((panel: SidebarMode) => {
        const cur = storage.getState().localSettings.sidebarPanelsOpen as SidebarMode[];
        const open = cur.includes(panel) ? cur : [...cur, panel];
        storage.getState().applyLocalSettings({ sidebarPanelsOpen: open, sidebarPanelActive: panel });
    }, []);
    const selectSidebarPanel = React.useCallback((panel: SidebarMode) => {
        const cur = storage.getState().localSettings.sidebarPanelsOpen as SidebarMode[];
        if (cur.includes(panel)) {
            storage.getState().applyLocalSettings({ sidebarPanelActive: panel });
        }
    }, []);
    // Raw panel removal (no side-chat teardown). Public closeSidebarPanel below
    // wraps this so closing the "Side chat" chip also tears down its children.
    const removeSidebarPanel = React.useCallback((panel: SidebarMode) => {
        const state = storage.getState().localSettings;
        const open = (state.sidebarPanelsOpen as SidebarMode[]).filter((p) => p !== panel);
        const active = state.sidebarPanelActive === panel
            ? (open[open.length - 1] ?? null)
            : (state.sidebarPanelActive as SidebarMode | null);
        storage.getState().applyLocalSettings({ sidebarPanelsOpen: open, sidebarPanelActive: active });
    }, []);

    // Side chats live inside the single "sideChat" panel as switchable tabs.
    // Creation is unified into the sidebar panel picker (the top "+") so there
    // is no separate per-tab add button. Which side chat is focused lives here
    // (not in the panel) so the picker can create-and-focus a new one in one go.
    const rawSideChats = useSideChatSessions(sessionId);
    const sideChatForkSource = session ? getSessionForkSource(session) : null;
    const [activeSideChatId, setActiveSideChatId] = React.useState<string | null>(null);
    // Optimistically hide a side chat the instant it's closed. The server's
    // /archive only flips active=false (not lifecycleState), so if the CLI is
    // already dead the fallback archive wouldn't drop the tab via
    // useSideChatSessions — this makes the tab disappear immediately regardless.
    const [closedSideChatIds, setClosedSideChatIds] = React.useState<Set<string>>(() => new Set());
    const sideChats = React.useMemo(
        () => rawSideChats.filter((s) => !closedSideChatIds.has(s.id)),
        [rawSideChats, closedSideChatIds],
    );
    // Prune closed ids once the underlying sessions actually leave the store, so
    // the set can't grow without bound.
    React.useEffect(() => {
        setClosedSideChatIds((prev) => {
            if (prev.size === 0) return prev;
            const live = new Set(rawSideChats.map((s) => s.id));
            const next = new Set<string>();
            let changed = false;
            prev.forEach((id) => { if (live.has(id)) next.add(id); else changed = true; });
            return changed ? next : prev;
        });
    }, [rawSideChats]);

    // Best-effort close: kill the agent, fall back to server-side archive.
    const archiveSideChatSession = React.useCallback((id: string) => {
        (async () => {
            const killed = await sessionKill(id);
            if (!killed.success) {
                await sessionArchive(id);
            }
            try {
                await sync.refreshSessions();
            } catch {
                // Broadcast sync reconciles shortly even if this flaked.
            }
        })();
    }, []);

    const [creatingSideChat, createSideChat] = useLmcAction(async () => {
        if (!sideChatForkSource) {
            throw new LmcError(t('sideChat.unavailable'), false);
        }
        const result = await spawnSideChat(sideChatForkSource);
        if (result.type === 'error') {
            throw new LmcError(result.errorMessage, true);
        }
        if (result.type === 'success') {
            setActiveSideChatId(result.sessionId);
            openSidebarPanel('sideChat');
        }
    });

    const closeSideChat = React.useCallback((id: string) => {
        const idx = sideChats.findIndex((s) => s.id === id);
        const neighbour = idx !== -1 ? (sideChats[idx - 1] ?? sideChats[idx + 1] ?? null) : null;
        setActiveSideChatId(neighbour?.id ?? null);
        setClosedSideChatIds((prev) => new Set(prev).add(id));
        if (!neighbour) {
            removeSidebarPanel('sideChat');
        }
        archiveSideChatSession(id);
    }, [sideChats, removeSidebarPanel, archiveSideChatSession]);

    // Closing the "Side chat" panel chip tears down every side chat at once.
    const closeAllSideChats = React.useCallback(() => {
        const ids = sideChats.map((s) => s.id);
        setActiveSideChatId(null);
        setClosedSideChatIds((prev) => {
            const next = new Set(prev);
            ids.forEach((id) => next.add(id));
            return next;
        });
        removeSidebarPanel('sideChat');
        ids.forEach(archiveSideChatSession);
    }, [sideChats, removeSidebarPanel, archiveSideChatSession]);

    const closeSidebarPanel = React.useCallback((panel: SidebarMode) => {
        if (panel === 'sideChat') {
            closeAllSideChats();
            return;
        }
        removeSidebarPanel(panel);
    }, [closeAllSideChats, removeSidebarPanel]);

    // Overlay state is managed as a browser-style history stack so the
    // sidebar's back / forward arrows can navigate between chat ↔ diff ↔ file
    // without a per-overlay close button. Stack + cursor live in one piece
    // of state so functional updates stay coordinated.
    type OverlayEntry =
        | { kind: 'none' }
        | { kind: 'diff'; file: string }
        | { kind: 'file'; path: string }
        | { kind: 'tool'; messageId: string };
    const [overlayHistory, setOverlayHistory] = React.useState<{ stack: OverlayEntry[]; cursor: number }>(
        { stack: [{ kind: 'none' }], cursor: 0 }
    );
    const overlayCurrent = overlayHistory.stack[overlayHistory.cursor] ?? { kind: 'none' };
    const diffViewOpen = overlayCurrent.kind === 'diff';
    const fileViewPath = overlayCurrent.kind === 'file' ? overlayCurrent.path : null;
    const toolOverlayMessageId = overlayCurrent.kind === 'tool' ? overlayCurrent.messageId : null;
    const scrollToFile = overlayCurrent.kind === 'diff' ? overlayCurrent.file : null;

    const pushOverlay = React.useCallback((entry: OverlayEntry) => {
        setOverlayHistory((prev) => {
            const truncated = prev.stack.slice(0, prev.cursor + 1);
            truncated.push(entry);
            return { stack: truncated, cursor: truncated.length - 1 };
        });
    }, []);

    // Tool rows open their detail here rather than pushing a screen; the
    // transcript underneath keeps its scroll position and streaming state.
    React.useEffect(() => {
        useToolOverlay.getState().setOpener((messageId: string) => pushOverlay({ kind: 'tool', messageId }));
        useToolOverlay.getState().setFileOpener((path: string) => pushOverlay({ kind: 'file', path }));
        return () => {
            useToolOverlay.getState().setOpener(null);
            useToolOverlay.getState().setFileOpener(null);
        };
    }, [pushOverlay]);

    const handleSidebarFilePress = React.useCallback((file: GitFileStatus) => {
        if (file.status === 'deleted') return;
        pushOverlay({ kind: 'diff', file: file.fullPath });
    }, [pushOverlay]);
    const handleAllFilesFilePress = React.useCallback((filePath: string) => {
        pushOverlay({ kind: 'file', path: filePath });
    }, [pushOverlay]);

    // When sidebar capability is lost (screen too narrow, disabled), close views.
    // Don't close on zen mode toggle — keep the view visible.
    React.useEffect(() => {
        if (!canShowSidebar) {
            setOverlayHistory({ stack: [{ kind: 'none' }], cursor: 0 });
        }
    }, [canShowSidebar]);

    // Right-side header content published by the active overlay (diff toggle / save button).
    const [headerRightSlot, setHeaderRightSlot] = React.useState<React.ReactNode>(null);

    // Leaving an overlay: step back through the stack, or drop straight to the
    // chat when this is the only entry. The header's close button and the
    // phone overlays share it so every surface exits the same way.
    const closeOverlay = React.useCallback(() => {
        if (!useOverlayNav.getState().back()) {
            setOverlayHistory({ stack: [{ kind: 'none' }], cursor: 0 });
        }
    }, []);

    // Wire intra-session back / forward into the global SidebarNavigator arrows.
    const canOverlayBack = overlayHistory.cursor > 0;
    const canOverlayForward = overlayHistory.cursor < overlayHistory.stack.length - 1;
    React.useEffect(() => {
        useOverlayNav.getState().publish({
            canBack: canOverlayBack,
            canForward: canOverlayForward,
            back: () => {
                if (!canOverlayBack) return false;
                setOverlayHistory((prev) => (
                    prev.cursor <= 0 ? prev : { ...prev, cursor: prev.cursor - 1 }
                ));
                return true;
            },
            forward: () => {
                if (!canOverlayForward) return false;
                setOverlayHistory((prev) => (
                    prev.cursor >= prev.stack.length - 1 ? prev : { ...prev, cursor: prev.cursor + 1 }
                ));
                return true;
            },
        });
        return () => useOverlayNav.getState().reset();
    }, [canOverlayBack, canOverlayForward]);

    // Compute header props based on session state
    const headerProps = useMemo(() => {
        if (!isDataReady) {
            return { title: '', folderName: undefined, isConnected: false };
        }
        if (!session) {
            return { title: t('errors.sessionDeleted'), folderName: undefined, isConnected: false };
        }
        const isConnected = session.presence === 'online';
        const pathSegments = session.metadata?.path?.split(/[/\\]/).filter(Boolean);
        const folderName = pathSegments?.[pathSegments.length - 1];
        const sessionName = getSessionName(session);
        return {
            title: sessionName,
            folderName,
            isConnected,
        };
    }, [session, isDataReady]);
    const headerReady = isDataReady && !!session;
    const headerRight = session && deviceType === 'phone' && Platform.OS === 'web'
        ? <SessionHeaderActions key={sessionId} sessionId={sessionId} />
        : session && deviceType === 'phone' && Platform.OS !== 'web'
        ? (
            <Pressable
                onPress={() => router.push(`/session/${sessionId}/info`)}
                hitSlop={10}
            >
                <Avatar
                    id={getSessionAvatarId(session)}
                    size={28}
                    monochrome={!headerProps.isConnected}
                    flavor={session.metadata?.flavor}
                    clientId={session.metadata?.client?.id}
                />
            </Pressable>
        )
        : null;

    // Desktop: the top bar spans both panes, so it draws the session header.
    // Desktop needs no session header: the sidebar names the session, and the
    // composer's animated rim says when the agent is working.
    const usesSharedTopBar = false;
    // The shared 800pt page width was tuned for settings lists, and reads
    // cramped for a conversation; 910 fills the gutters without losing the
    // centred column. Native phones keep their own screen-derived width.
    const sessionColumnWidth = Number.isFinite(layout.maxWidth) ? 910 : layout.maxWidth;
    const showsSessionHeader = !(Platform.OS === 'web' && isTablet);
    // On tablet web paneActions floats absolutely at right: 12, while the
    // header's own right slot flows to the same edge — anything the overlay
    // publishes there (Save, the edit/preview toggle, the close button) would
    // otherwise sit underneath those glyphs. Reserve their width so the two
    // groups read as one row instead of overlapping.
    const PANE_ACTION_SIZE = 36;
    const PANE_ACTION_GAP = 8;
    const paneActionCount = (windowWidth >= 900 ? 1 : 0) + (canShowSidebar && !zenMode ? 1 : 0);
    const floatingPaneActionsWidth = isTablet && Platform.OS === 'web' && paneActionCount > 0
        ? paneActionCount * PANE_ACTION_SIZE + paneActionCount * PANE_ACTION_GAP
        : 0;
    const paneActions = (
        <>
            {windowWidth >= 900 && (
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={chatWideMode ? t('lmc.common.standardWidth') : t('lmc.common.wideMode')}
                    accessibilityState={{ selected: chatWideMode }}
                    onPress={() => storage.getState().applyLocalSettings({ chatWideMode: !chatWideMode })}
                    style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.55 : 1 })}
                >
                    <SidebarIcon name={chatWideMode ? 'contract-outline' : 'expand-outline'} size={20} color={theme.colors.header.tint} />
                </Pressable>
            )}
            {canShowSidebar && !zenMode && (
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={showSidebar ? t('lmc.common.closeResources') : t('lmc.common.openResources')}
                    accessibilityState={{ expanded: showSidebar }}
                    onPress={() => setSidebarExpanded(value => !value)}
                    style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.55 : 1 })}
                >
                    <SidebarIcon name="folder-outline" size={20} color={showSidebar ? theme.colors.radio.active : theme.colors.header.tint} />
                </Pressable>
            )}
        </>
    );
    const chatColumnWidth = chatWideMode && windowWidth >= 900 ? CHAT_WIDE_WIDTH : sessionColumnWidth;
    // Only worth putting a card beside the transcript when there is room beside
    // it: the card would otherwise sit on top of the text it reports about. The
    // pane is the window minus the desktop sidebar, which zen mode hides.
    const paneWidth = windowWidth - (isTablet && Platform.OS === 'web' && !zenMode ? DESKTOP_SIDEBAR_WIDTH : 0);
    const gutter = (paneWidth - sessionColumnWidth) / 2;
    const paneHasGutter = isTablet && Platform.OS === 'web' && !chatWideMode
        && gutter >= STATUS_CARD_MIN_WIDTH + STATUS_CARD_INSET * 2;
    // As wide as the gutter allows, so the message wraps less and the card can
    // stand at the height of the sidebar card beside it.
    const statusCardWidth = Math.min(STATUS_CARD_MAX_WIDTH, gutter - STATUS_CARD_INSET * 2);
    const mainContent = (
        <ChatWidthContext.Provider value={chatColumnWidth}>
            <MobileGlassBackdrop enabled={deviceType === 'phone' && Platform.OS !== 'web'} />
            {/* Status bar shadow for landscape mode */}
            {isLandscape && deviceType === 'phone' && (
                <View style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: safeArea.top,
                    backgroundColor: theme.colors.surface,
                    zIndex: 1000,
                    shadowColor: theme.colors.shadow.color,
                    shadowOffset: {
                        width: 0,
                        height: 2,
                    },
                    shadowOpacity: theme.colors.shadow.opacity,
                    shadowRadius: 3,
                    elevation: 5,
                }} />
            )}

            {/* Content based on state */}
            <View
                style={{
                    flex: 1,
                    paddingTop: !(isLandscape && deviceType === 'phone' && Platform.OS !== 'web')
                        ? contentRunsUnderHeader
                            ? 0
                            : safeArea.top + mobileHeaderHeight + (!isTablet && realtimeStatus !== 'disconnected' ? VOICE_PILL_TOTAL_HEIGHT : 0)
                        : 0,
                }}
            >
                {!isDataReady ? (
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                ) : !session ? (
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <Ionicons name="trash-outline" size={48} color={theme.colors.textSecondary} />
                        <Text style={{ color: theme.colors.text, fontSize: 20, marginTop: 16, fontWeight: '600' }}>{t('errors.sessionDeleted')}</Text>
                        <Text style={{ color: theme.colors.textSecondary, fontSize: 15, marginTop: 8, textAlign: 'center', paddingHorizontal: 32 }}>{t('errors.sessionDeletedDescription')}</Text>
                    </View>
                ) : (
                    <SessionViewLoaded
                        key={sessionId}
                        sessionId={sessionId}
                        session={session}
                        onHeaderBackdropVisibilityChange={contentRunsUnderHeader && Platform.OS !== 'web'
                            ? setHeaderBackdropVisible
                            : undefined}
                    />
                )}
            </View>

            {fileViewPath && !canShowSidebar && (
                <SessionToolOverlay
                    sessionId={sessionId}
                    filePath={fileViewPath}
                    top={safeArea.top + mobileHeaderHeight + 8}
                    onClose={closeOverlay}
                />
            )}
            {toolOverlayMessageId && (
                <SessionToolOverlay
                    sessionId={sessionId}
                    messageId={toolOverlayMessageId}
                    top={safeArea.top + mobileHeaderHeight + 8}
                    onClose={closeOverlay}
                />
            )}

            {/* Status cards sit in the pane's top-left corner on desktop, on the
                same top line and the same 8pt inset as the sidebar's own cards,
                and the same width — so the two sides read as one row rather than
                two floating boxes. A phone has no gutter, so they stay under the
                header and span the column there. */}
            {session && (
                <View
                    pointerEvents="box-none"
                    style={{
                        position: 'absolute',
                        zIndex: 90,
                        gap: 8,
                        ...(paneHasGutter
                            // Flush to the pane edge on purpose: the sidebar's
                            // own 8pt padding already sits to the left of it, so
                            // the visible gap between the two cards matches the
                            // 8pt the sidebar puts between its own.
                            ? { top: safeArea.top + STATUS_CARD_INSET, left: 0, width: statusCardWidth }
                            : {
                                top: safeArea.top + mobileHeaderHeight + 8,
                                left: 0,
                                right: 0,
                                alignItems: 'center',
                                paddingHorizontal: chatColumnWidth === CHAT_WIDE_WIDTH ? 0 : 12,
                            }),
                    }}
                >
                    <EngineAuthBanner
                        sessionId={sessionId}
                        maxWidth={paneHasGutter ? statusCardWidth : chatColumnWidth}
                        minHeight={paneHasGutter ? sidebarCardHeight : undefined}
                    />
                    <SessionRefreshBanner
                        sessionId={sessionId}
                        maxWidth={paneHasGutter ? statusCardWidth : chatColumnWidth}
                        minHeight={paneHasGutter ? sidebarCardHeight : undefined}
                    />
                </View>
            )}

            {isTablet && Platform.OS === 'web' && (
                <View
                    pointerEvents="box-none"
                    style={{ position: 'absolute', top: safeArea.top + 6, right: 12, zIndex: 1001, flexDirection: 'row', alignItems: 'center', gap: 8 }}
                >
                    {paneActions}
                </View>
            )}
            {/* Render the overlay header after the dynamic list so native blur samples its content. */}
            {!(isLandscape && deviceType === 'phone' && Platform.OS !== 'web') && (
                <View style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    zIndex: 1000
                }}>
                    {Platform.OS === 'web' && (
                        <LinearGradient
                            pointerEvents="none"
                            // Mirrors the dock's gradient at the bottom of the
                            // pane, so the transcript leaves the page the same
                            // way at both ends. Match the web chat surface:
                            // a black wash over #212121 creates a dark band
                            // with a hard seam against the sidebar.
                            colors={theme.dark
                                ? ['rgba(33,33,33,0.66)', 'rgba(33,33,33,0.20)', 'rgba(33,33,33,0)']
                                : ['rgba(255,255,255,0.74)', 'rgba(255,255,255,0.18)', 'rgba(255,255,255,0)']}
                            locations={[0, 0.58, 1]}
                            style={{ position: 'absolute', top: 0, left: 0, right: 0, height: safeArea.top + (isTablet ? DESKTOP_HEADER_HEIGHT : headerHeight) + 24 }}
                        />
                    )}
                    <ChatHeaderView
                        title={headerReady && showsSessionHeader ? headerProps.title : ''}
                        folderName={headerProps.folderName}
                        isConnected={headerProps.isConnected}
                        backdropVisible={headerBackdropVisible}
                        extraPathSegment={fileViewPath ?? undefined}
                        rightSlot={
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: floatingPaneActionsWidth }}>
                                {(diffViewOpen || !!fileViewPath) ? headerRightSlot : headerRight}
                                {/* The overlay replaces the header's own actions, and on
                                    tablet ChatHeaderView renders no back button — without
                                    this the only exit is the sidebar chevron, which sits
                                    far from the content being closed. */}
                                {(diffViewOpen || !!fileViewPath) && (
                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel={t('lmc.common.close')}
                                        onPress={closeOverlay}
                                        hitSlop={10}
                                        style={({ pressed }) => ({
                                            width: 32,
                                            height: 32,
                                            borderRadius: 10,
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent',
                                        })}
                                    >
                                        <Ionicons name="close" size={18} color={theme.colors.header.tint} />
                                    </Pressable>
                                )}
                                {!isTablet && paneActions}
                            </View>
                        }
                        onTitlePress={session ? () => router.push(`/session/${sessionId}/info`) : undefined}
                        onBackPress={() => router.back()}
                        onMenuPress={Platform.OS === 'web' && !isTablet ? openSessionDrawer : undefined}
                    />
                    {/* Voice status bar below header - not on tablet (shown in sidebar) */}
                    {!isTablet && realtimeStatus !== 'disconnected' && (
                        <VoiceAssistantStatusBar variant="full" />
                    )}
                </View>
            )}
        </ChatWidthContext.Provider>
    );

    if (!canShowSidebar) {
        return mainContent;
    }

    // Desktop layout: chat + animated sidebar at the same level (full height).
    // When a sidebar file is selected, InlineFileDiff overlays the main content
    // (chat stays mounted underneath so state is preserved).
    return (
        <View style={{ flex: 1, flexDirection: 'row' }}>
            <View
                style={{
                    flex: 1,
                    // Web-only: isolate the chat subtree's layout from the
                    // parent flex-row. If we ever bring back a width
                    // animation on the right sidebar, `contain` prevents
                    // layout work from leaking up to the chat tree on
                    // every frame.
                    ...(Platform.OS === 'web' ? { contain: 'layout style paint' as any } : {}),
                }}
            >
                {mainContent}
                {diffViewOpen && canShowSidebar && (
                    <View
                        pointerEvents="box-none"
                        style={{
                            position: 'absolute',
                            top: safeArea.top + mobileHeaderHeight,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            backgroundColor: theme.colors.surface,
                        }}
                    >
                        <AllFilesDiffView
                            sessionId={sessionId}
                            scrollToFile={scrollToFile}
                            onHeaderRightSlotChange={setHeaderRightSlot}
                        />
                    </View>
                )}
                {fileViewPath && canShowSidebar && (
                    <View
                        pointerEvents="box-none"
                        style={{
                            position: 'absolute',
                            top: safeArea.top + mobileHeaderHeight,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            backgroundColor: theme.colors.surface,
                        }}
                    >
                        <FileViewPanel
                            sessionId={sessionId}
                            filePath={fileViewPath}
                            onHeaderRightSlotChange={setHeaderRightSlot}
                        />
                    </View>
                )}
            </View>
            <Animated.View {...(Platform.OS === 'web' ? {dataSet:{lmcResourceWindow:showSidebar?'open':'closed'}} : {})} pointerEvents={showSidebar ? 'auto' : 'none'} accessibilityElementsHidden={!showSidebar} importantForAccessibility={showSidebar ? 'auto' : 'no-hide-descendants'} style={{ position: 'absolute', right: 16, top: safeArea.top + mobileHeaderHeight + 12, width: sidebarWidth, height: Math.min(760, Math.max(280, windowHeight - 150)), maxHeight: '86%', ...(Platform.OS === 'web' ? { opacity: showSidebar ? 1 : 0, visibility: showSidebar ? 'visible' : 'hidden', transform: [{translateY:showSidebar?0:-8},{scale:showSidebar?1:.98}], transformOrigin: 'top right' } as any : {display: showSidebar ? 'flex' : 'none'}), borderRadius: 16, backgroundColor: theme.colors.surface, ...lmcSurfaceBorder(theme), ...lmcElevation(theme, 3), overflow: 'hidden', zIndex: 100 }}>
                <View style={{padding: 12, flexDirection: 'row', alignItems: 'center', gap: 8}}>
                    {resourceBrowser && <Pressable accessibilityLabel={t('lmc.common.backToResources')} onPress={() => setResourceBrowser(false)}><SidebarIcon name="chevron-back" size={20} color={theme.colors.text}/></Pressable>}
                    <Text style={{flex:1,fontSize:15,fontWeight:'600',color:theme.colors.text}}>{resourceBrowser ? t('lmc.common.projectFiles') : t('lmc.common.resources')}</Text>
                    <Pressable accessibilityRole="button" accessibilityLabel={t('lmc.common.closeResources')} onPress={() => setSidebarExpanded(false)} style={{padding:6}}><SidebarIcon name="close" size={20} color={theme.colors.textSecondary}/></Pressable>
                </View>
                {!resourceBrowser ? <SessionResourceWindow key={sessionId} active={showSidebar} sessionId={sessionId} onOpen={(path) => { setSidebarExpanded(false); handleAllFilesFilePress(path); }} onBrowse={() => { openSidebarPanel('allFiles'); setResourceBrowser(true); }} /> : (
                <View style={{ width: sidebarWidth, flex: 1 }}>
                    <FilesSidebar
                        sessionId={sessionId}
                        selectedPath={sidebarPanelActive === 'changes' ? scrollToFile : sidebarPanelActive === 'allFiles' ? fileViewPath : null}
                        onFilePress={handleSidebarFilePress}
                        openPanels={sidebarPanelsOpen}
                        activePanel={sidebarPanelActive}
                        onOpenPanel={openSidebarPanel}
                        onSelectPanel={selectSidebarPanel}
                        onClosePanel={closeSidebarPanel}
                        onAllFilesFilePress={handleAllFilesFilePress}
                        sideChats={sideChats}
                        activeSideChatId={activeSideChatId}
                        onSelectSideChat={setActiveSideChatId}
                        onCloseSideChat={closeSideChat}
                        onCreateSideChat={createSideChat}
                        canCreateSideChat={!!sideChatForkSource}
                        creatingSideChat={creatingSideChat}
                    />
                </View>
                )}
            </Animated.View>
        </View>
    );
});

const SIDEBAR_MIN_WINDOW_WIDTH = 320;

// Hoisted so AgentInput's React.memo doesn't see a new array ref on every keystroke
const AGENT_INPUT_AUTOCOMPLETE_PREFIXES = ['@', '/'];

// Imperative handle exposed by ChatComposer so SessionViewLoaded can read /
// clear the message text without subscribing to it (which would re-render
// the whole loaded screen on every keystroke).
type ChatComposerHandle = {
    getMessage: () => string;
    clearMessage: () => void;
};

type ChatComposerProps = Omit<
    React.ComponentProps<typeof AgentInput>,
    'initialValue' | 'onChangeText'
> & {
    sessionId: string;
    composerHandleRef: React.RefObject<ChatComposerHandle | null>;
};

// Owns the chat-message draft autosave. The textarea itself is uncontrolled:
// keystrokes never round-trip through React state, so the parent can stay
// stable on every keystroke and deletion doesn't batch on a busy main thread.
// `message` here is a low-priority mirror updated via startTransition; it's
// only used to feed useDraft's debounced autosave. Reads/clears on send go
// through the MultiTextInput handle imperatively.
const ChatComposer = React.memo(function ChatComposer(props: ChatComposerProps) {
    const { sessionId, composerHandleRef, ...rest } = props;
    // Synchronously hydrate the textarea with any saved draft so the user sees
    // their work-in-progress on session open without an extra round-trip.
    const initialDraft = React.useMemo(() => {
        return storage.getState().sessions[sessionId]?.draft ?? '';
    }, [sessionId]);
    const inputHandleRef = React.useRef<MultiTextInputHandle>(null);
    const [message, setMessage] = React.useState(initialDraft);

    const applyDraft = React.useCallback((text: string) => {
        inputHandleRef.current?.setTextAndSelection(text, { start: text.length, end: text.length });
        setMessage(text);
    }, []);

    const { clearDraft } = useDraft(sessionId, message, applyDraft);

    const handleChangeText = React.useCallback((text: string) => {
        // Transition keeps the textarea responsive even when the draft
        // autosave / re-render takes longer than a frame.
        React.startTransition(() => setMessage(text));
    }, []);

    React.useImperativeHandle(composerHandleRef, () => ({
        getMessage: () => inputHandleRef.current?.getText() ?? '',
        clearMessage: () => {
            inputHandleRef.current?.setTextAndSelection('', { start: 0, end: 0 });
            setMessage('');
            clearDraft();
        },
    }), [clearDraft]);

    return (
        <AgentInput
            {...rest}
            ref={inputHandleRef}
            sessionId={sessionId}
            initialValue={initialDraft}
            onChangeText={handleChangeText}
        />
    );
});

export function SessionViewLoaded({
    sessionId,
    session,
    embedded = false,
    onHeaderBackdropVisibilityChange,
}: {
    sessionId: string;
    session: Session;
    embedded?: boolean;
    onHeaderBackdropVisibilityChange?: (visible: boolean) => void;
}) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const isTablet = useIsTablet();
    const { width: inputWindowWidth } = useWindowDimensions();
    // Only the portrait phone chat uses an overlay dock. Tablet, desktop,
    // landscape, and embedded views retain their existing split layout.
    // The composer floats over the transcript, which scrolls beneath it and
    // fades out under the dock. Web gets it at every width; native keeps it to
    // the portrait phone, where the split layout fought the keyboard.
    const usesFloatingMobileDock = !embedded
        && (Platform.OS === 'web'
            || (deviceType === 'phone' && !isRunningOnMac() && !isLandscape));
    const [bottomDockInset, setBottomDockInset] = React.useState(0);
    const [composerY, setComposerY] = React.useState(0);
    // Offset of the composer card inside AgentInput — the faded status rows
    // above it keep their space, so anchoring to the dock top floats the
    // scroll button over a visually empty band.
    const [composerCardOffset, setComposerCardOffset] = React.useState(0);
    const [composerBottomSpacing, setComposerBottomSpacing] = React.useState<number | null>(null);
    useFocusEffect(React.useCallback(() => {
        if (embedded || !usesFloatingMobileDock || composerBottomSpacing === null) return;
        const composer = { sessionId, bottomSpacing: composerBottomSpacing };
        useSessionDrawer.setState({ composer });
        return () => {
            // A previously focused screen must not clear a newer chat's anchor.
            if (useSessionDrawer.getState().composer === composer) {
                useSessionDrawer.setState({ composer: null });
            }
        };
    }, [embedded, usesFloatingMobileDock, sessionId, composerBottomSpacing]));
    const [isChatAtBottom, setIsChatAtBottom] = React.useState(true);
    const showBottomDockDetails = !usesFloatingMobileDock || isChatAtBottom || isTablet;
    const scrollButtonInset = Math.max(0, bottomDockInset - composerY - composerCardOffset);

    const handleBottomDockInsetChange = React.useCallback((nextInset: number) => {
        setBottomDockInset((currentInset) => (
            Math.abs(currentInset - nextInset) < 1 ? currentInset : nextInset
        ));
    }, []);
    const handleComposerLayout = React.useCallback((event: LayoutChangeEvent) => {
        const nextY = Math.ceil(event.nativeEvent.layout.y);
        setComposerY((currentY) => (
            Math.abs(currentY - nextY) < 1 ? currentY : nextY
        ));
    }, []);
    const handleComposerCardOffsetChange = React.useCallback((offset: number) => {
        const nextOffset = Math.ceil(offset);
        setComposerCardOffset((currentOffset) => (
            Math.abs(currentOffset - nextOffset) < 1 ? currentOffset : nextOffset
        ));
    }, []);
    const handleChatBottomVisibilityChange = React.useCallback((visible: boolean) => {
        setIsChatAtBottom(visible);
    }, []);

    React.useEffect(() => {
        if (!usesFloatingMobileDock) {
            setBottomDockInset(0);
            setComposerY(0);
        }
    }, [usesFloatingMobileDock]);

    React.useEffect(() => {
        setIsChatAtBottom(true);
    }, [sessionId, usesFloatingMobileDock]);

    const realtimeStatus = useRealtimeStatus();
    const { messages, isLoaded } = useSessionMessages(sessionId);
    const pendingCommunications = useSessionPendingCommunications(sessionId);
    const acknowledgedCliVersions = useLocalSetting('acknowledgedCliVersions');
    const zenMode = useLocalSetting('zenMode');
    // Match AgentInput's viewport breakpoint, including a narrow web browser.
    const sessionInputHorizontalPadding = inputWindowWidth > 700 ? 12 : 8;
    const chatListTopContentInset = embedded || (isLandscape && deviceType === 'phone')
        ? 12
        // Web: clear the top bar (or the floating pills on a phone), plus air.
        : Platform.OS === 'web'
        ? safeArea.top + (isTablet ? DESKTOP_HEADER_HEIGHT + 4 : headerHeight + 16)
        : deviceType === 'phone'
            ? safeArea.top
                + MOBILE_GLASS_HEADER_HEIGHT
                + (realtimeStatus !== 'disconnected' ? VOICE_PILL_TOTAL_HEIGHT : 0)
                + 12
            : undefined;

    // Check if CLI version is outdated and not already acknowledged
    const cliVersion = session.metadata?.version;
    const machineId = session.metadata?.machineId;
    const catalogMachine = useMachine(machineId ?? '');
    const catalogMetadata = React.useMemo(() => withModelCatalogs(session.metadata, catalogMachine?.metadata), [session.metadata, catalogMachine?.metadata]);
    const isCliOutdated = cliVersion && !isVersionSupported(cliVersion, MINIMUM_CLI_VERSION);
    const isAcknowledged = machineId && acknowledgedCliVersions[machineId] === cliVersion;
    const shouldShowCliWarning = isCliOutdated && !isAcknowledged;
    const flavor = session.metadata?.flavor;
    const isRig = isRigMetadata(session.metadata);
    // Only a live session on a switchable engine whose Agent can refresh itself:
    // anything else would offer a switch no runner is able to carry out.
    const canSwitchEngine = !isRig
        && isSwitchableEngine(session.metadata?.flavor)
        && sessionCapabilities(session.metadata).refresh;
    const agentDefaultOverrides = useSetting('agentDefaultOverrides');
    const effectiveAgentDefaults = React.useMemo(() => (
        resolveAgentDefaultConfig(agentDefaultOverrides, flavor, cliVersion)
    ), [agentDefaultOverrides, cliVersion, flavor]);
    const availableModels = React.useMemo(() => (
        getAvailableModels(
            flavor,
            catalogMetadata,
            t,
            session.modelMode ?? (isRig ? null : effectiveAgentDefaults.modelMode),
        )
    ), [flavor, catalogMetadata, session.modelMode, effectiveAgentDefaults.modelMode, isRig]);
    const availableModes = React.useMemo(() => (
        getAvailablePermissionModes(flavor, session.metadata, t, session.permissionMode)
    ), [flavor, session.metadata, session.permissionMode]);

    const permissionMode = React.useMemo<PermissionMode | null>(() => (
        resolveCurrentOption(availableModes, [
            session.permissionMode,
            ...(isRig ? [
                session.metadata?.currentOperatingModeCode,
                session.metadata?.permissionMode,
                session.metadata?.session?.permissionMode,
            ] : [
                effectiveAgentDefaults.permissionMode,
                session.metadata?.currentOperatingModeCode,
            ]),
        ])
    ), [availableModes, session.permissionMode, effectiveAgentDefaults.permissionMode, session.metadata?.currentOperatingModeCode, session.metadata?.permissionMode, session.metadata?.session?.permissionMode, isRig]);

    const modelMode = React.useMemo<ModelMode | null>(() => (
        resolveCurrentOption(availableModels, [
            session.modelMode,
            isRig ? getRigCurrentModelOptionKey(session.metadata) : effectiveAgentDefaults.modelMode,
            isRig ? undefined : session.metadata?.currentModelCode,
        ])
    ), [availableModels, session.modelMode, effectiveAgentDefaults.modelMode, session.metadata, isRig]);

    // Effort level state
    const modelKey = modelMode?.key ?? 'default';
    const availableEffortLevels = React.useMemo<EffortLevel[]>(() => (
        getEffortLevelsForModel(flavor, modelKey, catalogMetadata, t)
    ), [flavor, modelKey, catalogMetadata]);
    const catalogEffortDefault = getCatalogDefaultEffort(flavor, modelKey, catalogMetadata, effectiveAgentDefaults.effortLevel);
    const effortLevel = React.useMemo<EffortLevel | null>(() => (
        preserveCodexEffortSelection(
            isRig ? 'rig' : flavor,
            session.effortLevel ?? (isRig ? null : catalogEffortDefault),
            resolveCurrentOption(availableEffortLevels, [
                session.effortLevel,
                isRig ? getRigReasoningSelection(session.metadata, modelKey) : catalogEffortDefault,
            ]),
        )
    ), [flavor, availableEffortLevels, session.effortLevel, catalogEffortDefault, session.metadata, modelKey, isRig]);

    const sessionStatus = useSessionStatus(session);
    const sessionUsage = useSessionUsage(sessionId);
    const gitStatus = useSessionGitStatus(sessionId);
    const alwaysShowContextSize = useSetting('alwaysShowContextSize');
    const experiments = useSetting('experiments');
    const { canResume, resumeSession, resumingSession } = useSessionQuickActions(session);
    const isDisconnected = !sessionStatus.isConnected;
    const resumeCommandBlock = getResumeCommandBlock(session);

    // Attachment availability is capability-driven by the active session.
    const { selectedImages, pickImages, pickFiles, removeImage, clearImages, addImages } = useImagePicker();

    const canUseAttachments = isRigMetadataV1(session.metadata)
        ? rigCanUseAttachments(session.metadata)
        : supportsImageAttachmentsForFlavor(session.metadata?.flavor);
    const canSendFilesResolved = canUseAttachments && session.metadata?.sessionCapabilities?.fileInbox === true;
    React.useEffect(() => {
        if (!canUseAttachments && selectedImages.length > 0) {
            clearImages();
        }
    }, [canUseAttachments, selectedImages.length, clearImages]);

    // ChatComposer owns the message state + useDraft subscription. We only
    // hold an imperative handle so handleSend can read the live text and
    // clear it without subscribing to it (which would re-render the whole
    // SessionViewLoaded tree on every keystroke).
    const composerHandleRef = React.useRef<ChatComposerHandle | null>(null);

    // Handle dismissing CLI version warning
    const handleDismissCliWarning = React.useCallback(() => {
        if (machineId && cliVersion) {
            storage.getState().applyLocalSettings({
                acknowledgedCliVersions: {
                    ...acknowledgedCliVersions,
                    [machineId]: cliVersion
                }
            });
        }
    }, [machineId, cliVersion, acknowledgedCliVersions]);

    // Function to update permission mode
    const updatePermissionMode = React.useCallback((mode: PermissionMode) => {
        sessionSetAgentModes(sessionId, { permissionMode: mode.key });
    }, [sessionId]);

    const updateModelMode = React.useCallback((mode: ModelMode) => {
        const nextEffortLevels = getEffortLevelsForModel(flavor, mode.key, catalogMetadata, t);
        const currentEffortSupported = session.effortLevel
            ? nextEffortLevels.some((level) => level.key === session.effortLevel)
            : true;
        sessionSetAgentModes(sessionId, {
            modelMode: mode.key,
            ...((isRig || flavor !== 'codex' || nextEffortLevels.length === 0) && !currentEffortSupported ? { effortLevel: mode.defaultThinkingLevel ?? null } : {}),
        });
    }, [sessionId, flavor, isRig, catalogMetadata, session.effortLevel]);

    const updateEffortLevel = React.useCallback((level: EffortLevel) => {
        sessionSetAgentModes(sessionId, { effortLevel: level.key });
    }, [sessionId]);

    /**
     * Picking a model that belongs to the other engine.
     *
     * Confirmed before anything is sent, because a row in a model list looks
     * like a setting and this one restarts the session on a different engine
     * with none of the current one's memory. The body says all three things it
     * costs; the title says only which engine, so it stays readable.
     */
    // A model picked together with an engine lands when that engine does, not
    // when it was asked for — the session runs on the old one until the relaunch.
    React.useEffect(() => {
        applyPendingEngineModel(sessionId, session.metadata?.flavor);
    }, [sessionId, session.metadata?.flavor]);

    const switchEngine = React.useCallback((engine: SwitchableEngine, model: ModelMode) => {
        void (async () => {
            const name = ENGINE_NAMES[engine];
            const confirmed = await Modal.confirm(
                t('lmc.engineSwitch.confirmTitle', { engine: name }),
                t('lmc.engineSwitch.confirmBodyWithModel', { engine: name, model: model.name }),
                { cancelText: t('common.cancel'), confirmText: t('lmc.engineSwitch.confirmAction') },
            );
            if (!confirmed) return;
            try {
                await switchSessionEngine(sessionId, engine, model.key, permissionMode?.key ?? null);
            } catch (error) {
                Modal.alert(t('lmc.engineSwitch.failed'), error instanceof Error ? error.message : String(error));
            }
        })();
    }, [sessionId, permissionMode?.key]);

    // Memoize header-dependent styles to prevent re-renders
    const headerDependentStyles = React.useMemo(() => ({
        contentContainer: {
            flex: 1
        },
        flatListStyle: {
            marginTop: 0 // No marginTop needed since header is handled by parent
        },
    }), []);

    // sendComposer reads the live message via the composer ref, so it doesn't
    // need to re-create on every keystroke. `intent` says what a busy engine
    // should do with the message; see sync/turnQueue.ts.
    const sendComposer = React.useCallback((intent?: MessageIntent) => {
        const liveMessage = composerHandleRef.current?.getMessage() ?? '';
        if (liveMessage.trim() || selectedImages.length > 0) {
            try {
                resolveMessageModeMeta(session, storage.getState().settings, storage.getState().machines[session.metadata?.machineId ?? '']?.metadata);
            } catch (error) {
                if (error instanceof UnsupportedCodexEffortError || error instanceof UnsupportedPermissionModeError) {
                    Modal.alert(t('common.error'), error instanceof UnsupportedCodexEffortError ? error.localizedMessage(t) : error.message);
                    return; // Keep draft, attachments and unanswered forms intact.
                }
                throw error;
            }
            const attachments = selectedImages.length > 0 ? selectedImages : undefined;
            const communicationsToDismiss = [...pendingCommunications];
            composerHandleRef.current?.clearMessage();
            clearImages();

            void (async () => {
                try {
                    // Deliver the user's message while the question tool is still
                    // blocked, then dismiss the forms. This keeps the regular text
                    // available as the user's custom response before the agent is
                    // allowed to continue its turn.
                    await sync.sendMessage(sessionId, liveMessage, {
                        source: 'chat',
                        attachments,
                        awaitDelivery: communicationsToDismiss.length > 0,
                        intent,
                    });
                    const dismissals = await Promise.allSettled(communicationsToDismiss.map(communication => (
                        sessionCancelCommunication(sessionId, communication.id, communication.kind)
                    )));
                    for (const dismissal of dismissals) {
                        if (dismissal.status === 'rejected') {
                            console.error('Failed to dismiss an agent question:', dismissal.reason);
                        }
                    }
                } catch (error) {
                    console.error('Failed to send message while dismissing agent questions:', error);
                }
            })();
        }
    }, [session, sessionId, selectedImages, clearImages, pendingCommunications]);

    // Plain Send while the engine works is an explicit 'queue' so a CLI that
    // knows intents never steers it on its own; idle sends carry none.
    const queueSupported = sessionSupportsTurnQueue(session.metadata);
    const handleSend = React.useCallback(() => {
        sendComposer(queueSupported && session.thinking ? 'queue' : undefined);
    }, [queueSupported, sendComposer, session.thinking]);
    const handleQueueWithdraw = React.useCallback((key: string) => {
        sessionDequeue(sessionId, key).then((removed) => {
            if (!removed) Modal.alert(t('lmc.queue.withdrawTooLate'));
        }).catch((error) => { console.error('dequeue failed:', error); });
    }, [sessionId]);
    const handleQueuePromote = React.useCallback((key: string) => {
        sessionPromoteQueued(sessionId, key).then((result) => {
            if (!result.promoted) Modal.alert(t('lmc.queue.promoteTooLate'));
        }).catch((error) => { console.error('promote failed:', error); });
    }, [sessionId]);
    const handleQueueSteer = React.useCallback((key: string) => {
        sessionSteerQueued(sessionId, key).then((result) => {
            // A refusal is not a failure: the prompt is still queued, and the
            // runner said which condition stopped it.
            if (!result.steered) Modal.alert(t(steerFailureKey(result.reason)));
        }).catch((error) => { console.error('steer failed:', error); });
    }, [sessionId]);
    const handleQueueModeChange = React.useCallback((mode: QueueMode) => {
        sessionSetQueueMode(sessionId, mode).catch((error) => { console.error('queue mode change failed:', error); });
    }, [sessionId]);
    const queuedPrompts = React.useMemo(() => pendingQueuePrompts(messages, session.agentState?.queue), [messages, session.agentState?.queue]);
    const queueMode: QueueMode = session.metadata?.queueMode ?? 'batch';
    // Handed over whenever the session can queue at all; the strip shows
    // nothing until something is actually waiting.
    const queueProps = React.useMemo(() => (
        queueSupported
            ? {
                items: queuedPrompts ?? [],
                mode: queueMode,
                steerState: queueSteerState(session.metadata),
                onSteer: handleQueueSteer,
                onPromote: handleQueuePromote,
                onWithdraw: handleQueueWithdraw,
                onModeChange: handleQueueModeChange,
            }
            : undefined
    ), [queueSupported, queuedPrompts, queueMode, session.metadata, handleQueueSteer, handleQueueWithdraw, handleQueuePromote, handleQueueModeChange]);

    const handleAbort = React.useCallback(() => {
        // Stop cancels only the active turn. Permission, model, and effort are
        // session choices and must remain sticky for the next message.
        sessionAbort(sessionId);
    }, [sessionId]);

    const handleFileViewerPress = React.useCallback(() => {
        router.push(`/session/${sessionId}/files`);
    }, [router, sessionId]);

    const handleAutocompleteSuggestions = React.useCallback((query: string) => (
        getSuggestions(sessionId, query)
    ), [sessionId]);

    const connectionStatus = React.useMemo(() => ({
        text: sessionStatus.statusText,
        color: sessionStatus.statusColor,
        dotColor: sessionStatus.statusDotColor,
        isPulsing: sessionStatus.isPulsing,
    }), [sessionStatus.statusText, sessionStatus.statusColor, sessionStatus.statusDotColor, sessionStatus.isPulsing]);

    const turnElapsed = React.useMemo(() => resolveTurnElapsed(messages, session.turnLifecycle,
        session.active && (session.thinking || Object.keys(session.agentState?.requests ?? {}).length > 0)),
    [messages, session.turnLifecycle, session.active, session.thinking, session.agentState?.requests]);

    const usageData = React.useMemo(() => {
        const source = sessionUsage ?? session.latestUsage;
        if (!source) return undefined;
        return {
            inputTokens: source.inputTokens,
            outputTokens: source.outputTokens,
            cacheCreation: source.cacheCreation,
            cacheRead: source.cacheRead,
            contextSize: source.contextSize,
            contextWindow: source.contextWindow,
        };
    }, [sessionUsage, session.latestUsage]);
    const metadataGitBranch = React.useMemo(() => {
        const gitBranch = (session.metadata as { gitBranch?: unknown } | null)?.gitBranch;
        return typeof gitBranch === 'string' && gitBranch.trim() ? gitBranch.trim() : null;
    }, [session.metadata]);
    const statusBarGitBranch = resolveStatusBarGitBranch(gitStatus?.branch, metadataGitBranch);
    // Same source and fallback chain as the session list rows.
    const statusBarGitChanges = React.useMemo(() => {
        const liveInsertions = gitStatus?.unstagedLinesAdded ?? 0;
        const liveDeletions = gitStatus?.unstagedLinesRemoved ?? 0;
        if (liveInsertions > 0 || liveDeletions > 0) {
            return { approximate: false, insertions: liveInsertions, deletions: liveDeletions };
        }
        const rigGit = getRigGitSummary(session.metadata);
        if (rigGit && rigGit.changedFiles !== null) {
            return visibleRigGitLineChanges({
                changedFiles: rigGit.changedFiles,
                countsExact: rigGit.countsExact ?? true,
                deletions: rigGit.deletions ?? 0,
                insertions: rigGit.insertions ?? 0,
            });
        }
        return null;
    }, [gitStatus?.unstagedLinesAdded, gitStatus?.unstagedLinesRemoved, session.metadata]);

    const visibleAgentGoal = React.useMemo(() => (
        resolveVisibleAgentGoalStatus(session)
    ), [
        session.agentState?.agentGoalStatus,
        session.presence,
        session.metadata?.claudeSessionId,
        session.metadata?.codexThreadId,
    ]);
    const [goalActionInFlight, setGoalActionInFlight] = React.useState<AgentGoalAction | null>(null);
    const handleGoalAction = React.useCallback(async (action: AgentGoalAction) => {
        await performAgentGoalAction({
            action,
            currentGoalText: visibleAgentGoal?.text ?? '',
            promptEditGoal: (currentGoalText) => Modal.prompt(t('components.agentGoalBar.editGoal'), undefined, {
                placeholder: t('components.agentGoalBar.currentGoal'),
                defaultValue: currentGoalText,
                cancelText: t('common.cancel'),
                confirmText: t('common.save'),
            }),
            dispatchGoalAction: (nextAction, objective) => sessionGoalAction(sessionId, nextAction, objective),
            setInFlight: setGoalActionInFlight,
            onError: (error) => console.error('Failed to perform goal action', error),
        });
    }, [sessionId, visibleAgentGoal?.text]);

    // Trigger session visibility and initialize git status sync
    React.useLayoutEffect(() => {

        // Trigger session sync
        sync.onSessionVisible(sessionId);

        // Mark session as currently being viewed (clears unread). Skipped when
        // embedded (e.g. the side-chat panel) so a second mounted chat body
        // doesn't steal "currently viewing" from the primary session.
        if (!embedded) {
            storage.getState().setCurrentViewingSession(sessionId);
        }

        // Initialize git status sync for this session
        gitStatusSync.getSync(sessionId).invalidate();

        return () => {
            if (embedded) {
                return;
            }
            // Clear viewing session on unmount
            const current = storage.getState().currentViewingSessionId;
            if (current === sessionId) {
                storage.getState().setCurrentViewingSession(null);
            }
        };
    }, [sessionId, realtimeStatus, embedded]);

    let content = (
        <>
            <Deferred>
                {messages.length > 0 && (
                    <ChatList
                        session={session}
                        topContentInset={chatListTopContentInset}
                        bottomContentInset={usesFloatingMobileDock ? bottomDockInset : undefined}
                        scrollButtonInset={usesFloatingMobileDock ? scrollButtonInset : undefined}
                        headerOverlayHeight={safeArea.top + MOBILE_GLASS_HEADER_HEIGHT}
                        onHeaderBackdropVisibilityChange={onHeaderBackdropVisibilityChange}
                        onBottomDockVisibilityChange={usesFloatingMobileDock
                            ? handleChatBottomVisibilityChange
                            : undefined}
                    />
                )}
            </Deferred>
        </>
    );
    const placeholder = messages.length === 0 ? (
        <>
            {isLoaded ? (
                <EmptyMessages session={session} />
            ) : (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            )}
        </>
    ) : null;

    const composer = (
        <View onLayout={usesFloatingMobileDock ? handleComposerLayout : undefined}>
            <ChatComposer
                composerHandleRef={composerHandleRef}
                placeholder={t('session.inputPlaceholder')}
                sessionId={sessionId}
                permissionMode={permissionMode}
                onPermissionModeChange={isRigPermissionSelectionEnabled(session.metadata) ? updatePermissionMode : undefined}
                availableModes={availableModes}
                modelMode={modelMode}
                availableModels={availableModels}
                onModelModeChange={isRigModelSelectionEnabled(session.metadata) ? updateModelMode : undefined}
                effortLevel={effortLevel}
                availableEffortLevels={availableEffortLevels}
                onEffortLevelChange={isRigReasoningSelectionEnabled(session.metadata) ? updateEffortLevel : undefined}
                onEngineSwitch={canSwitchEngine ? switchEngine : undefined}
                metadata={catalogMetadata}
                connectionStatus={connectionStatus}
                blockSend={isRig && session.thinking && session.metadata?.capabilities?.steering !== true}
                onSend={handleSend}
                queue={queueProps}
                onAbort={isDisconnected || !rigCanAbort(session.metadata) ? undefined : handleAbort}
                showAbortButton={rigCanAbort(session.metadata) && (
                    sessionStatus.state === 'thinking'
                    // A pending selection or permission request parks the agent inside
                    // a tool call. Keep Stop reachable on every platform while either
                    // kind of user action is outstanding.
                    || sessionStatus.state === 'permission_required'
                    || sessionStatus.state === 'input_required'
                    || (Platform.OS === 'web' && sessionStatus.state === 'waiting')
                )}
                onFileViewerPress={experiments && !isTablet && rigCanBrowseFiles(session.metadata) && rigCanReadFiles(session.metadata) ? handleFileViewerPress : undefined}
                selectedImages={canUseAttachments ? selectedImages : undefined}
                onPickImages={canUseAttachments ? pickImages : undefined}
                onPickFiles={canSendFilesResolved ? pickFiles : undefined}
                onRemoveImage={canUseAttachments ? removeImage : undefined}
                onAddImages={canUseAttachments ? addImages : undefined}
                autocompletePrefixes={AGENT_INPUT_AUTOCOMPLETE_PREFIXES}
                autocompleteSuggestions={handleAutocompleteSuggestions}
                usageData={usageData}
                turnElapsed={turnElapsed}
                alwaysShowContextSize={alwaysShowContextSize}
                zenMode={zenMode}
                showStatusDetails={showBottomDockDetails}
                sessionStatusGitBranch={statusBarGitBranch ?? 'main'}
                sessionStatusGitChanges={statusBarGitChanges}
                agentWorking={sessionStatus.state === 'thinking'}
                onActionAreaOffsetChange={usesFloatingMobileDock ? handleComposerCardOffsetChange : undefined}
                onBottomSpacingChange={!embedded && usesFloatingMobileDock ? setComposerBottomSpacing : undefined}
            />
        </View>
    );

    // Disconnected sessions get the full Resume affordance regardless of
    // whether they were explicitly archived or just lost their CLI (e.g.
    // Ctrl-C in terminal — lifecycleState stays 'running', server flips
    // active=false). InactiveArchivedHint handles both cases: shows the
    // Resume button when canResume is true, falls back to the
    // copy-this-command hint when the daemon is incompatible or the machine
    // isn't reachable.
    // Between the old process leaving and the new one registering, the
    // session is disconnected — but it is being restarted, not dead, and a
    // Resume button there would start a second relaunch on top of the first.
    const relaunching = isRefreshPending(session.metadata?.sessionConfigState);
    const inactiveHint = isDisconnected && !isRig && !relaunching ? (
        <AnimatedFade visible={showBottomDockDetails}>
            <CenteredInputWidth horizontalPadding={sessionInputHorizontalPadding}>
                <InactiveArchivedHint
                    resumeCommandBlock={resumeCommandBlock}
                    canResume={canResume}
                    resuming={resumingSession}
                    onResume={resumeSession}
                />
            </CenteredInputWidth>
        </AnimatedFade>
    ) : null;

    const input = (
        <>
            {inactiveHint}
            {visibleAgentGoal && (
                <AnimatedFade visible={showBottomDockDetails}>
                    <CenteredInputWidth horizontalPadding={sessionInputHorizontalPadding}>
                        <AgentGoalBar
                            goal={visibleAgentGoal}
                            onAction={handleGoalAction}
                            inFlightAction={goalActionInFlight}
                        />
                    </CenteredInputWidth>
                </AnimatedFade>
            )}
            <AnimatedFade visible={showBottomDockDetails}>
                <CenteredInputWidth horizontalPadding={sessionInputHorizontalPadding}>
                    <AgentQuestionBanner sessionId={sessionId} />
                </CenteredInputWidth>
            </AnimatedFade>
            <AnimatedFade visible={showBottomDockDetails}>
                <RigActivityBar metadata={session.metadata} />
            </AnimatedFade>
            {composer}
        </>
    );


    return (
        <>
            {/* CLI Version Warning Overlay - Subtle centered pill */}
            {shouldShowCliWarning && !(isLandscape && deviceType === 'phone') && (
                <Pressable
                    onPress={handleDismissCliWarning}
                    style={{
                        position: 'absolute',
                        top: 8, // Position at top of content area (padding handled by parent)
                        alignSelf: 'center',
                        backgroundColor: '#FFF3CD',
                        borderRadius: 100, // Fully rounded pill
                        paddingHorizontal: 14,
                        paddingVertical: 7,
                        flexDirection: 'row',
                        alignItems: 'center',
                        zIndex: 998, // Below voice bar but above content
                        shadowColor: '#000',
                        shadowOffset: { width: 0, height: 2 },
                        shadowOpacity: 0.15,
                        shadowRadius: 4,
                        elevation: 4,
                    }}
                >
                    <Ionicons name="warning-outline" size={14} color="#FF9500" style={{ marginRight: 6 }} />
                    <Text style={{
                        fontSize: 12,
                        color: '#856404',
                        fontWeight: '600'
                    }}>
                        {t('sessionInfo.cliVersionOutdated')}
                    </Text>
                    <Ionicons name="close" size={14} color="#856404" style={{ marginLeft: 8 }} />
                </Pressable>
            )}

            {/* Main content area - no padding since header is overlay */}
            <View style={{
                flexBasis: 0,
                flexGrow: 1,
                // The floating chat content reaches the physical bottom of
                // the screen. AgentContentView keeps the dock itself above
                // the home indicator / navigation area.
                paddingBottom: usesFloatingMobileDock
                    ? 0
                    : safeArea.bottom + ((isRunningOnMac() || Platform.OS === 'web') ? 8 : 0),
            }}>
                <AgentContentView
                    content={content}
                    input={input}
                    placeholder={placeholder}
                    floatingDock={usesFloatingMobileDock}
                    onDockInsetChange={handleBottomDockInsetChange}
                />
            </View >

            {/* Back button for landscape phone mode when header is hidden */}
            {
                isLandscape && deviceType === 'phone' && (
                    <Pressable
                        onPress={() => router.back()}
                        style={{
                            position: 'absolute',
                            top: safeArea.top + 8,
                            left: 16,
                            width: 44,
                            height: 44,
                            borderRadius: 22,
                            backgroundColor: `rgba(${theme.dark ? '28, 23, 28' : '255, 255, 255'}, 0.9)`,
                            alignItems: 'center',
                            justifyContent: 'center',
                            ...Platform.select({
                                ios: {
                                    shadowColor: '#000',
                                    shadowOffset: { width: 0, height: 2 },
                                    shadowOpacity: 0.1,
                                    shadowRadius: 4,
                                },
                                android: {
                                    elevation: 2,
                                }
                            }),
                        }}
                        hitSlop={15}
                    >
                        <Ionicons
                            name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                            size={Platform.select({ ios: 28, default: 24 })}
                            color="#000"
                        />
                    </Pressable>
                )
            }
        </>
    )
}

function InactiveArchivedHint(props: {
    resumeCommandBlock: NonNullable<ReturnType<typeof getResumeCommandBlock>> | null;
    canResume: boolean;
    resuming: boolean;
    onResume: () => void;
}) {
    const { theme } = useUnistyles();
    const hintTextStyle = {
        color: theme.colors.agentEventText,
        fontSize: 13,
        lineHeight: 18,
        textAlign: 'left' as const,
    };

    return (
        <View style={{
            paddingTop: 12,
            paddingBottom: 10,
            gap: 10,
            alignItems: 'stretch',
        }}>
            <View style={{ paddingHorizontal: 8, gap: 4 }}>
                <Text style={hintTextStyle}>
                    {t('session.inactiveArchived')}
                </Text>
                {props.canResume ? null : props.resumeCommandBlock && (
                    <Text style={hintTextStyle}>
                        {t('session.resumeFromTerminal')}
                    </Text>
                )}
            </View>
            {props.canResume ? (
                <Pressable
                    onPress={props.onResume}
                    disabled={props.resuming}
                    style={({ pressed }) => ({
                        height: Platform.select({ web: 40, default: 44 }),
                        borderRadius: Platform.select({ web: 10, default: 18 }),
                        backgroundColor: Platform.select({
                            web: theme.colors.button.primary.background,
                            default: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh,
                        }),
                        borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
                        borderColor: theme.colors.divider,
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: props.resuming ? 0.6 : Platform.OS === 'web' && pressed ? 0.8 : 1,
                        marginHorizontal: 8,
                    })}
                >
                    {props.resuming ? (
                        <ActivityIndicator size="small" color={Platform.select({ web: theme.colors.button.primary.tint, default: theme.colors.text })} />
                    ) : (
                        <Text style={{ color: Platform.select({ web: theme.colors.button.primary.tint, default: theme.colors.text }), fontSize: 15, fontWeight: '600' }}>
                            {t('sessionInfo.resumeSession')}
                        </Text>
                    )}
                </Pressable>
            ) : props.resumeCommandBlock && (
                <ResumeCommandCopyBlock resumeCommandBlock={props.resumeCommandBlock} />
            )}
        </View>
    );
}

function ResumeCommandCopyBlock({ resumeCommandBlock }: {
    resumeCommandBlock: NonNullable<ReturnType<typeof getResumeCommandBlock>>;
}) {
    const { theme } = useUnistyles();
    const [copied, setCopied] = React.useState(false);

    return (
        <Pressable
            onPress={async () => {
                await Clipboard.setStringAsync(resumeCommandBlock.copyText);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            }}
            style={({ pressed }) => ({
                minHeight: 48,
                borderRadius: Platform.select({ web: 14, default: 18 }),
                backgroundColor: Platform.select({
                    web: theme.colors.surfaceHigh,
                    default: pressed ? theme.colors.surfacePressed : theme.colors.surface,
                }),
                borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
                borderColor: theme.colors.divider,
                flexDirection: 'row',
                gap: 8,
                paddingHorizontal: 16,
                paddingVertical: 12,
                alignItems: 'flex-start',
            })}
        >
            <View style={{ flex: 1 }}>
                {resumeCommandBlock.lines.map((line, index) => (
                    <Text
                        key={`${line}-${index}`}
                        style={{
                            color: theme.colors.text,
                            fontSize: 13,
                            lineHeight: 18,
                            fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                        }}
                    >
                        {line}
                    </Text>
                ))}
            </View>
            <Ionicons
                name={copied ? 'checkmark' : 'copy-outline'}
                size={16}
                color={copied ? '#30D158' : theme.colors.textSecondary}
                style={{ marginTop: 1 }}
            />
        </Pressable>
    );
}

function CenteredInputWidth(props: {
    children: React.ReactNode;
    horizontalPadding: number;
}) {
    const chatMaxWidth = useChatMaxWidth();
    // In wide mode there is no centring left to absorb this gutter, so it
    // would push the bars 12pt inside the transcript's own 16pt inset.
    const gutter = chatMaxWidth === CHAT_WIDE_WIDTH ? 0 : props.horizontalPadding;
    return (
        <View style={{
            width: '100%',
            paddingHorizontal: gutter,
            alignItems: 'center',
        }}>
            <View style={{
                width: '100%',
                maxWidth: chatMaxWidth,
                // Messages, the composer card and these bars all sit 16pt inside
                // the chat column, so their edges line up down the page.
                paddingHorizontal: Platform.OS === 'web' ? 16 : 0,
            }}>
                {props.children}
            </View>
        </View>
    );
}
