import * as React from 'react';
import { Platform } from 'react-native';

/**
 * Opening a session from the list grows it out of the row that was pressed:
 * a soft-edged circle, centred on the pane's edge at that row's height, widens
 * to half the pane while everything outside it fades in, then the mask goes.
 * Web only (mask-image over registered custom properties, Web Animations);
 * other platforms, older browsers and reduced motion keep the plain fade in
 * SessionContentEnter.
 */
export const SESSION_REVEAL = {
    durationMs: 450,
    easing: 'cubic-bezier(0.2, 0, 0, 1)',
    freshMs: 1200,
    /** Share of the full covering radius the circle reaches. Owner: stop halfway. */
    radiusShare: 0.5,
    /** Width of the circle's soft edge. */
    featherPx: 160,
} as const;

let origin: { x: number; y: number; at: number } | null = null;
let lastRevealAt = 0;
let listening = false;

function listen() {
    if (listening || Platform.OS !== 'web' || typeof document === 'undefined') return;
    listening = true;
    document.addEventListener('pointerdown', (event) => {
        const target = event.target as Element | null;
        if (target?.closest?.('.happy-sort-row, [data-hub-sort-id]')) {
            origin = { x: event.clientX, y: event.clientY, at: Date.now() };
        }
    }, { capture: true, passive: true });
}

// Installed on import so the very first press, before any session pane
// exists, is already recorded.
listen();

let registered: boolean | null = null;
/** The mask animates through two typed custom properties; without them gradients cannot interpolate. */
function registerRevealProperties(): boolean {
    if (registered !== null) return registered;
    const css = (globalThis as { CSS?: { registerProperty?: (definition: object) => void } }).CSS;
    if (!css?.registerProperty) return (registered = false);
    try {
        css.registerProperty({ name: '--lmc-reveal-r', syntax: '<length>', inherits: false, initialValue: '0px' });
        css.registerProperty({ name: '--lmc-reveal-a', syntax: '<number>', inherits: false, initialValue: '0' });
    } catch { /* already registered by an earlier bundle on this page */ }
    return (registered = true);
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
        );
        if (!registerRevealProperties()) return;
        lastRevealAt = Date.now();
        const mask = `radial-gradient(circle at ${x}px ${y}px, #000 var(--lmc-reveal-r), rgba(0,0,0,var(--lmc-reveal-a)) calc(var(--lmc-reveal-r) + ${SESSION_REVEAL.featherPx}px))`;
        const style = element.style as CSSStyleDeclaration & { webkitMaskImage: string };
        style.maskImage = mask;
        style.webkitMaskImage = mask;
        const clear = () => { style.maskImage = ''; style.webkitMaskImage = ''; };
        const animation = element.animate([
            { '--lmc-reveal-r': '0px', '--lmc-reveal-a': 0 },
            { '--lmc-reveal-r': `${Math.ceil(radius * SESSION_REVEAL.radiusShare)}px`, '--lmc-reveal-a': 1 },
        ] as Keyframe[], { duration: SESSION_REVEAL.durationMs, easing: SESSION_REVEAL.easing, fill: 'forwards' });
        animation.onfinish = clear;
        animation.oncancel = clear;
        // Never leave the pane masked, whatever happens to the animation.
        setTimeout(clear, SESSION_REVEAL.durationMs + 250);
    }, [ref, sessionId]);
}
