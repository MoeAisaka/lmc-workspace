const key = 'lmc-login-changed-v1';
/** Public event marker only: no token, secret or account ID in browser storage. */
export function broadcastAccountChange() {
    if (typeof window === 'undefined') return;
    try { window.localStorage.setItem(key, Date.now() + ':' + Math.random()); } catch { /* Storage may be unavailable. */ }
}
export function watchAccountChanges(onChange: () => void) {
    if (typeof window === 'undefined') return () => {};
    const listener = (event: StorageEvent) => { if (event.key === key) onChange(); };
    window.addEventListener('storage', listener);
    return () => window.removeEventListener('storage', listener);
}
