import { accountMe } from '@/sync/apiAccounts';
import { openResourceSharing } from '@/components/lmc/ResourceSharingDialog';
import { Text } from '@/components/StyledText';
import * as React from 'react';
import { ScrollView, Modal as RNModal, Platform, View, useWindowDimensions } from 'react-native';
import { InteractionPressable as Pressable } from '@/components/InteractionPressable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { lmcElevation, lmcSurfaceBorder } from './lmc/elevation';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { useSessionQuickActions, SessionActionItem } from '@/hooks/useSessionQuickActions';
import { useSession } from '@/sync/storage';
import {
    formatShortcutChord,
    getPreferredShortcutModifier,
    matchesShortcutChord,
    SESSION_ACTION_SHORTCUTS,
} from '@/keyboard/shortcuts';
import { MobileGlassSurface } from './MobileGlass';
import { AnimatedPopup, LocalBlurHalo } from './AnimatedOverlay';
import { openCollaborationSheet } from './lmc/CollaborationSheet';
import { isSecondaryPressEvent } from '@/utils/pointerEvents';
import { t } from '@/text';

export type SessionActionsAnchor =
    | {
        type: 'point';
        x: number;
        y: number;
    }
    | {
        type: 'rect';
        x: number;
        y: number;
        width: number;
        height: number;
    };

interface SessionActionsPopoverProps {
    anchor: SessionActionsAnchor | null;
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    onClose: () => void;
    sessionId: string;
    visible: boolean;
}


const WEB_MENU_WIDTH = 288;
const WEB_MENU_ITEM_HEIGHT = 48;
const WEB_MENU_MARGIN = 12;

const stylesheet = StyleSheet.create((theme) => ({
    backdrop: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        overflow: 'hidden',
    },
    backdropScrim: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0, 0, 0, 0.10)',
    },
    webBackdrop: {
        backgroundColor: 'rgba(0, 0, 0, 0.12)',
    },
    // Same language as the account menu: a padded card whose rows are their own
    // rounded targets, rather than full-bleed rows split by rules.
    card: {
        borderRadius: 16,
        padding: 6,
        backgroundColor: Platform.select({
            web: theme.colors.surface,
            ios: theme.colors.glass.overlay,
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.surface,
        }),
        ...lmcSurfaceBorder(theme),
        ...lmcElevation(theme, 3),
    },
    handle: {
        width: 40,
        height: 4,
        borderRadius: 999,
        marginTop: 10,
        marginBottom: 8,
        alignSelf: 'center',
    },
    menuItem: {
        minHeight: 38,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 10,
        borderRadius: 10,
        gap: 10,
    },
    menuItemPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    menuItemDivider: {
        borderBottomWidth: 0,
    },
    menuItemLabel: {
        flex: 1,
        fontSize: 14,
        lineHeight: 20,
        ...Typography.default(),
    },
    menuItemShortcut: {
        flexShrink: 0,
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 18,
        ...Typography.default('semiBold'),
    },
    nativeContainer: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    nativeSheet: {
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        overflow: 'hidden',
    },
    webContainer: {
        flex: 1,
    },
    webMenu: {
        position: 'absolute',
        width: WEB_MENU_WIDTH,
    },
}));

export function SessionActionsPopover({
    anchor,
    onAfterArchive,
    onAfterDelete,
    onClose,
    sessionId,
    visible,
}: SessionActionsPopoverProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const { height: windowHeight, width: windowWidth } = useWindowDimensions();
    const session = useSession(sessionId);
    const [sharingAvailable, setSharingAvailable] = React.useState(false);
    React.useEffect(() => {
        let active = true;
        setSharingAvailable(false);
        if (visible && session && !session.shared) void accountMe().then(me => {
            if (active) setSharingAvailable(me.capabilities.sessionSharing);
        }).catch(() => {});
        return () => { active = false; };
    }, [visible, sessionId, session?.shared]);
    const { actionItems: actions } = useSessionQuickActions(session!, {
        onAfterArchive,
        onAfterDelete,
    });
    const preferredModifier = React.useMemo(() => getPreferredShortcutModifier(
        typeof navigator === 'undefined' ? undefined : navigator
    ), []);

    const position = React.useMemo(() => {
        if (!anchor) {
            return null;
        }

        const estimatedHeight = (actions.length + (session?.shared ? 0 : 1) + (sharingAvailable ? 1 : 0)) * WEB_MENU_ITEM_HEIGHT;
        const leftBase = anchor.type === 'point'
            ? anchor.x
            : anchor.x + anchor.width - WEB_MENU_WIDTH;

        let topBase = anchor.type === 'point'
            ? anchor.y
            : anchor.y + anchor.height + 8;

        if (anchor.type === 'rect' && topBase + estimatedHeight > windowHeight - WEB_MENU_MARGIN) {
            topBase = anchor.y - estimatedHeight - 8;
        }

        return {
            left: Math.max(WEB_MENU_MARGIN, Math.min(windowWidth - WEB_MENU_WIDTH - WEB_MENU_MARGIN, leftBase)),
            top: Math.max(WEB_MENU_MARGIN, Math.min(windowHeight - estimatedHeight - WEB_MENU_MARGIN, topBase)),
        };
    }, [actions.length, sharingAvailable, session?.shared, anchor, windowHeight, windowWidth]);

    const handleActionPress = React.useCallback((action: SessionActionItem) => {
        if (action.disabled) return;
        onClose();
        action.onPress();
    }, [onClose]);

    // When a menu opens mid-gesture on touch (stationary long-press) or before
    // pointerup on secondary click, lifting the finger dispatches a trailing
    // synthetic click onto the newly portaled modal. Ignore pointer presses
    // until a fresh pointerdown/touchstart/mousedown/keydown occurs after open.
    const armedSinceOpenRef = React.useRef(true);
    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined' || !visible) {
            armedSinceOpenRef.current = true;
            return;
        }
        armedSinceOpenRef.current = false;
        const openedAt = Date.now();
        let sawPointerOrTouch = false;
        const onPointerOrTouch = (event: Event) => {
            if (isSecondaryPressEvent(event)) return;
            sawPointerOrTouch = true;
            armedSinceOpenRef.current = true;
        };
        const onMouseDown = (event: MouseEvent) => {
            if (isSecondaryPressEvent(event)) return;
            if (typeof window.PointerEvent === 'function' && !sawPointerOrTouch && Date.now() - openedAt < 500) {
                return;
            }
            armedSinceOpenRef.current = true;
        };
        const onKeyDown = () => {
            armedSinceOpenRef.current = true;
        };
        window.addEventListener('pointerdown', onPointerOrTouch, true);
        window.addEventListener('touchstart', onPointerOrTouch, true);
        window.addEventListener('mousedown', onMouseDown, true);
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
            window.removeEventListener('pointerdown', onPointerOrTouch, true);
            window.removeEventListener('touchstart', onPointerOrTouch, true);
            window.removeEventListener('mousedown', onMouseDown, true);
            window.removeEventListener('keydown', onKeyDown, true);
        };
    }, [visible]);

    const runWhenArmed = React.useCallback((fn: () => void) => {
        if (Platform.OS === 'web' && !armedSinceOpenRef.current) {
            return;
        }
        fn();
    }, []);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined' || !visible || !anchor || !session) {
            return;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            const action = actions.find((candidate) => matchesShortcutChord(
                event,
                preferredModifier,
                SESSION_ACTION_SHORTCUTS[candidate.id],
            ));
            if (!action) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            handleActionPress(action);
        };

        window.addEventListener('keydown', handleKeyDown, true);
        return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, [actions, anchor, handleActionPress, preferredModifier, session, visible]);

    if (!visible || !anchor || !session) {
        return null;
    }

    const actionItems = actions.map((action, index) => {
        const isLast = index === actions.length - 1;
        const color = action.destructive ? theme.colors.status.error : theme.colors.text;
        const shortcutLabel = formatShortcutChord(
            preferredModifier,
            SESSION_ACTION_SHORTCUTS[action.id],
        );

        return (
            <Pressable
                key={action.id}
                accessibilityRole="button"
                disabled={action.disabled}
                accessibilityState={{ disabled: !!action.disabled }}
                onPress={() => runWhenArmed(() => handleActionPress(action))}
                style={({ pressed }) => [
                    styles.menuItem,
                    action.disabled && { opacity: 0.5 },
                    !isLast && styles.menuItemDivider,
                    pressed && styles.menuItemPressed,
                ]}
            >
                <Ionicons
                    color={color}
                    name={action.icon as keyof typeof Ionicons.glyphMap}
                    size={18}
                />
                <Text numberOfLines={1} style={[styles.menuItemLabel, { color }]}>
                    {action.label}
                </Text>
                {Platform.OS === 'web' && (
                    <Text style={styles.menuItemShortcut}>{shortcutLabel}</Text>
                )}
            </Pressable>
        );
    });

    // "Collaboration…" carries no keyboard shortcut, so it is a hand-built row
    // spliced into the rendered list rather than a member of `actions` — that
    // array also drives the keydown matcher, which assumes every entry has one.
    const renameIndex = actions.findIndex((action) => action.id === 'rename');
    if (!session.shared) actionItems.splice(renameIndex >= 0 ? renameIndex + 1 : 0, 0, (
        <Pressable
            key="collaboration"
            accessibilityRole="button"
            onPress={() => runWhenArmed(() => { onClose(); openCollaborationSheet(sessionId); })}
            style={({ pressed }) => [styles.menuItem, styles.menuItemDivider, pressed && styles.menuItemPressed]}
        >
            <Ionicons color={theme.colors.text} name="people-outline" size={18} />
            <Text numberOfLines={1} style={[styles.menuItemLabel, { color: theme.colors.text }]}>
                {t('lmc.orchestration.collaborationMenu')}
            </Text>
        </Pressable>
    ));

    if (sharingAvailable && !session.shared) actionItems.push(
        <Pressable key="sharing" accessibilityRole="button" onPress={() => runWhenArmed(() => { onClose(); openResourceSharing('session', sessionId); })}
            style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}>
            <Ionicons color={theme.colors.text} name="share-social-outline" size={18} />
            <Text style={[styles.menuItemLabel, { color: theme.colors.text }]}>{t('lmc.sharing.settingsTitle')}</Text>
        </Pressable>
    );

    const nativeContent = (
        <>
            <LocalBlurHalo borderRadius={18} expansion={14} />
            <MobileGlassSurface
                enabled
                nativeEffect
                glassEffectStyle="regular"
                intensity={88}
                tintColor={theme.colors.glass.overlayTint}
                style={styles.card}
            >
                {Platform.OS !== 'web' && (
                    <View style={[styles.handle, { backgroundColor: theme.colors.textSecondary }]} />
                )}
                {actionItems}
            </MobileGlassSurface>
        </>
    );

    if (Platform.OS === 'web' && position) {
        return (
            <RNModal
                animationType="none"
                onRequestClose={onClose}
                transparent
                visible={visible}
            >
                <View
                    style={styles.webContainer}
                    {...({
                        onContextMenu: (event: any) => {
                            event.preventDefault?.();
                            event.stopPropagation?.();
                        },
                        onPointerDown: (event: any) => event.stopPropagation?.(),
                        onPointerUp: (event: any) => event.stopPropagation?.(),
                        onPointerMove: (event: any) => event.stopPropagation?.(),
                        onMouseDown: (event: any) => event.stopPropagation?.(),
                        onMouseUp: (event: any) => event.stopPropagation?.(),
                        onAuxClick: (event: any) => {
                            event.preventDefault?.();
                            event.stopPropagation?.();
                        },
                    } as any)}
                >
                    <Pressable onPress={() => runWhenArmed(onClose)} style={[styles.backdrop, styles.webBackdrop]} />
                    <View
                        style={[
                            styles.webMenu,
                            {
                                left: position.left,
                                top: position.top,
                            },
                        ]}
                    >
                        <ScrollView style={[styles.card, { backgroundColor: theme.colors.header.background, maxHeight: Math.max(48, windowHeight - 2 * WEB_MENU_MARGIN) }]} keyboardShouldPersistTaps="handled">
                            {actionItems}
                        </ScrollView>
                    </View>
                </View>
            </RNModal>
        );
    }

    return (
        <RNModal
            animationType="fade"
            onRequestClose={onClose}
            transparent
            visible={visible}
        >
            <View style={styles.nativeContainer}>
                <Pressable onPress={onClose} style={styles.backdrop}>
                    <View pointerEvents="none" style={styles.backdropScrim} />
                </Pressable>
                <AnimatedPopup
                    style={[
                        styles.nativeSheet,
                        {
                            paddingBottom: Math.max(16, safeArea.bottom),
                        },
                    ]}
                >
                    {nativeContent}
                </AnimatedPopup>
            </View>
        </RNModal>
    );
}
