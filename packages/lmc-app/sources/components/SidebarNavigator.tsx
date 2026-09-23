import { installSidebarMotion, runSidebarTransition } from '@/utils/sidebarMotion';
import { useAuth } from '@/auth/AuthContext';
import * as React from 'react';
import { Drawer } from 'expo-router/drawer';
import { useIsTablet, useHeaderHeight } from '@/utils/responsive';
import { SidebarView } from './SidebarView';
import { useWindowDimensions, View, Pressable, Platform } from 'react-native';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { Text } from './StyledText';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { isTauri } from '@/utils/isTauri';
import { useOverlayNav } from '@/-session/sessionOverlayNav';
import { DEFAULT_APP_ZOOM } from '@/hooks/useTauriZoom';
import { canRouteForward, canUseRouteBack, getNavigatorCanGoBack } from '@/navigation/browserNavigation';
import { useBrowserNavigationStore } from '@/navigation/browserNavigationStore';
import { FloatingSessionDrawer } from './lmc/FloatingSessionDrawer';
import { AccountMenuLayer } from './lmc/AccountMenu';
import { ToastLayer } from './lmc/Toast';

const TAURI_HEADER_CONTROL_LEFT = Math.ceil(92 / DEFAULT_APP_ZOOM);

export const SidebarNavigator = React.memo(() => {
    const auth = useAuth();
    const { theme } = useUnistyles();
    React.useEffect(installSidebarMotion, []);
    const isTablet = useIsTablet();
    const zenMode = useLocalSetting('zenMode');
    const isDesktopLayout = auth.isAuthenticated && isTablet;
    const leftSidebarCollapsed = false;
    const showSidebar = isDesktopLayout && !zenMode;
    const { width: windowWidth } = useWindowDimensions();

    // Calculate target drawer width
    const fullDrawerWidth = React.useMemo(() => {
        // 360, not 300: rows carry a second line of device, engine and task
        // state now, and at 300 the title was the first thing to be cut.
        if (!isDesktopLayout) return 360;
        return 360;
    }, [windowWidth, isDesktopLayout]);
    // Collapsed keeps a rail of icons rather than nothing, so new session,
    // the list and the account stay one click away. Zen mode still hides all.
    const drawerWidth = showSidebar ? fullDrawerWidth : 0;


    const drawerNavigationOptions = React.useMemo(() => {
        if (!isDesktopLayout) {
            // Non-tablet: use front drawer, hidden
            return {
                lazy: false,
                headerShown: false,
                drawerType: 'front' as const,
                swipeEnabled: false,
                drawerStyle: {
                    width: 0,
                    display: 'none' as const,
                },
            };
        }

        // Tablet: always permanent; the width steps between the full sidebar,
        // the icon rail and zero (zen mode).
        //
        // We deliberately do NOT animate `width` on web. A CSS transition on
        // the drawer width re-flowed the chat flex-1 sibling on every frame,
        // re-measuring the entire FlatList tree at ~15fps. Snapping the
        // width change makes the chat reflow exactly once. Native already
        // snaps because RN doesn't honor CSS transition properties.
        return {
            lazy: false,
            headerShown: false,
            drawerType: 'permanent' as const,
            drawerStyle: {
                backgroundColor: theme.colors.surface,
                borderRightWidth: 0,
                width: drawerWidth,
                overflow: 'hidden' as const,
            } as any,
            swipeEnabled: false,
            drawerActiveTintColor: 'transparent',
            drawerInactiveTintColor: 'transparent',
            drawerItemStyle: { display: 'none' as const },
            drawerLabelStyle: { display: 'none' as const },
        };
    }, [isDesktopLayout, drawerWidth, theme.colors.surface]);

    const drawerContent = React.useCallback(
        // One view-transition name across both states lets the browser morph the
        // sidebar into the rail instead of cross-fading two unrelated boxes.
        () => (
            <View style={{ flex: 1, width: fullDrawerWidth }}>
                <SidebarView />
            </View>
        ),
        [fullDrawerWidth]
    );

    return (
        <View style={{ flex: 1 }}>
            <Drawer
                screenOptions={drawerNavigationOptions}
                drawerContent={isDesktopLayout ? drawerContent : undefined}
                // Naming the scene lets the browser morph the chat pane when the
                // sidebar resizes; without it the whole page cross-fades and the
                // content appears to jump to its new position.
                {...(Platform.OS === 'web' ? { sceneStyle: { viewTransitionName: 'lmc-main' } as any } : {})}
            />
            {/* Persistent header overlay — always visible on desktop, same position regardless of zen mode */}
            {isDesktopLayout && !showSidebar && <PersistentHeader />}
            {/* Phone: the session list is a floating card over whatever screen is open. */}
            {auth.isAuthenticated && !isDesktopLayout && <FloatingSessionDrawer />}
            {auth.isAuthenticated && (isDesktopLayout || Platform.OS === 'web') && <AccountMenuLayer />}
            <ToastLayer />
        </View>
    );
});

// Header block that stays in the same position whether zen mode is on or off
const PersistentHeader = React.memo(() => {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const router = useRouter();
    const [zenMode, setZenMode] = useLocalSettingMutable('zenMode');
    const leftSidebarCollapsed = false;
    const inTauri = isTauri();
    const isMacTauri = inTauri && typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

    const routeHistory = useBrowserNavigationStore((s) => s.routeHistory);
    const canGoForward = useBrowserNavigationStore((s) => s.routeHistory ? canRouteForward(s.routeHistory) : false);
    const overlayCanBack = useOverlayNav((s) => s.canBack);
    const overlayCanForward = useOverlayNav((s) => s.canForward);
    const canGoBack = routeHistory
        ? canUseRouteBack(routeHistory, getNavigatorCanGoBack(router))
        : false;

    // The sidebar no longer collapses; this only leaves and re-enters zen mode.
    const handleZenToggle = React.useCallback(() => {
        runSidebarTransition(() => setZenMode(!zenMode));
    }, [zenMode, setZenMode]);

    const handleBack = React.useCallback(() => {
        // Intra-session overlay (file diff / file view) consumes back first,
        // so the chat → diff → file flow can be unwound without a close X.
        if (useOverlayNav.getState().back()) return;
        const nav = useBrowserNavigationStore.getState();
        if (!nav.routeHistory || !canUseRouteBack(nav.routeHistory, getNavigatorCanGoBack(router))) return;
        nav.markRouteBack();
        router.back();
    }, [router]);

    const handleForward = React.useCallback(() => {
        if (useOverlayNav.getState().forward()) return;
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
            const nav = useBrowserNavigationStore.getState();
            if (!nav.routeHistory || !canRouteForward(nav.routeHistory)) return;
            nav.markRouteForward();
            window.history.forward();
        }
    }, []);

    const canGoBackEffective = canGoBack || overlayCanBack;
    const canGoForwardEffective = canGoForward || overlayCanForward;

    return (
        <View
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                paddingTop: safeArea.top,
                paddingLeft: isMacTauri ? TAURI_HEADER_CONTROL_LEFT : 16,
                paddingRight: 16,
                height: safeArea.top + headerHeight,
                flexDirection: 'row',
                alignItems: 'center',
                zIndex: 1100,
            }}
            pointerEvents="box-none"
            {...(inTauri ? { dataSet: { tauriDragRegion: 'true' } } : {})}
        >
            {/* Zen / Back / Forward buttons */}
            <View
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4, width: !leftSidebarCollapsed && !zenMode ? 308 : undefined }}
                pointerEvents="auto"
                {...(inTauri ? { dataSet: { tauriDragRegion: 'false' } } : {})}
            >
                {Platform.OS === 'web' && !leftSidebarCollapsed && !zenMode && <View style={{flex:1,flexDirection:'row',alignItems:'center',gap:8}}>
                    <Image source={require('@/assets/images/lmc-logo.png')} style={{width:26,height:26,borderRadius:8}} />
                    <Text style={{fontSize:15,color:theme.colors.text}}>Link my Cli</Text>
                </View>}
                <Pressable
                    onPress={handleZenToggle}
                    hitSlop={10}
                    style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}
                    accessibilityRole="button"
                    accessibilityLabel={leftSidebarCollapsed ? t('lmc.common.expandList') : t('lmc.common.collapseList')}
                    accessibilityState={{ expanded: !leftSidebarCollapsed }}
                >
                    <Ionicons name={leftSidebarCollapsed ? 'menu-outline' : 'albums-outline'} size={22} color={theme.colors.header.tint} />
                </Pressable>
                {/* Detail screens (message, files, info) have no back button of their own on desktop; this one is always available. */}
                <Pressable onPress={handleBack} disabled={!canGoBackEffective} hitSlop={10} style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center', opacity: canGoBackEffective ? 1 : 0.3 }}>
                    <Ionicons name="chevron-back" size={20} color={theme.colors.header.tint} />
                </Pressable>
                {Platform.OS === 'web' && (
                    <Pressable onPress={handleForward} disabled={!canGoForwardEffective} hitSlop={10} style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center', opacity: canGoForwardEffective ? 1 : 0.3 }}>
                        <Ionicons name="chevron-forward" size={20} color={theme.colors.header.tint} />
                    </Pressable>
                )}
            </View>
        </View>
    );
});
