import type { Router } from "expo-router"
import { useRouter, usePathname } from "expo-router"
import { storage } from '@/sync/storage';
import { trackSessionSwitched } from '@/track';

/**
 * `replace` keeps session-to-session moves from growing the navigation stack.
 *
 * Every push leaves the outgoing screen mounted and aria-hidden, and the stack
 * has no ceiling: switching between sessions all day added one live screen per
 * switch (~1000 DOM nodes each, measured), which is not garbage — it is
 * reachable, so no amount of GC touches it. Sessions are all reachable from the
 * sidebar anyway, so there is nothing to go "back" to that the list does not
 * already offer.
 *
 * Arriving at a session from somewhere else — a machine's session list, the
 * new-session flow — still pushes, because there the back gesture returns to a
 * screen that is genuinely a different place.
 */
export function navigateToSession(router: Router, sessionId: string, options?: { replace?: boolean }) {
    const session = storage.getState().sessions[sessionId];
    if (session) {
        trackSessionSwitched(session);
    }

    const href = `/session/${encodeURIComponent(sessionId)}`;
    if (options?.replace) {
        router.replace(href);
    } else {
        router.push(href);
    }
}

export function isSessionRoute(pathname: string): boolean {
    return pathname.startsWith('/session/');
}

export function useNavigateToSession() {
    const router = useRouter();
    const pathname = usePathname();
    return (sessionId: string) => {
        navigateToSession(router, sessionId, { replace: isSessionRoute(pathname) });
    }
}
