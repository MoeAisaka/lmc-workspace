/** Layout width must not follow visualViewport (keyboard / pinch zoom). */
export function usesNativeWebKitKeyboardPan(): boolean {
    if (typeof navigator === 'undefined') return false;
    return /AppleWebKit/i.test(navigator.userAgent)
        && (/iPad|iPhone|iPod/i.test(navigator.userAgent)
            || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
}

export function readBrowserLayoutWidth(): number {
    if (typeof window === 'undefined') return 0;
    return document.documentElement.clientWidth || window.innerWidth;
}

/** Rotation can be announced before WebKit has settled its layout viewport. */
export function subscribeBrowserLayoutViewport(onChange: () => void): () => void {
    if (typeof window === 'undefined') return () => {};
    let timers: ReturnType<typeof setTimeout>[] = [];
    const refresh = () => {
        timers.forEach(clearTimeout);
        onChange();
        // Bounded trailing measurements also cover foreground restoration.
        timers = [100, 300, 700].map(delay => setTimeout(onChange, delay));
    };
    const visible = () => { if (document.visibilityState !== 'hidden') refresh(); };
    const events = ['resize', 'orientationchange', 'pageshow', 'focus'] as const;
    events.forEach(event => window.addEventListener(event, refresh));
    document.addEventListener('visibilitychange', visible);
    window.visualViewport?.addEventListener('resize', refresh);
    return () => {
        timers.forEach(clearTimeout);
        events.forEach(event => window.removeEventListener(event, refresh));
        document.removeEventListener('visibilitychange', visible);
        window.visualViewport?.removeEventListener('resize', refresh);
    };
}

/** pageTop is in document coordinates. Some iOS embedders report the document
 * scroll again in offsetTop, so combining offsetTop with a client rect counts
 * the same pan twice. Preserve ordinary visual-only panning as well. */
export function readVisualViewportPageTop(viewport: VisualViewport): number {
    // In a resized layout viewport, client coordinates already use its visible
    // origin. iOS Edge nevertheless repeats the document pan in visual offsets,
    // and pageTop can lag scrollY by several pixels during IME caret reveals.
    // Use the document scroll from the same coordinate space as the body top.
    // Visual-only keyboards (innerHeight still equals clientHeight) retain the
    // standard pageTop path, including a genuine visual viewport offset.
    const layoutResized = window.innerHeight > 0
        && document.documentElement.clientHeight > window.innerHeight + 1
        && Math.abs(viewport.scale - 1) <= 0.05;
    if (layoutResized) return window.scrollY;
    return Number.isFinite(viewport.pageTop) ? viewport.pageTop : window.scrollY + viewport.offsetTop;
}

/** Keep responsive width independent of the keyboard. Height belongs to CSS
 * dvh, which follows browser chrome without chasing keyboard/caret offsets.
 * Only the composer handles visual viewport occlusion; never move the body. */
export function installBrowserLayoutSizing(): () => void {
    const root = document.documentElement;
    const update = () => {
        const width = readBrowserLayoutWidth();
        if (width > 0) {
            const value = `${width}px`;
            if (root.style.getPropertyValue('--lmc-layout-width') !== value) {
                root.style.setProperty('--lmc-layout-width', value);
            }
        }
    };
    update();
    const unsubscribe = subscribeBrowserLayoutViewport(update);
    return () => {
        unsubscribe();
        root.style.removeProperty('--lmc-layout-width');
    };
}

/**
 * The height a full-height overlay may use.
 *
 * React Native's window height on web is the *visual* viewport, which iOS
 * shrinks for the keyboard — and which Safari has been seen to leave at a
 * small stale value with no keyboard on screen: the phone drawer collapsed to
 * a 20px strip and the shared launcher jumped to the top of the page
 * (2026-10-09). The layout viewport is what the app shell is actually sized
 * to, so it is the truth whenever no field is being edited; only while one is
 * may the visual height take anything away.
 */
export function overlayHeight(visualHeight: number, layoutHeight: number, editing: boolean): number {
    if (!(layoutHeight > 0)) return visualHeight;
    if (!editing) return layoutHeight;
    return visualHeight > 0 ? Math.min(visualHeight, layoutHeight) : layoutHeight;
}

function isEditing(): boolean {
    const active = document.activeElement as HTMLElement | null;
    return !!active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable);
}

/** Layout height and whether a field has focus, kept current; null off the web. */
export function readOverlayViewport(): { layoutHeight: number; editing: boolean } | null {
    if (typeof document === 'undefined') return null;
    return { layoutHeight: document.documentElement.clientHeight, editing: isEditing() };
}

export function subscribeOverlayViewport(onChange: () => void): () => void {
    if (typeof document === 'undefined') return () => {};
    const stop = subscribeBrowserLayoutViewport(onChange);
    document.addEventListener('focusin', onChange);
    document.addEventListener('focusout', onChange);
    return () => { stop(); document.removeEventListener('focusin', onChange); document.removeEventListener('focusout', onChange); };
}
