import * as React from 'react';
import { Platform } from 'react-native';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import type { SessionActionsAnchor } from '@/components/SessionActionsPopover';
import { isSecondaryPressEvent, isTouchInteraction, readEventPoint } from '@/utils/pointerEvents';
import { Modal } from '@/modal';
import { useSession } from '@/sync/storage';
import { openCollaborationSheet } from '@/components/lmc/CollaborationSheet';
import { t } from '@/text';

// Matches react-native-web's own default; pinned here so the menu keeps the
// same feel if that default ever moves.
const LONG_PRESS_DELAY_MS = 450;
// iPadOS browsers (WKWebView) often swallow DOM `contextmenu` on trackpad
// two-finger clicks or mouse right-clicks while still firing `pointerdown`.
const SECONDARY_CONTEXTMENU_FALLBACK_MS = 80;
const PRIMARY_PRESS_SELECTSTART_GUARD_MS = 40;
const PRIMARY_CLICK_SELECTIONCHANGE_GUARD_MS = 120;
const MENU_CLOSE_SELECTIONCHANGE_GUARD_MS = 180;
const FOCUS_SELECTIONCHANGE_GUARD_MS = 60;
const INPUT_SELECTIONCHANGE_GUARD_MS = 60;
const KEY_SELECTIONCHANGE_GUARD_MS = 80;
const SECONDARY_DEDUPE_MS = 250;
const POST_TOUCH_SUPPRESS_RELEASE_MS = 120;
const STALE_TOUCH_RESET_MS = 2500;
const CONTEXT_HIT_LINK_HREF = 'lmc-context:row';

// On iPadOS, WKMouseTouchGestureRecognizer only enables UIEventButtonMaskSecondary
// on Mac Catalyst (#if PLATFORM(MACCATALYST)), and WKContentView rejects pointer
// touches from WKTouchEventsGestureRecognizer, so secondary clicks from ANY
// pointing device (Magic Keyboard two-finger tap/click, Bluetooth/USB mouse
// right-click) emit zero pointerdown/mousedown/contextmenu events across Safari,
// Chrome (CriOS), Edge (EdgiOS), and Home Screen web apps.
//
// Furthermore, on iPadOS 17.4+ / 18 / 26 (BrowserEngineKit + UIAsyncTextInteraction),
// WKContentView returns a synchronous BEContextMenuConfiguration before
// UITextContextMenuInteraction runs _defaultContextMenuInteraction:, skipping
// WebCore selectstart as well. The ONLY WebProcess IPC executed on secondary click
// is WKContentView._internalContextMenuInteraction: -> RequestPositionInformation
// with `request.includeLinkIndicator = true` (which is false on hover/click/scroll).
//
// Rendering the hit overlay as `<a href="lmc-context:row">` on WebKit touch devices
// causes PositionInformationForWebPage -> TextIndicator::createWithRange to run
// TemporarySelectionChange(..., DoNotSetFocus | IgnoreSelectionChanges), which
// queues a zero-net-change `selectionchange` event on `document` while preserving
// input focus and existing page selection; `-webkit-touch-callout: none` then makes
// WKContentView fulfill BEContextMenuConfiguration with `nil` (zero native menu or
// link preview). Stripping `href` synchronously during active touch gestures keeps
// touch long-press, scroll, and hold-to-drag completely unaffected, while retaining
// the NBSP text grid + `selectstart` listener preserves iPadOS <= 17.3 too.
const CONTEXT_HIT_OVERLAY_TEXT = Array.from({ length: 12 }, () => '\u00a0'.repeat(80)).join('\n');
const CONTEXT_HIT_OVERLAY_STYLE: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    display: 'block',
    overflow: 'hidden',
    color: 'transparent',
    WebkitTextFillColor: 'transparent',
    backgroundColor: 'transparent',
    textDecoration: 'none',
    outline: 'none',
    fontFamily: 'monospace',
    fontSize: '32px',
    lineHeight: '32px',
    letterSpacing: '0px',
    whiteSpace: 'pre',
    userSelect: 'text',
    WebkitUserSelect: 'text',
    WebkitTouchCallout: 'none',
    WebkitUserDrag: 'none',
    cursor: 'pointer',
    zIndex: 1,
} as React.CSSProperties;

export function shouldUseWebKitLinkContextProbe(
    nav: Partial<Navigator> | undefined = typeof navigator !== 'undefined' ? navigator : undefined,
): boolean {
    if (!nav) return false;
    const ua = String(nav.userAgent ?? '');
    if (/iPad|iPhone|iPod/i.test(ua)) {
        return true;
    }
    const maxTouchPoints = typeof nav.maxTouchPoints === 'number' ? nav.maxTouchPoints : 0;
    if (maxTouchPoints > 0 && (/Macintosh/i.test(ua) || nav.platform === 'MacIntel')) {
        return true;
    }
    return false;
}

// Long pressing a row on a touch screen selects the label text underneath it
// unless selection is suppressed for the row itself. Include WebkitUserSelect
// explicitly because React inline styles do not vendor-prefix `userSelect`.
export const SESSION_ROW_MENU_STYLE = Platform.OS === 'web'
    ? ({ userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' } as any)
    : undefined;

interface DomSelectionSnapshot {
    rangeCount: number;
    isCollapsed: boolean;
    anchorNode: Node | null;
    anchorOffset: number;
    focusNode: Node | null;
    focusOffset: number;
    text: string;
}

interface TextControlSelectionSnapshot {
    start: number | null;
    end: number | null;
    length: number;
}

interface RegisteredHitOverlay {
    openFromSelectionProbe: (overlayNode: HTMLElement) => void;
}

const EMPTY_DOM_SELECTION: DomSelectionSnapshot = {
    rangeCount: 0,
    isCollapsed: true,
    anchorNode: null,
    anchorOffset: 0,
    focusNode: null,
    focusOffset: 0,
    text: '',
};

let globalListenerRefs = 0;
let globalActiveTouchCount = 0;
let globalTouchSuppressed = false;
let globalLastTouchActivityAt = 0;
let globalPrimaryMouseDown = false;
let globalLastPrimaryActivityAt = 0;
let globalLastMenuClosedAt = 0;
let globalLastMousePoint = { x: 0, y: 0 };
let globalLastFocusChangeAt = 0;
let globalLastInputActivityAt = 0;
let globalLastKeyActivityAt = 0;
let globalHoveredOverlay: HTMLElement | null = null;
let globalLastDomSelection: DomSelectionSnapshot = EMPTY_DOM_SELECTION;
let globalTouchReleaseTimer: ReturnType<typeof setTimeout> | null = null;
const globalActiveTouchPointers = new Set<number>();
const globalTouchResetListeners = new Set<() => void>();
const registeredHitOverlays = new Map<HTMLElement, RegisteredHitOverlay>();
let controlSelectionSnapshots = new WeakMap<Element, TextControlSelectionSnapshot>();
let activeSessionMenuCloser: (() => void) | null = null;
let detachGlobalTouchCoordinator: (() => void) | null = null;

function captureDomSelection(): DomSelectionSnapshot {
    if (typeof window === 'undefined' || typeof window.getSelection !== 'function') {
        return EMPTY_DOM_SELECTION;
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
        return EMPTY_DOM_SELECTION;
    }
    return {
        rangeCount: sel.rangeCount,
        isCollapsed: sel.isCollapsed,
        anchorNode: sel.anchorNode,
        anchorOffset: sel.anchorOffset,
        focusNode: sel.focusNode,
        focusOffset: sel.focusOffset,
        text: sel.toString(),
    };
}

function domSelectionEquals(a: DomSelectionSnapshot, b: DomSelectionSnapshot): boolean {
    return a.rangeCount === b.rangeCount
        && a.isCollapsed === b.isCollapsed
        && a.anchorNode === b.anchorNode
        && a.anchorOffset === b.anchorOffset
        && a.focusNode === b.focusNode
        && a.focusOffset === b.focusOffset
        && a.text === b.text;
}

function isTextSelectionControl(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
    if (!el) return false;
    const tag = el.tagName;
    if (tag !== 'TEXTAREA' && tag !== 'INPUT') return false;
    try {
        return typeof (el as HTMLInputElement).selectionStart === 'number' || tag === 'TEXTAREA';
    } catch {
        return false;
    }
}

function syncControlSelectionSnapshot(el: Element | null) {
    if (!isTextSelectionControl(el)) return;
    try {
        controlSelectionSnapshots.set(el, {
            start: el.selectionStart,
            end: el.selectionEnd,
            length: typeof el.value === 'string' ? el.value.length : 0,
        });
    } catch {
        // Ignore input types without selection ranges.
    }
}

function syncHitOverlayNodeState(node: HTMLElement, inert: boolean) {
    const useLinkProbe = !inert && shouldUseWebKitLinkContextProbe();
    node.setAttribute('data-lmc-context-hit', inert ? 'inert' : '');
    node.style.userSelect = inert ? 'none' : 'text';
    node.style.setProperty('-webkit-user-select', inert ? 'none' : 'text');
    node.style.setProperty('-webkit-touch-callout', 'none');
    node.style.setProperty('-webkit-text-fill-color', 'transparent');
    node.style.setProperty('-webkit-user-drag', 'none');
    if (useLinkProbe) {
        node.setAttribute('href', CONTEXT_HIT_LINK_HREF);
        node.setAttribute('title', ' ');
    } else {
        node.removeAttribute('href');
        node.removeAttribute('title');
    }
}

function setAllHitOverlaysInert(inert: boolean) {
    if (typeof document === 'undefined') return;
    const nodes = document.querySelectorAll<HTMLElement>('[data-lmc-context-hit]');
    nodes.forEach((node) => {
        syncHitOverlayNodeState(node, inert);
    });
}

function isAnyTouchActive(): boolean {
    return globalActiveTouchCount > 0 || globalActiveTouchPointers.size > 0;
}

function cancelTouchReleaseTimer() {
    if (globalTouchReleaseTimer) {
        clearTimeout(globalTouchReleaseTimer);
        globalTouchReleaseTimer = null;
    }
}

function resetAllTouchState() {
    cancelTouchReleaseTimer();
    globalActiveTouchCount = 0;
    globalActiveTouchPointers.clear();
    globalTouchSuppressed = false;
    globalPrimaryMouseDown = false;
    setAllHitOverlaysInert(false);
    globalTouchResetListeners.forEach((reset) => reset());
}

function scheduleTouchSuppressionRelease() {
    cancelTouchReleaseTimer();
    globalTouchReleaseTimer = setTimeout(() => {
        globalTouchReleaseTimer = null;
        if (isAnyTouchActive()) return;
        globalTouchSuppressed = false;
        setAllHitOverlaysInert(false);
    }, POST_TOUCH_SUPPRESS_RELEASE_MS);
}

function isPointNearRect(point: { x: number; y: number }, rect: DOMRect): boolean {
    return (point.x > 0 || point.y > 0)
        && point.x >= rect.left - 4
        && point.x <= rect.right + 4
        && point.y >= rect.top - 4
        && point.y <= rect.bottom + 4;
}

function resolveProbeTargetOverlay(): HTMLElement | null {
    if (typeof document === 'undefined' || registeredHitOverlays.size === 0) {
        return null;
    }
    const hasPoint = globalLastMousePoint.x > 0 || globalLastMousePoint.y > 0;
    if (hasPoint && typeof document.elementFromPoint === 'function') {
        const hit = document.elementFromPoint(globalLastMousePoint.x, globalLastMousePoint.y);
        if (hit) {
            const overlay = typeof hit.closest === 'function'
                ? hit.closest<HTMLElement>('[data-lmc-context-hit]')
                : null;
            return overlay && registeredHitOverlays.has(overlay) ? overlay : null;
        }
    }
    if (hasPoint) {
        let anyMeasuredRect = false;
        for (const overlay of registeredHitOverlays.keys()) {
            if (!overlay.isConnected) continue;
            const rect = overlay.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                anyMeasuredRect = true;
                if (isPointNearRect(globalLastMousePoint, rect)) {
                    return overlay;
                }
            }
        }
        if (anyMeasuredRect) {
            return null;
        }
    }
    try {
        const cssHovered = document.querySelector<HTMLElement>('[data-lmc-context-hit]:hover');
        if (cssHovered && registeredHitOverlays.has(cssHovered)) {
            return cssHovered;
        }
    } catch {
        // Ignore engines without :hover selector support in synthetic tests.
    }
    if (globalHoveredOverlay && globalHoveredOverlay.isConnected && registeredHitOverlays.has(globalHoveredOverlay)) {
        return globalHoveredOverlay;
    }
    return null;
}

function resolveOverlayAnchorPoint(
    overlayNode: HTMLElement | null,
    localHoverPoint: { x: number; y: number },
): { x: number; y: number } {
    if (overlayNode) {
        const rect = overlayNode.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            if (isPointNearRect(localHoverPoint, rect)) {
                return localHoverPoint;
            }
            if (isPointNearRect(globalLastMousePoint, rect)) {
                return globalLastMousePoint;
            }
            return {
                x: Math.round(rect.left + Math.min(48, rect.width / 2)),
                y: Math.round(rect.top + rect.height / 2),
            };
        }
    }
    if (localHoverPoint.x > 0 || localHoverPoint.y > 0) {
        return localHoverPoint;
    }
    if (globalLastMousePoint.x > 0 || globalLastMousePoint.y > 0) {
        return globalLastMousePoint;
    }
    return { x: 0, y: 0 };
}

function isPureModifierKey(key: string): boolean {
    return key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta';
}

function refreshSelectionBaseline() {
    globalLastDomSelection = captureDomSelection();
    if (typeof document !== 'undefined') {
        syncControlSelectionSnapshot(document.activeElement);
    }
}

function scheduleSelectionBaselineRefresh() {
    refreshSelectionBaseline();
    Promise.resolve().then(refreshSelectionBaseline);
}

function retainGlobalTouchCoordinator(onTouchStartReset: () => void): () => void {
    if (typeof window === 'undefined') return () => {};
    globalTouchResetListeners.add(onTouchStartReset);
    globalListenerRefs += 1;

    if (globalListenerRefs === 1) {
        refreshSelectionBaseline();

        const onTouchStart = (event: TouchEvent) => {
            cancelTouchReleaseTimer();
            globalLastTouchActivityAt = Date.now();
            globalActiveTouchCount = event.touches ? event.touches.length : 1;
            globalTouchSuppressed = true;
            globalPrimaryMouseDown = false;
            setAllHitOverlaysInert(true);
            globalTouchResetListeners.forEach((reset) => reset());
        };
        const onTouchMove = () => {
            if (globalActiveTouchCount > 0) {
                globalLastTouchActivityAt = Date.now();
            }
        };
        const onTouchEnd = (event: TouchEvent) => {
            globalLastTouchActivityAt = Date.now();
            globalActiveTouchCount = event.touches ? event.touches.length : 0;
            if (globalActiveTouchCount === 0) {
                globalActiveTouchPointers.clear();
                scheduleTouchSuppressionRelease();
            }
        };
        const onPointerDown = (event: PointerEvent) => {
            if (typeof event.pointerType === 'string' && event.pointerType !== 'mouse') {
                cancelTouchReleaseTimer();
                globalLastTouchActivityAt = Date.now();
                globalActiveTouchPointers.add(event.pointerId);
                globalTouchSuppressed = true;
                globalPrimaryMouseDown = false;
                setAllHitOverlaysInert(true);
                globalTouchResetListeners.forEach((reset) => reset());
                return;
            }
            if (isAnyTouchActive() && Date.now() - globalLastTouchActivityAt > STALE_TOUCH_RESET_MS) {
                resetAllTouchState();
            }
            if (event.clientX > 0 || event.clientY > 0) {
                globalLastMousePoint = { x: Math.round(event.clientX), y: Math.round(event.clientY) };
            }
            if (isSecondaryPressEvent(event)) {
                globalPrimaryMouseDown = false;
                return;
            }
            if (event.button === 0 && !event.ctrlKey) {
                globalPrimaryMouseDown = true;
                globalLastPrimaryActivityAt = Date.now();
            }
        };
        const onPointerEnd = (event: PointerEvent) => {
            if (typeof event.pointerType === 'string' && event.pointerType !== 'mouse') {
                globalLastTouchActivityAt = Date.now();
                globalActiveTouchPointers.delete(event.pointerId);
                if (!isAnyTouchActive()) {
                    scheduleTouchSuppressionRelease();
                }
                return;
            }
            if (event.button === 0 && !event.ctrlKey) {
                globalLastPrimaryActivityAt = Date.now();
            }
            globalPrimaryMouseDown = false;
            globalTouchResetListeners.forEach((reset) => reset());
        };
        const onPointerMove = (event: PointerEvent) => {
            if (event.pointerType !== 'mouse') {
                if (typeof event.pointerType === 'string' && globalActiveTouchPointers.has(event.pointerId)) {
                    globalLastTouchActivityAt = Date.now();
                }
                return;
            }
            const now = Date.now();
            if (isAnyTouchActive()) {
                if ((event.buttons ?? 0) === 0 && now - globalLastTouchActivityAt > STALE_TOUCH_RESET_MS) {
                    resetAllTouchState();
                } else {
                    return;
                }
            }
            // Ignore synthetic compatibility mousemove emitted right after a touch tap.
            if (globalTouchSuppressed && now - globalLastTouchActivityAt < POST_TOUCH_SUPPRESS_RELEASE_MS) {
                return;
            }
            // Ignore synthetic (-1, -1) emitted when iPadOS cancels WKMouseHover.
            if (event.clientX > 0 || event.clientY > 0) {
                globalLastMousePoint = { x: Math.round(event.clientX), y: Math.round(event.clientY) };
            }
            const buttons = event.buttons ?? 0;
            if ((buttons & 1) === 1 && !event.ctrlKey) {
                globalPrimaryMouseDown = true;
                globalLastPrimaryActivityAt = now;
                return;
            }
            if (buttons === 0) {
                globalPrimaryMouseDown = false;
                refreshSelectionBaseline();
                if (globalTouchSuppressed) {
                    cancelTouchReleaseTimer();
                    globalTouchSuppressed = false;
                    setAllHitOverlaysInert(false);
                }
            }
        };
        const onMouseDown = (event: MouseEvent) => {
            if (globalTouchSuppressed || isAnyTouchActive()) return;
            if (event.clientX > 0 || event.clientY > 0) {
                globalLastMousePoint = { x: Math.round(event.clientX), y: Math.round(event.clientY) };
            }
            if (isSecondaryPressEvent(event)) {
                globalPrimaryMouseDown = false;
                return;
            }
            if (event.button === 0 && !event.ctrlKey) {
                globalPrimaryMouseDown = true;
                globalLastPrimaryActivityAt = Date.now();
            }
        };
        const onMouseUp = (event: MouseEvent) => {
            if (!isSecondaryPressEvent(event) && event.button === 0) {
                globalLastPrimaryActivityAt = Date.now();
            }
            globalPrimaryMouseDown = false;
            globalTouchResetListeners.forEach((reset) => reset());
        };
        const onClick = (event: MouseEvent) => {
            if (!isSecondaryPressEvent(event)) {
                globalLastPrimaryActivityAt = Date.now();
                scheduleSelectionBaselineRefresh();
            }
        };
        const onWheel = (event: WheelEvent) => {
            if (isAnyTouchActive()) {
                if (Date.now() - globalLastTouchActivityAt > STALE_TOUCH_RESET_MS) {
                    resetAllTouchState();
                } else {
                    return;
                }
            }
            if (event.clientX > 0 || event.clientY > 0) {
                globalLastMousePoint = { x: Math.round(event.clientX), y: Math.round(event.clientY) };
            }
            refreshSelectionBaseline();
            if (globalTouchSuppressed) {
                cancelTouchReleaseTimer();
                globalTouchSuppressed = false;
                setAllHitOverlaysInert(false);
            }
        };
        const onFocusIn = () => {
            globalLastFocusChangeAt = Date.now();
            scheduleSelectionBaselineRefresh();
        };
        const onFocusOut = () => {
            globalLastFocusChangeAt = Date.now();
            scheduleSelectionBaselineRefresh();
        };
        const onInput = () => {
            globalLastInputActivityAt = Date.now();
            scheduleSelectionBaselineRefresh();
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (!isPureModifierKey(event.key)) {
                globalLastKeyActivityAt = Date.now();
            }
        };
        const onWindowBlurOrHide = () => {
            if (isAnyTouchActive() || globalTouchSuppressed || globalPrimaryMouseDown) {
                resetAllTouchState();
            }
        };
        const onSelectionChange = () => {
            const nextDom = captureDomSelection();
            const prevDom = globalLastDomSelection;
            globalLastDomSelection = nextDom;

            const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
            let controlChanged = false;
            if (isTextSelectionControl(activeEl)) {
                try {
                    const curCtrl: TextControlSelectionSnapshot = {
                        start: activeEl.selectionStart,
                        end: activeEl.selectionEnd,
                        length: typeof activeEl.value === 'string' ? activeEl.value.length : 0,
                    };
                    const prevCtrl = controlSelectionSnapshots.get(activeEl);
                    controlSelectionSnapshots.set(activeEl, curCtrl);
                    if (
                        !prevCtrl
                        || prevCtrl.start !== curCtrl.start
                        || prevCtrl.end !== curCtrl.end
                        || prevCtrl.length !== curCtrl.length
                    ) {
                        controlChanged = true;
                    }
                } catch {
                    // Ignore input types without selection ranges.
                }
            }

            if (!shouldUseWebKitLinkContextProbe()) {
                return;
            }
            if (!domSelectionEquals(prevDom, nextDom) || controlChanged) {
                return;
            }
            const now = Date.now();
            if (
                globalTouchSuppressed
                || isAnyTouchActive()
                || globalPrimaryMouseDown
                || (globalLastPrimaryActivityAt > 0 && now - globalLastPrimaryActivityAt < PRIMARY_CLICK_SELECTIONCHANGE_GUARD_MS)
                || (globalLastMenuClosedAt > 0 && now - globalLastMenuClosedAt < MENU_CLOSE_SELECTIONCHANGE_GUARD_MS)
                || (globalLastFocusChangeAt > 0 && now - globalLastFocusChangeAt < FOCUS_SELECTIONCHANGE_GUARD_MS)
                || (globalLastInputActivityAt > 0 && now - globalLastInputActivityAt < INPUT_SELECTIONCHANGE_GUARD_MS)
                || (globalLastKeyActivityAt > 0 && now - globalLastKeyActivityAt < KEY_SELECTIONCHANGE_GUARD_MS)
            ) {
                return;
            }
            const overlay = resolveProbeTargetOverlay();
            if (!overlay) {
                return;
            }
            registeredHitOverlays.get(overlay)?.openFromSelectionProbe(overlay);
        };

        window.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
        window.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
        window.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
        window.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true });
        window.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('pointerup', onPointerEnd, true);
        window.addEventListener('pointercancel', onPointerEnd, true);
        window.addEventListener('pointermove', onPointerMove, true);
        window.addEventListener('mousedown', onMouseDown, true);
        window.addEventListener('mouseup', onMouseUp, true);
        window.addEventListener('click', onClick, true);
        window.addEventListener('wheel', onWheel, { capture: true, passive: true });
        window.addEventListener('focusin', onFocusIn, true);
        window.addEventListener('focusout', onFocusOut, true);
        window.addEventListener('input', onInput, true);
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('blur', onWindowBlurOrHide);
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', onWindowBlurOrHide);
            document.addEventListener('selectionchange', onSelectionChange);
        }

        detachGlobalTouchCoordinator = () => {
            window.removeEventListener('touchstart', onTouchStart, true);
            window.removeEventListener('touchmove', onTouchMove, true);
            window.removeEventListener('touchend', onTouchEnd, true);
            window.removeEventListener('touchcancel', onTouchEnd, true);
            window.removeEventListener('pointerdown', onPointerDown, true);
            window.removeEventListener('pointerup', onPointerEnd, true);
            window.removeEventListener('pointercancel', onPointerEnd, true);
            window.removeEventListener('pointermove', onPointerMove, true);
            window.removeEventListener('mousedown', onMouseDown, true);
            window.removeEventListener('mouseup', onMouseUp, true);
            window.removeEventListener('click', onClick, true);
            window.removeEventListener('wheel', onWheel, true);
            window.removeEventListener('focusin', onFocusIn, true);
            window.removeEventListener('focusout', onFocusOut, true);
            window.removeEventListener('input', onInput, true);
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('blur', onWindowBlurOrHide);
            if (typeof document !== 'undefined') {
                document.removeEventListener('visibilitychange', onWindowBlurOrHide);
                document.removeEventListener('selectionchange', onSelectionChange);
            }
        };
    }

    return () => {
        globalTouchResetListeners.delete(onTouchStartReset);
        globalListenerRefs = Math.max(0, globalListenerRefs - 1);
        if (globalListenerRefs === 0) {
            cancelTouchReleaseTimer();
            detachGlobalTouchCoordinator?.();
            detachGlobalTouchCoordinator = null;
            globalActiveTouchCount = 0;
            globalTouchSuppressed = false;
            globalLastTouchActivityAt = 0;
            globalPrimaryMouseDown = false;
            globalLastPrimaryActivityAt = 0;
            globalLastMenuClosedAt = 0;
            globalLastMousePoint = { x: 0, y: 0 };
            globalLastFocusChangeAt = 0;
            globalLastInputActivityAt = 0;
            globalLastKeyActivityAt = 0;
            globalLastDomSelection = EMPTY_DOM_SELECTION;
            controlSelectionSnapshots = new WeakMap();
            globalActiveTouchPointers.clear();
        }
    };
}

function suppressTrailingGestureClick(): () => void {
    if (typeof window === 'undefined') return () => {};
    let timer: ReturnType<typeof setTimeout> | null = null;
    const hasPointerEvents = typeof window.PointerEvent === 'function';
    const cleanup = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        window.removeEventListener('click', onClickCapture, true);
        window.removeEventListener('pointerdown', onNewPrimaryPress, true);
        window.removeEventListener('touchstart', onNewTouchPress, true);
        if (!hasPointerEvents) {
            window.removeEventListener('mousedown', onNewPrimaryPress, true);
        }
    };
    const onNewPrimaryPress = (event: MouseEvent) => {
        if (isSecondaryPressEvent(event)) return;
        cleanup();
    };
    const onNewTouchPress = () => {
        cleanup();
    };
    const onClickCapture = (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        cleanup();
    };
    window.addEventListener('click', onClickCapture, true);
    window.addEventListener('pointerdown', onNewPrimaryPress, true);
    window.addEventListener('touchstart', onNewTouchPress, true);
    if (!hasPointerEvents) {
        window.addEventListener('mousedown', onNewPrimaryPress, true);
    }
    timer = setTimeout(cleanup, 600);
    return cleanup;
}

export interface WebSecondaryContextMenuOptions {
    disabled?: boolean;
    isOpen: boolean;
    onClose: () => void;
    onOpenAt: (point: { x: number; y: number }) => void;
}

export interface WebSecondaryContextMenuResult {
    armClickSuppression: () => void;
    closeMenu: () => void;
    contextHitOverlay: React.ReactNode;
    hoverMenuProps: Record<string, unknown>;
    lastPointerTypeRef: React.MutableRefObject<string | null>;
    openMenuAt: (point: { x: number; y: number }) => void;
    outerMenuProps: Record<string, unknown>;
    pointRef: React.MutableRefObject<{ x: number; y: number }>;
}

const handleHitOverlayClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
};

const handleHitOverlayAuxClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.button === 1) {
        event.preventDefault();
    }
};

const handleHitOverlayDragStart = (event: React.DragEvent<HTMLAnchorElement>) => {
    event.preventDefault();
};

export function useWebSecondaryContextMenu({
    disabled = false,
    isOpen,
    onClose,
    onOpenAt,
}: WebSecondaryContextMenuOptions): WebSecondaryContextMenuResult {
    const hoverPointRef = React.useRef({ x: 0, y: 0 });
    const pointRef = React.useRef({ x: 0, y: 0 });
    const lastPointerTypeRef = React.useRef<string | null>(null);
    const isRowHoveredRef = React.useRef(false);
    const isOpenRef = React.useRef(isOpen);
    isOpenRef.current = isOpen;
    const primaryPressActiveRef = React.useRef(false);
    const lastPrimaryPressAtRef = React.useRef(0);
    const secondaryPendingRef = React.useRef(false);
    const secondaryPointRef = React.useRef({ x: 0, y: 0 });
    const secondaryOpenedAtRef = React.useRef(0);
    const secondaryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const cleanupClickGuardRef = React.useRef<(() => void) | null>(null);
    const hitOverlayNodeRef = React.useRef<HTMLAnchorElement | null>(null);
    const hitOverlayCleanupRef = React.useRef<(() => void) | null>(null);

    const onCloseRef = React.useRef(onClose);
    onCloseRef.current = onClose;
    const onOpenAtRef = React.useRef(onOpenAt);
    onOpenAtRef.current = onOpenAt;

    const clearSecondaryPending = React.useCallback(() => {
        secondaryPendingRef.current = false;
        if (secondaryTimerRef.current) {
            clearTimeout(secondaryTimerRef.current);
            secondaryTimerRef.current = null;
        }
    }, []);

    const armClickSuppression = React.useCallback(() => {
        cleanupClickGuardRef.current?.();
        cleanupClickGuardRef.current = suppressTrailingGestureClick();
    }, []);

    const closeSelf = React.useCallback(() => {
        secondaryOpenedAtRef.current = 0;
        onCloseRef.current();
    }, []);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || disabled) return undefined;
        return retainGlobalTouchCoordinator(() => {
            primaryPressActiveRef.current = false;
        });
    }, [disabled]);

    React.useEffect(() => () => {
        if (activeSessionMenuCloser === closeSelf) {
            activeSessionMenuCloser = null;
        }
        clearSecondaryPending();
        cleanupClickGuardRef.current?.();
        hitOverlayCleanupRef.current?.();
    }, [clearSecondaryPending, closeSelf]);

    const openAt = React.useCallback((point: { x: number; y: number }) => {
        if (disabled) return;
        if (activeSessionMenuCloser && activeSessionMenuCloser !== closeSelf) {
            activeSessionMenuCloser();
        }
        activeSessionMenuCloser = closeSelf;
        secondaryOpenedAtRef.current = Date.now();
        onOpenAtRef.current(point);
    }, [closeSelf, disabled]);

    const closeMenu = React.useCallback(() => {
        if (activeSessionMenuCloser === closeSelf) {
            activeSessionMenuCloser = null;
        }
        globalLastMenuClosedAt = Date.now();
        scheduleSelectionBaselineRefresh();
        closeSelf();
    }, [closeSelf]);

    const handleContextMenu = React.useCallback((event: any) => {
        if (disabled) return;
        clearSecondaryPending();
        event.preventDefault?.();
        event.stopPropagation?.();
        armClickSuppression();
        const point = readEventPoint(event);
        openAt(
            point.x > 0 || point.y > 0
                ? point
                : resolveOverlayAnchorPoint(hitOverlayNodeRef.current, hoverPointRef.current),
        );
    }, [armClickSuppression, clearSecondaryPending, disabled, openAt]);

    const handlePointerHover = React.useCallback((event: any) => {
        const ne = event?.nativeEvent ?? event;
        const pointerType = typeof ne?.pointerType === 'string' ? ne.pointerType : null;
        if (pointerType) {
            lastPointerTypeRef.current = pointerType;
        }
        if (pointerType !== 'mouse' || isAnyTouchActive()) {
            return;
        }
        const now = Date.now();
        if (globalTouchSuppressed && now - globalLastTouchActivityAt < POST_TOUCH_SUPPRESS_RELEASE_MS) {
            return;
        }
        const point = readEventPoint(event);
        // Ignore synthetic (-1, -1) emitted when iPadOS cancels WKMouseHover.
        if (point.x > 0 || point.y > 0) {
            hoverPointRef.current = point;
            pointRef.current = point;
            globalLastMousePoint = point;
            isRowHoveredRef.current = true;
            if (hitOverlayNodeRef.current) {
                globalHoveredOverlay = hitOverlayNodeRef.current;
            }
        }
        const buttons = typeof ne?.buttons === 'number' ? ne.buttons : 0;
        if ((buttons & 1) === 1 && !ne?.ctrlKey) {
            primaryPressActiveRef.current = true;
            lastPrimaryPressAtRef.current = Date.now();
            return;
        }
        if (buttons === 0) {
            primaryPressActiveRef.current = false;
            if (globalTouchSuppressed) {
                cancelTouchReleaseTimer();
                globalTouchSuppressed = false;
                setAllHitOverlaysInert(false);
            }
        }
    }, []);

    const handlePointerLeave = React.useCallback((event: any) => {
        const ne = event?.nativeEvent ?? event;
        if (typeof ne?.pointerType === 'string' && ne.pointerType !== 'mouse') {
            return;
        }
        primaryPressActiveRef.current = false;
        const point = readEventPoint(event);
        if (point.x > 0 || point.y > 0) {
            isRowHoveredRef.current = false;
            if (globalHoveredOverlay === hitOverlayNodeRef.current) {
                globalHoveredOverlay = null;
            }
        }
    }, []);

    const beginSecondaryPress = React.useCallback((event: any, point: { x: number; y: number }) => {
        if (disabled) return;
        event.stopPropagation?.();
        if (point.x > 0 || point.y > 0) {
            secondaryPointRef.current = point;
        } else {
            secondaryPointRef.current = resolveOverlayAnchorPoint(hitOverlayNodeRef.current, hoverPointRef.current);
        }
        if (secondaryPendingRef.current) {
            return;
        }
        secondaryPendingRef.current = true;
        if (secondaryTimerRef.current) {
            clearTimeout(secondaryTimerRef.current);
        }
        secondaryTimerRef.current = setTimeout(() => {
            secondaryTimerRef.current = null;
            if (!secondaryPendingRef.current) return;
            secondaryPendingRef.current = false;
            armClickSuppression();
            openAt(secondaryPointRef.current);
        }, SECONDARY_CONTEXTMENU_FALLBACK_MS);
    }, [armClickSuppression, disabled, openAt]);

    const handlePointerDown = React.useCallback((event: any) => {
        const ne = event?.nativeEvent ?? event;
        const pointerType = typeof ne?.pointerType === 'string' ? ne.pointerType : null;
        lastPointerTypeRef.current = pointerType;
        const point = readEventPoint(event);
        if (point.x > 0 || point.y > 0) {
            pointRef.current = point;
        }
        if (pointerType === 'mouse' && (point.x > 0 || point.y > 0)) {
            hoverPointRef.current = point;
            globalLastMousePoint = point;
            isRowHoveredRef.current = true;
            if (hitOverlayNodeRef.current) {
                globalHoveredOverlay = hitOverlayNodeRef.current;
            }
        }
        if (isSecondaryPressEvent(event)) {
            primaryPressActiveRef.current = false;
            beginSecondaryPress(event, point);
            return;
        }
        const isMouseLike = pointerType === null || pointerType === 'mouse';
        if (isMouseLike && !globalTouchSuppressed && !isAnyTouchActive() && ne?.button === 0 && !ne?.ctrlKey) {
            primaryPressActiveRef.current = true;
            lastPrimaryPressAtRef.current = Date.now();
        }
    }, [beginSecondaryPress]);

    const handleMouseDown = React.useCallback((event: any) => {
        const ne = event?.nativeEvent ?? event;
        const point = readEventPoint(event);
        if (isSecondaryPressEvent(event)) {
            primaryPressActiveRef.current = false;
            beginSecondaryPress(event, point);
            return;
        }
        if (globalTouchSuppressed || isAnyTouchActive()) {
            return;
        }
        if (ne?.button === 0 && !ne?.ctrlKey) {
            primaryPressActiveRef.current = true;
            lastPrimaryPressAtRef.current = Date.now();
        }
    }, [beginSecondaryPress]);

    const handleSecondaryRelease = React.useCallback((event: any) => {
        const ne = event?.nativeEvent ?? event;
        const pointerType = typeof ne?.pointerType === 'string' ? ne.pointerType : null;
        if (ne?.button === 0 && !ne?.ctrlKey && !secondaryPendingRef.current) {
            primaryPressActiveRef.current = false;
            if ((pointerType === null || pointerType === 'mouse') && !globalTouchSuppressed && !isAnyTouchActive()) {
                lastPrimaryPressAtRef.current = Date.now();
            }
            return;
        }
        if (!secondaryPendingRef.current && !isSecondaryPressEvent(event)) {
            return;
        }
        const wasPending = secondaryPendingRef.current;
        clearSecondaryPending();
        event.preventDefault?.();
        event.stopPropagation?.();
        if (disabled) return;
        armClickSuppression();
        const recentlyOpened = secondaryOpenedAtRef.current > 0
            && Date.now() - secondaryOpenedAtRef.current < SECONDARY_DEDUPE_MS;
        if (!wasPending && (isOpenRef.current || recentlyOpened)) {
            return;
        }
        const point = readEventPoint(event);
        openAt(point.x > 0 || point.y > 0 ? point : secondaryPointRef.current);
    }, [armClickSuppression, clearSecondaryPending, disabled, openAt]);

    const handlePointerCancel = React.useCallback(() => {
        primaryPressActiveRef.current = false;
        clearSecondaryPending();
    }, [clearSecondaryPending]);

    const openFromOverlayProbe = React.useCallback((overlayNode: HTMLElement | null) => {
        if (disabled) return;
        const lastPrimaryAt = lastPrimaryPressAtRef.current;
        if (
            globalTouchSuppressed
            || isAnyTouchActive()
            || globalPrimaryMouseDown
            || primaryPressActiveRef.current
            || (lastPrimaryAt > 0 && Date.now() - lastPrimaryAt < PRIMARY_PRESS_SELECTSTART_GUARD_MS)
        ) {
            return;
        }
        const recentlyOpened = secondaryOpenedAtRef.current > 0
            && Date.now() - secondaryOpenedAtRef.current < SECONDARY_DEDUPE_MS;
        if (secondaryPendingRef.current || isOpenRef.current || recentlyOpened) {
            return;
        }
        const point = resolveOverlayAnchorPoint(overlayNode ?? hitOverlayNodeRef.current, hoverPointRef.current);
        armClickSuppression();
        openAt(point);
    }, [armClickSuppression, disabled, openAt]);

    const openFromOverlayProbeRef = React.useRef(openFromOverlayProbe);
    openFromOverlayProbeRef.current = openFromOverlayProbe;

    const handleSelectStart = React.useCallback((event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        const overlayNode = event.currentTarget instanceof HTMLElement
            ? event.currentTarget
            : hitOverlayNodeRef.current;
        openFromOverlayProbeRef.current(overlayNode);
    }, []);

    const handleSelectStartRef = React.useRef(handleSelectStart);
    handleSelectStartRef.current = handleSelectStart;

    const attachHitOverlayRef = React.useCallback((node: HTMLAnchorElement | null) => {
        hitOverlayCleanupRef.current?.();
        hitOverlayCleanupRef.current = null;
        hitOverlayNodeRef.current = node;
        if (!node) return;
        const inert = globalTouchSuppressed || isAnyTouchActive();
        syncHitOverlayNodeState(node, inert);
        const listener = (event: Event) => handleSelectStartRef.current(event);
        node.addEventListener('selectstart', listener);
        registeredHitOverlays.set(node, {
            openFromSelectionProbe: (targetOverlay) => openFromOverlayProbeRef.current(targetOverlay),
        });
        if (isRowHoveredRef.current) {
            globalHoveredOverlay = node;
        }
        hitOverlayCleanupRef.current = () => {
            node.removeEventListener('selectstart', listener);
            registeredHitOverlays.delete(node);
            if (globalHoveredOverlay === node) {
                globalHoveredOverlay = null;
            }
        };
    }, []);

    const outerMenuProps = React.useMemo(() => (
        Platform.OS === 'web' && !disabled
            ? {
                onContextMenu: handleContextMenu,
                onPointerMove: handlePointerHover,
                onPointerDown: handlePointerDown,
                onPointerUp: handleSecondaryRelease,
                onPointerCancel: handlePointerCancel,
                onMouseDown: handleMouseDown,
                onMouseUp: handleSecondaryRelease,
                onAuxClick: handleSecondaryRelease,
            }
            : {}
    ), [
        disabled,
        handleContextMenu,
        handlePointerHover,
        handlePointerDown,
        handleSecondaryRelease,
        handlePointerCancel,
        handleMouseDown,
    ]);

    const hoverMenuProps = React.useMemo(() => (
        Platform.OS === 'web' && !disabled
            ? {
                ...outerMenuProps,
                onPointerEnter: handlePointerHover,
                onPointerLeave: handlePointerLeave,
            }
            : {}
    ), [disabled, outerMenuProps, handlePointerHover, handlePointerLeave]);

    const contextHitOverlay = React.useMemo(() => (
        Platform.OS === 'web' && !disabled && !isOpen
            ? React.createElement(
                'a',
                {
                    ref: attachHitOverlayRef,
                    tabIndex: -1,
                    draggable: false,
                    'aria-hidden': true,
                    'data-lmc-context-hit': '',
                    'data-yulor-interaction': 'none',
                    onClick: handleHitOverlayClick,
                    onAuxClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
                        handleHitOverlayAuxClick(event);
                        handleSecondaryRelease(event);
                    },
                    onContextMenu: handleContextMenu,
                    onPointerEnter: handlePointerHover,
                    onPointerMove: handlePointerHover,
                    onPointerLeave: handlePointerLeave,
                    onPointerDown: handlePointerDown,
                    onPointerUp: handleSecondaryRelease,
                    onPointerCancel: handlePointerCancel,
                    onMouseDown: handleMouseDown,
                    onMouseUp: handleSecondaryRelease,
                    onDragStart: handleHitOverlayDragStart,
                    style: CONTEXT_HIT_OVERLAY_STYLE,
                },
                CONTEXT_HIT_OVERLAY_TEXT,
            )
            : null
    ), [
        attachHitOverlayRef,
        disabled,
        handleContextMenu,
        handleMouseDown,
        handlePointerCancel,
        handlePointerDown,
        handlePointerHover,
        handlePointerLeave,
        handleSecondaryRelease,
        isOpen,
    ]);

    return {
        armClickSuppression,
        closeMenu,
        contextHitOverlay,
        hoverMenuProps,
        lastPointerTypeRef,
        openMenuAt: openAt,
        outerMenuProps,
        pointRef,
    };
}

export interface SessionRowMenu {
    anchor: SessionActionsAnchor | null;
    closeMenu: () => void;
    /** Invisible hit overlay rendered inside Web session rows while the actions menu is closed. */
    contextHitOverlay: React.ReactNode;
    menuProps: Record<string, unknown>;
    /** Secondary/hover handlers safe to spread on an outer wrapper View without duplicating Pressable long-press. */
    outerMenuProps: Record<string, unknown>;
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
    const isTouchRef = React.useRef(false);

    const handleClose = React.useCallback(() => {
        setAnchor(null);
    }, []);

    const handleOpenAt = React.useCallback((point: { x: number; y: number }) => {
        setAnchor({ type: 'point', x: point.x, y: point.y });
    }, []);

    const {
        armClickSuppression,
        closeMenu,
        contextHitOverlay,
        hoverMenuProps,
        lastPointerTypeRef,
        openMenuAt,
        outerMenuProps,
        pointRef,
    } = useWebSecondaryContextMenu({
        isOpen: anchor !== null,
        onClose: handleClose,
        onOpenAt: handleOpenAt,
    });

    // The long press event itself carries no coordinates, so the anchor comes
    // from where the press started.
    const handlePressIn = React.useCallback((event: any) => {
        const point = readEventPoint(event);
        if (point.x > 0 || point.y > 0) {
            pointRef.current = point;
        }
        // Sortable Web rows arbitrate stationary long-press vs drag and dispatch
        // the context menu directly. Do not open a competing menu.
        const target = event.nativeEvent?.target ?? event.target;
        const sortable = target && typeof target.closest === 'function' && target.closest('[data-session-sort-id]');
        const touchLike = isTouchInteraction(event)
            || (lastPointerTypeRef.current !== null && lastPointerTypeRef.current !== 'mouse');
        isTouchRef.current = touchLike && !sortable;
    }, [lastPointerTypeRef, pointRef]);

    const handleLongPress = React.useCallback(() => {
        if (!isTouchRef.current) {
            return;
        }
        armClickSuppression();
        openMenuAt(pointRef.current);
    }, [armClickSuppression, openMenuAt, pointRef]);

    const showActionAlert = useSessionActionAlertWithCollaboration(sessionId);

    const menuProps = React.useMemo(() => (
        Platform.OS === 'web'
            ? {
                ...hoverMenuProps,
                onPressIn: handlePressIn,
                onLongPress: handleLongPress,
                delayLongPress: LONG_PRESS_DELAY_MS,
            }
            : {
                onLongPress: showActionAlert,
            }
    ), [
        hoverMenuProps,
        handlePressIn,
        handleLongPress,
        showActionAlert,
    ]);

    return { anchor, closeMenu, contextHitOverlay, menuProps, outerMenuProps, openMenuAt };
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
