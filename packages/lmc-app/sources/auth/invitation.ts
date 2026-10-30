/** Fragments are not sent to HTTP logs or referrers. Never accept redirect URLs. */
export function currentInvitation(): string | null {
    if (typeof window === 'undefined') return null;
    const match = /^#lmc-invite=([A-Za-z0-9_-]{43})$/.exec(window.location.hash);
    return match?.[1] ?? null;
}
export function clearInvitation() {
    if (typeof window !== 'undefined' && currentInvitation()) window.history.replaceState(null, '', window.location.pathname + window.location.search);
}
