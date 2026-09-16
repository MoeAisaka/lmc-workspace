import * as React from 'react';
import { Platform } from 'react-native';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import type { SessionActionsAnchor } from '@/components/SessionActionsPopover';
import { isTouchInteraction, readEventPoint } from '@/utils/pointerEvents';
import { Modal } from '@/modal';
import { useSession } from '@/sync/storage';
import { openCollaborationSheet } from '@/components/lmc/CollaborationSheet';
import { t } from '@/text';

// Matches react-native-web's own default; pinned here so the menu keeps the
// same feel if that default ever moves.
const LONG_PRESS_DELAY_MS = 450;

// Long pressing a row on a touch screen selects the label text underneath it
// unless selection is suppressed for the row itself.
export const SESSION_ROW_MENU_STYLE = Platform.OS === 'web'
    ? ({ userSelect: 'none', WebkitTouchCallout: 'none' } as any)
    : undefined;

export interface SessionRowMenu {
    anchor: SessionActionsAnchor | null;
    closeMenu: () => void;
    menuProps: Record<string, unknown>;
    /** Opens the same menu from an explicit control (the hover ⋮ button). */
    openMenuAt: (point: { x: number; y: number }) => void;
}

/**
 * Row props that open the session actions menu: right click on web, long press
 * on any touch screen (web included), and the native action sheet elsewhere.
 *
 * `anchor` drives <SessionActionsPopover>, which only renders on web; native
 * platforms surface the same actions through the alert instead.
 */
export function useSessionRowMenu(sessionId: string): SessionRowMenu {
    const [anchor, setAnchor] = React.useState<SessionActionsAnchor | null>(null);
    const pointRef = React.useRef({ x: 0, y: 0 });
    const isTouchRef = React.useRef(false);

    const openAt = React.useCallback((point: { x: number; y: number }) => {
        setAnchor({ type: 'point', x: point.x, y: point.y });
    }, []);

    const handleContextMenu = React.useCallback((event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        openAt(readEventPoint(event));
    }, [openAt]);

    // The long press event itself carries no coordinates, so the anchor comes
    // from where the press started.
    const handlePressIn = React.useCallback((event: any) => {
        pointRef.current = readEventPoint(event);
        // Sortable Web rows arbitrate stationary long-press vs drag and dispatch
        // the existing context menu after release. Do not open a competing menu.
        const target = event.nativeEvent?.target ?? event.target;
        const sortable = target && typeof target.closest === 'function' && target.closest('[data-session-sort-id]');
        isTouchRef.current = isTouchInteraction(event) && !sortable;
    }, []);

    const handleLongPress = React.useCallback(() => {
        if (!isTouchRef.current) {
            return;
        }
        openAt(pointRef.current);
    }, [openAt]);

    const closeMenu = React.useCallback(() => setAnchor(null), []);

    const showActionAlert = useSessionActionAlertWithCollaboration(sessionId);

    const menuProps = React.useMemo(() => (
        Platform.OS === 'web'
            ? {
                onContextMenu: handleContextMenu,
                onPressIn: handlePressIn,
                onLongPress: handleLongPress,
                delayLongPress: LONG_PRESS_DELAY_MS,
            }
            : {
                onLongPress: showActionAlert,
            }
    ), [handleContextMenu, handlePressIn, handleLongPress, showActionAlert]);

    return { anchor, closeMenu, menuProps, openMenuAt: openAt };
}

/**
 * The native action sheet, with "Collaboration…" spliced in next to rename —
 * the same addition the web popover makes to its own rendered list, since
 * this sheet's buttons come straight from `useSessionQuickActions` and carry
 * no seam of their own to extend.
 */
function useSessionActionAlertWithCollaboration(sessionId: string) {
    const session = useSession(sessionId);
    const { actionItems } = useSessionQuickActions(session!, {});
    return React.useCallback(() => {
        if (!session) return;
        const renameIndex = actionItems.findIndex((item) => item.id === 'rename');
        const items = [...actionItems];
        items.splice(renameIndex >= 0 ? renameIndex + 1 : 0, 0, {
            id: 'collaboration',
            icon: 'people-outline',
            label: t('lmc.orchestration.collaborationMenu'),
            onPress: () => openCollaborationSheet(sessionId),
        } as unknown as typeof actionItems[number]);
        const buttons: { text: string; onPress?: () => void; style?: 'cancel' | 'destructive' }[] = items.map((item) => ({
            text: item.label,
            onPress: item.disabled ? undefined : item.onPress,
            style: item.destructive ? 'destructive' as const : undefined,
        }));
        buttons.push({ text: t('common.cancel'), style: 'cancel' as const });
        Modal.alert(t('localFeatures.session'), undefined, buttons);
    }, [actionItems, session, sessionId]);
}
