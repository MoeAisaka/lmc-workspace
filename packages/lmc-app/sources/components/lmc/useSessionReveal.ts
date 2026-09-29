import * as React from 'react';
import { Platform } from 'react-native';

/**
 * Opening a session from the list grows it out of the row that was pressed:
 * the previous session's body is kept underneath as a snapshot, and the new
 * one spreads over it as a circle centred on the pane's edge at that row's
 * height, until it covers the pane, its rows springing in newest first; the
 * old body dims, blurs from halfway, and
 * the spreading edge is traced as a thin, very light grey line.
 * Web only (clip-path and a transform-scaled ring, Web Animations); other
 * platforms and reduced motion keep the plain fade in SessionContentEnter.
 */
export const SESSION_REVEAL = {
    // Owner kept finding it fast; the radius is 1000+ px, so length matters more than the curve.
    // 850 ms felt right in pace; then asked for 20% faster (850 / 1.2).
    durationMs: 710,
    // Fast out of the row, long gentle settle (Owner: 先快后慢; initial speed halved, then cut by another 25%).
    easing: [0.16, 0.375, 0.3, 1] as const,
    freshMs: 1200,
    /** Longest the reveal waits for the new body to mount before copying it. */
    maxWaitMs: 250,
    /** How far the covered body dims by the end. */
    dimTo: 0.6,
    /**
     * The covered body blurs once the circle has covered half of it (Owner:
     * 切换到 50% 时出现模糊), reaching full blur by 80%. Offsets are fractions
     * of the duration where the easing reaches those radii.
     */
    blurPx: 5,
    /** Rows rise into the circle newest first, on a spring (Owner chose option D). */
    rowStaggerMs: 40,
    rowDelayMs: 60,
    rowMax: 8,
    rowRisePx: 18,
    blurFrom: 0.212,
    blurFull: 0.437,
    /** The spreading edge: a very light grey (Owner found the brand blue too loud). */
    edgeColor: { light: '#F1F1F3', dark: 'rgba(255,255,255,0.07)' },
    /** Line width of the edge; also the margin added to the covering radius. */
    edgeLinePx: 2,
    edgeGlowPx: 2,
} as const;

let origin: { x: number; y: number; at: number; snapshot: HTMLElement | null; snapshotScroll: ScrollOffsets } | null = null;
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
            const snapshotScroll = pane ? readScroll(pane) : [];
            snapshot?.removeAttribute('data-lmc-session-pane');
            // A press right after the previous switch can catch that session's
            // own fade-in part way; the snapshot shows it fully arrived.
            snapshot?.querySelectorAll<HTMLElement>('[data-testid="session-content-enter"]').forEach((node) => {
                node.style.opacity = '1';
                node.style.transform = 'none';
            });
            origin = { x: event.clientX, y: event.clientY, at: Date.now(), snapshot, snapshotScroll };
        }
    }, { capture: true, passive: true });
}

// Installed on import so the very first press, before any session pane
// exists, is already recorded.
listen();

/**
 * Scroll offsets are not part of the DOM and do not clone: a copied list sits
 * at its top, then jumps when the real one takes over. Record them from the
 * source and replay them on the copy once it is in the document.
 */
type ScrollOffsets = Array<[number, number, number]>;
function readScroll(root: HTMLElement): ScrollOffsets {
    const out: ScrollOffsets = [];
    [root, ...root.querySelectorAll<HTMLElement>('*')].forEach((node, index) => {
        if (node.scrollTop || node.scrollLeft) out.push([index, node.scrollTop, node.scrollLeft]);
    });
    return out;
}
function applyScroll(root: HTMLElement, offsets: ScrollOffsets): void {
    if (!offsets.length) return;
    const nodes = [root, ...root.querySelectorAll<HTMLElement>('*')];
    for (const [index, top, left] of offsets) {
        const node = nodes[index];
        if (node) { node.scrollTop = top; node.scrollLeft = left; }
    }
}

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

/**
 * A damped spring sampled into a CSS linear() easing, so the compositor can
 * run a spring (a little overshoot, then settle) like any other curve.
 */
function springEasing(stiffness: number, damping: number): { easing: string; duration: number } {
    let x = 0;
    let v = 0;
    let t = 0;
    const dt = 1 / 240;
    const points = [0];
    while (t < 3) {
        v += (-stiffness * (x - 1) - damping * v) * dt;
        x += v * dt;
        t += dt;
        if (Math.round(t * 240) % 4 === 0) points.push(x);
        if (t > 0.1 && Math.abs(x - 1) < 0.0008 && Math.abs(v) < 0.02) break;
    }
    points.push(1);
    return { easing: `linear(${points.map((p) => +p.toFixed(4)).join(', ')})`, duration: Math.round(t * 1000) };
}
let rowSpring: { easing: string; duration: number } | null = null;

/** The reveal's easing at time t (0..1): the cubic-bezier in SESSION_REVEAL.easing. */
function easeAt(t: number): number {
    const [x1, y1, x2, y2] = SESSION_REVEAL.easing;
    const bez = (a: number, b: number, s: number) => 3 * (1 - s) * (1 - s) * s * a + 3 * (1 - s) * s * s * b + s * s * s;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        if (bez(x1, x2, mid) < t) lo = mid; else hi = mid;
    }
    return bez(y1, y2, (lo + hi) / 2);
}

/** True while a reveal is playing, so the inner fade does not stack on it. */
export function revealJustPlayed(): boolean {
    return Date.now() - lastRevealAt < SESSION_REVEAL.durationMs + SESSION_REVEAL.maxWaitMs + 600;
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
            applyScroll(under, press.snapshotScroll);
        }
        // Everything below animates only transform and opacity, which the
        // compositor runs without repainting: clip-path and a changing blur
        // radius repainted the whole pane every frame and stuttered.
        //
        // The new body is shown through a circular window: an outer circle
        // scaled up from nothing, holding a copy of the new pane scaled by the
        // inverse, so the content stays put while the circle grows.
        const r = Math.ceil(radius);
        const background = opaqueBackground(element.parentElement);
        const edge = isDark(background) ? SESSION_REVEAL.edgeColor.dark : SESSION_REVEAL.edgeColor.light;
        const layer = (extra: Partial<CSSStyleDeclaration>) => {
            const node = document.createElement('div');
            node.setAttribute('aria-hidden', 'true');
            Object.assign(node.style, {
                position: 'absolute', left: `${element.offsetLeft}px`, top: `${element.offsetTop}px`,
                width: `${element.offsetWidth}px`, height: `${element.offsetHeight}px`,
                overflow: 'hidden', pointerEvents: 'none', ...extra,
            });
            return node;
        };
        // Pre-blurred copy of the old body, faded in once half is covered:
        // fading a finished blur is cheap, animating the blur radius is not.
        let blurred: HTMLElement | null = null;
        if (under && element.parentElement) {
            blurred = under.cloneNode(true) as HTMLElement;
            Object.assign(blurred.style, { filter: `blur(${SESSION_REVEAL.blurPx}px)`, opacity: '0', willChange: 'opacity' });
            element.parentElement.insertBefore(blurred, element);
            applyScroll(blurred, press.snapshotScroll);
        }
        const stage = layer({ zIndex: '2' });
        const windowCircle = document.createElement('div');
        Object.assign(windowCircle.style, {
            position: 'absolute', left: `${x - r}px`, top: `${y - r}px`, width: `${r * 2}px`, height: `${r * 2}px`,
            borderRadius: '50%', overflow: 'hidden', background, willChange: 'transform', transform: 'scale(0)',
        });
        const ring = document.createElement('div');
        Object.assign(ring.style, {
            position: 'absolute', left: `${x - r}px`, top: `${y - r}px`, width: `${r * 2}px`, height: `${r * 2}px`,
            borderRadius: '50%', boxSizing: 'border-box', border: `${SESSION_REVEAL.edgeLinePx}px solid ${edge}`,
            willChange: 'transform, opacity', transform: 'scale(0)',
        });
        stage.appendChild(windowCircle);
        stage.appendChild(ring);
        element.parentElement?.insertBefore(stage, element.nextSibling);
        // The real pane waits hidden under the snapshot until the reveal ends.
        const style = element.style;
        const previousVisibility = style.visibility;
        style.visibility = 'hidden';
        let cleared = false;
        const clear = () => {
            if (cleared) return;
            cleared = true;
            style.visibility = previousVisibility;
            under?.remove();
            blurred?.remove();
            stage.remove();
        };
        const start = () => {
            if (cleared) return;
            // Copy the new body once it has mounted; the copy is what the
            // circle shows, so building the list never lands mid-animation.
            const copy = element.cloneNode(true) as HTMLElement;
            const copyScroll = readScroll(element);
            copy.removeAttribute('data-lmc-session-pane');
            // Form values are not attributes and do not clone; carry the draft.
            const sources = element.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('textarea, input');
            copy.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('textarea, input').forEach((field, index) => {
                const source = sources[index];
                if (source) field.value = source.value;
            });
            copy.querySelectorAll<HTMLElement>('[data-testid="session-content-enter"]').forEach((node) => {
                node.style.opacity = '1';
                node.style.transform = 'none';
            });
            Object.assign(copy.style, {
                position: 'absolute', left: `${r - x}px`, top: `${r - y}px`, margin: '0',
                width: `${element.offsetWidth}px`, height: `${element.offsetHeight}px`,
                visibility: 'visible', transformOrigin: `${x}px ${y}px`, willChange: 'transform',
            });
            windowCircle.appendChild(copy);
            applyScroll(copy, copyScroll);
            // Sample the easing so the circle and its counter-scaled content
            // stay exact inverses at every frame, not just at the ends.
            const steps = 24;
            const min = 1 / r;
            const outer: Keyframe[] = [];
            const inner: Keyframe[] = [];
            const edgeFrames: Keyframe[] = [];
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const scale = Math.max(min, easeAt(t));
                outer.push({ transform: `scale(${scale})`, offset: t });
                inner.push({ transform: `scale(${1 / scale})`, offset: t });
                edgeFrames.push({ transform: `scale(${scale})`, opacity: t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3, offset: t });
            }
            const timing: KeyframeAnimationOptions = { duration: SESSION_REVEAL.durationMs, easing: 'linear', fill: 'forwards' };
            windowCircle.animate(outer, timing);
            copy.animate(inner, timing);
            ring.animate(edgeFrames, timing);
            under?.animate([
                { opacity: SESSION_REVEAL.dimTo, offset: 0 },
                { opacity: SESSION_REVEAL.dimTo, offset: SESSION_REVEAL.blurFrom },
                { opacity: 0, offset: SESSION_REVEAL.blurFull },
                { opacity: 0, offset: 1 },
            ], timing);
            blurred?.animate([
                { opacity: 0, offset: 0 },
                { opacity: 0, offset: SESSION_REVEAL.blurFrom },
                { opacity: SESSION_REVEAL.dimTo, offset: SESSION_REVEAL.blurFull },
                { opacity: SESSION_REVEAL.dimTo, offset: 1 },
            ], timing);
            // Rows spring in one by one, newest (visual bottom) first; only the
            // ones on screen, so a long session does not queue dozens.
            rowSpring ??= springEasing(260, 19);
            const paneTop = rect.top;
            const paneBottom = rect.bottom;
            const realRows = [...element.querySelectorAll<HTMLElement>('[data-lmc-chat-row]')];
            const copyRows = [...copy.querySelectorAll<HTMLElement>('[data-lmc-chat-row]')];
            const risers: Animation[] = [];
            let order = 0;
            realRows.forEach((row, index) => {
                if (order >= SESSION_REVEAL.rowMax) return;
                const box = row.getBoundingClientRect();
                if (box.bottom < paneTop || box.top > paneBottom || box.height === 0) return;
                const target = copyRows[index];
                if (!target) return;
                target.style.willChange = 'transform, opacity';
                risers.push(target.animate([
                    { opacity: 0, transform: `translateY(${SESSION_REVEAL.rowRisePx}px) scale(0.98)` },
                    { opacity: 1, transform: 'none' },
                ], { duration: rowSpring!.duration, easing: rowSpring!.easing, delay: SESSION_REVEAL.rowDelayMs + order * SESSION_REVEAL.rowStaggerMs, fill: 'backwards' }));
                order += 1;
            });
            // Hand back to the real pane only when the circle and every row have landed.
            const all = [windowCircle.getAnimations()[0], ...risers];
            Promise.all(all.map((animation) => animation.finished)).then(clear, clear);
            const longest = Math.max(SESSION_REVEAL.durationMs, SESSION_REVEAL.rowDelayMs + (order - 1) * SESSION_REVEAL.rowStaggerMs + rowSpring.duration);
            setTimeout(clear, longest + 250);
        };
        // Copy only once the transcript has settled: right after mounting, the
        // list still scrolls itself to the bottom and measures rows, and a copy
        // taken then showed the body too high, jumping down when the real pane
        // took over. Settled = scroll offsets and heights unchanged for two frames.
        const startedAt = performance.now();
        let lastSignature = '';
        let stableFrames = 0;
        const signature = () => {
            let text = '';
            element.querySelectorAll<HTMLElement>('*').forEach((node) => {
                if (node.scrollHeight > node.clientHeight + 1) text += `${node.scrollTop}:${node.scrollHeight};`;
            });
            return text;
        };
        const waitForContent = () => {
            if (cleared) return;
            const ready = element.querySelector('[data-testid="session-content-enter"], [data-testid="session-content-skeleton"]');
            if (ready) {
                const next = signature();
                stableFrames = next === lastSignature ? stableFrames + 1 : 0;
                lastSignature = next;
            }
            if ((ready && stableFrames >= 2) || performance.now() - startedAt > SESSION_REVEAL.maxWaitMs) start();
            else requestAnimationFrame(waitForContent);
        };
        requestAnimationFrame(waitForContent);
        // Never leave the pane hidden or the snapshots behind.
        setTimeout(clear, SESSION_REVEAL.maxWaitMs + SESSION_REVEAL.durationMs + 1200);
    }, [ref, sessionId]);
}
