import { create } from 'zustand';

/**
 * Has a newer web build been published than the one this page is running?
 *
 * The app is a single page: until it is reloaded it keeps running the code it
 * loaded, however many releases go out. On 2026-10-08 five went out in a day
 * and a fix was reported as "still broken" twice from a page that predated it.
 * This only notices and says so; reloading is the reader's decision (D28).
 */
export const RELEASE_CHECK_INTERVAL_MS = 5 * 60_000;
export const RELEASE_SNOOZE_MS = 60 * 60_000;

/** The marker publish-web writes into index.html. */
export function parseReleaseMarker(html: string): string | null {
    const tag = /<meta\b[^>]*\bname=["']lmc-release["'][^>]*>/i.exec(html)?.[0];
    return tag ? (/\bcontent=["']([^"']+)["']/i.exec(tag)?.[1] ?? null) : null;
}

export interface ReleaseSnooze { release: string; at: number }

/** Shown when the server has a different release, unless this very release was put off within the last hour. */
export function shouldShowReleaseNotice(input: { loaded: string | null; deployed: string | null; snoozed: ReleaseSnooze | null; now: number }): boolean {
    const { loaded, deployed, snoozed, now } = input;
    if (!loaded || !deployed || loaded === deployed) return false;
    return !(snoozed && snoozed.release === deployed && now - snoozed.at < RELEASE_SNOOZE_MS);
}

interface WebReleaseState {
    loaded: string | null;
    deployed: string | null;
    snoozed: ReleaseSnooze | null;
    /** Moves on every check so a snooze that has run out is noticed. */
    checkedAt: number;
    observe: (deployed: string | null, now: number) => void;
    snooze: (now: number) => void;
}

export const useWebRelease = create<WebReleaseState>((set, get) => ({
    loaded: null,
    deployed: null,
    snoozed: null,
    checkedAt: 0,
    observe: (deployed, now) => set(deployed ? { deployed, checkedAt: now } : { checkedAt: now }),
    snooze: (now) => { const { deployed } = get(); if (deployed) set({ snoozed: { release: deployed, at: now } }); },
}));

export function useReleaseNoticeVisible(): boolean {
    return useWebRelease((state) => shouldShowReleaseNotice({ loaded: state.loaded, deployed: state.deployed, snoozed: state.snoozed, now: state.checkedAt }));
}

type Fetcher = (url: string, init: { cache: 'no-store'; credentials: 'omit' }) => Promise<{ ok: boolean; text(): Promise<string> }>;

/** One look at the server. Failures are silent: no network is not a new version. */
export async function checkWebRelease(fetcher: Fetcher, now: () => number = Date.now): Promise<void> {
    try {
        const response = await fetcher(`/?lmc-release-check=${now()}`, { cache: 'no-store', credentials: 'omit' });
        useWebRelease.getState().observe(response.ok ? parseReleaseMarker(await response.text()) : null, now());
    } catch {
        useWebRelease.getState().observe(null, now());
    }
}

let watching = false;

/** Web only, once per page: check every five minutes and whenever the tab comes back to the front. */
export function startWebReleaseWatch(): void {
    if (watching || typeof document === 'undefined' || typeof fetch !== 'function') return;
    const loaded = document.querySelector('meta[name="lmc-release"]')?.getAttribute('content') ?? null;
    // A page with no marker (a development build) has nothing to compare against.
    if (!loaded) return;
    watching = true;
    useWebRelease.setState({ loaded });
    const check = () => { void checkWebRelease((url, init) => fetch(url, init)); };
    setInterval(check, RELEASE_CHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    check();
}
