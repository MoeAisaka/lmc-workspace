import * as React from 'react';
import { Platform } from 'react-native';

/**
 * Opening a session from the list grows it out of the row that was pressed:
 * the previous session's body is kept underneath as a snapshot, and the new
 * one spreads over it as a circle centred on the pane's edge at that row's
 * height, until it covers the pane; the old body dims, blurs from halfway, and
 * the spreading edge is traced as a thin, very light grey line.
 * Web only (clip-path and a transform-scaled ring, Web Animations); other
 * platforms and reduced motion keep the plain fade in SessionContentEnter.
 */
export const SESSION_REVEAL = {
    // Owner kept finding it fast; the radius is 1000+ px, so length matters more than the curve.
    // 850 ms felt right in pace; then asked for 20% faster (850 / 1.2).
    durationMs: 710,
    // Fast out of the row, long gentle settle (Owner: 先快后慢; initial speed halved, then cut by another 25%).
    easing: 'cubic-bezier(0.16, 0.375, 0.3, 1)',
    freshMs: 1200,
    /** How far the covered body dims by the end. */
    dimTo: 0.6,
    /**
     * The covered body blurs once the circle has covered half of it (Owner:
     * 切换到 50% 时出现模糊), reaching full blur by 80%. Offsets are fractions
     * of the duration where the easing reaches those radii.
     */
    blurPx: 5,
    blurFrom: 0.212,
    blurFull: 0.437,
    /** The spreading edge: a very light grey (Owner found the brand blue too loud). */
    edgeColor: { light: '#F1F1F3', dark: 'rgba(255,255,255,0.07)' },
    /** Line width of the edge; also the margin added to the covering radius. */
    edgeLinePx: 2,
    edgeGlowPx: 2,
} as const;

let origin: { x: number; y: number; at: number; snapshot: HTMLElement | null } | null = null;
/** The pane carries this marker so a press can snapshot what it is about to cover. */
export const SESSION_PANE_DATASET = { lmcSessionPane: 'true' } as const;
let lastRevealAt = 0;
let listening = false;

function listen() {
    if (listening || Platform.OS !== 'web' || typeof document === 'undefined') return;
    listening = true;
    document.addEventListener('pointerdown', (event) => {
        const target = event.target as Element | null;
        if (target?.closest?.('.happy-sort-row, [data-hub-sort-id]')) {
            const pane = document.querySelector<HTMLElement>('[data-lmc-session-pane]');
            const snapshot = pane ? pane.cloneNode(true) as HTMLElement : null;
            snapshot?.removeAttribute('data-lmc-session-pane');
            // A press right after the previous switch can catch that session's
            // own fade-in part way; the snapshot shows it fully arrived.
            snapshot?.querySelectorAll<HTMLElement>('[data-testid="session-content-enter"]').forEach((node) => {
                node.style.opacity = '1';
                node.style.transform = 'none';
            });
            origin = { x: event.clientX, y: event.clientY, at: Date.now(), snapshot };
        }
    }, { capture: true, passive: true });
}

// Installed on import so the very first press, before any session pane
// exists, is already recorded.
listen();

/** The first opaque background up the tree — what the pane is drawn on. */
function opaqueBackground(from: HTMLElement | null): string {
    for (let node = from; node; node = node.parentElement) {
        const colour = getComputedStyle(node).backgroundColor;
        if (colour && colour !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(colour)) return colour;
    }
    return getComputedStyle(document.body).backgroundColor || '#fff';
}

function isDark(colour: string): boolean {
    const m = colour.match(/\d+(\.\d+)?/g);
    if (!m || m.length < 3) return false;
    const [r, g, b] = m.slice(0, 3).map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

/** True while a reveal is playing, so the inner fade does not stack on it. */
export function revealJustPlayed(): boolean {
    return Date.now() - lastRevealAt < SESSION_REVEAL.durationMs;
}

export function useSessionReveal(ref: React.RefObject<unknown>, sessionId: string): void {
    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web' || !origin || Date.now() - origin.at > SESSION_REVEAL.freshMs) return;
        const press = origin;
        origin = null;
        const element = ref.current as HTMLElement | null;
        if (!element || typeof element.animate !== 'function') return;
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
        const rect = element.getBoundingClientRect();
        // The press is in the list, often hundreds of pixels left of this
        // pane; centred there the circle is so large its edge sweeps across
        // as a near-straight line. Pin the centre to the pane's own edge at
        // the pressed row's height so the curve reads as a circle.
        const x = Math.min(Math.max(press.x - rect.left, 0), rect.width);
        const y = Math.min(Math.max(press.y - rect.top, 0), rect.height);
        const radius = Math.max(
            Math.hypot(x, y), Math.hypot(rect.width - x, y),
            Math.hypot(x, rect.height - y), Math.hypot(rect.width - x, rect.height - y),
        ) + SESSION_REVEAL.edgeGlowPx;
        lastRevealAt = Date.now();
        // The old body stays underneath, exactly where it was, so the circle
        // visibly covers it rather than opening onto an empty background.
        const under = press.snapshot;
        if (under && element.parentElement) {
            Object.assign(under.style, {
                position: 'absolute', left: `${element.offsetLeft}px`, top: `${element.offsetTop}px`,
                width: `${element.offsetWidth}px`, height: `${element.offsetHeight}px`,
                margin: '0', pointerEvents: 'none', overflow: 'hidden',
                // A fixed dim: animating it made every frame repaint the snapshot.
                opacity: String(SESSION_REVEAL.dimTo),
            });
            under.setAttribute('aria-hidden', 'true');
            element.parentElement.insertBefore(under, element);
        }
        // The pane is transparent over the screen colour; inside the circle it
        // must hide the snapshot, so it borrows that colour while revealing.
        const previousBackground = element.style.backgroundColor;
        if (under) element.style.backgroundColor = opaqueBackground(element.parentElement);
        // Clip-path, not a gradient mask: a mask re-rasterises the whole pane
        // (and the snapshot under it) every frame, which dropped frames.
        const style = element.style;
        const previousWillChange = style.willChange;
        style.willChange = 'clip-path';
        let cleared = false;
        const clear = () => {
            if (cleared) return;
            cleared = true;
            style.clipPath = '';
            style.willChange = previousWillChange;
            element.style.backgroundColor = previousBackground;
            under?.remove();
            ring.remove();
        };
        // The edge is a real ring element grown by transform, which the
        // compositor animates without repainting anything.
        const ring = document.createElement('div');
        const c = isDark(element.style.backgroundColor || opaqueBackground(element.parentElement))
            ? SESSION_REVEAL.edgeColor.dark : SESSION_REVEAL.edgeColor.light;
        const r = Math.ceil(radius);
        Object.assign(ring.style, {
            position: 'absolute', left: `${x - r}px`, top: `${y - r}px`,
            width: `${r * 2}px`, height: `${r * 2}px`, borderRadius: '50%', boxSizing: 'border-box',
            border: `${SESSION_REVEAL.edgeLinePx}px solid ${c}`,
            pointerEvents: 'none', zIndex: '2', willChange: 'transform, opacity', transform: 'scale(0)',
        });
        ring.setAttribute('aria-hidden', 'true');
        // The ring's box can reach far outside the pane; keep it to the pane.
        const ringClip = document.createElement('div');
        Object.assign(ringClip.style, {
            position: 'absolute', left: `${element.offsetLeft}px`, top: `${element.offsetTop}px`,
            width: `${element.offsetWidth}px`, height: `${element.offsetHeight}px`,
            overflow: 'hidden', pointerEvents: 'none', zIndex: '2',
        });
        ringClip.setAttribute('aria-hidden', 'true');
        ringClip.appendChild(ring);
        element.parentElement?.insertBefore(ringClip, element.nextSibling);
        const removeRing = ring.remove.bind(ring);
        ring.remove = () => { removeRing(); ringClip.remove(); };
        const start = () => {
            if (cleared) return;
            if (under) {
                under.style.willChange = 'filter';
                under.animate([
                    { filter: 'blur(0px)', offset: 0 },
                    { filter: 'blur(0px)', offset: SESSION_REVEAL.blurFrom },
                    { filter: `blur(${SESSION_REVEAL.blurPx}px)`, offset: SESSION_REVEAL.blurFull },
                    { filter: `blur(${SESSION_REVEAL.blurPx}px)`, offset: 1 },
                ], { duration: SESSION_REVEAL.durationMs, fill: 'forwards' });
            }
            ring.animate([
                { transform: 'scale(0)', opacity: 1, offset: 0 },
                { opacity: 1, offset: 0.7 },
                { transform: 'scale(1)', opacity: 0, offset: 1 },
            ], { duration: SESSION_REVEAL.durationMs, easing: SESSION_REVEAL.easing, fill: 'forwards' });
            const animation = element.animate([
                { clipPath: `circle(0px at ${x}px ${y}px)` },
                { clipPath: `circle(${r}px at ${x}px ${y}px)` },
            ], { duration: SESSION_REVEAL.durationMs, easing: SESSION_REVEAL.easing, fill: 'forwards' });
            animation.onfinish = clear;
            animation.oncancel = clear;
            // Never leave the pane masked or the snapshot behind.
            setTimeout(clear, SESSION_REVEAL.durationMs + 250);
        };
        start();
    }, [ref, sessionId]);
}
