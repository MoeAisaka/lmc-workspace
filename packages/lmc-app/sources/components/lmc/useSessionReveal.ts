import * as React from 'react';
import { Platform } from 'react-native';

/**
 * Opening a session from the list grows it out of the row that was pressed:
 * the session pane is clipped to a circle centred on the press, which widens
 * until it covers the pane. Web only (clip-path + Web Animations); other
 * platforms and reduced motion keep the plain fade in SessionContentEnter.
 */
export const SESSION_REVEAL = { durationMs: 420, easing: 'cubic-bezier(0.2, 0, 0, 1)', freshMs: 1200 } as const;

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
        const x = press.x - rect.left;
        const y = press.y - rect.top;
        const radius = Math.max(
            Math.hypot(x, y), Math.hypot(rect.width - x, y),
            Math.hypot(x, rect.height - y), Math.hypot(rect.width - x, rect.height - y),
        );
        lastRevealAt = Date.now();
        element.animate([
            { clipPath: `circle(0px at ${x}px ${y}px)` },
            { clipPath: `circle(${Math.ceil(radius)}px at ${x}px ${y}px)` },
        ], { duration: SESSION_REVEAL.durationMs, easing: SESSION_REVEAL.easing });
    }, [ref, sessionId]);
}
