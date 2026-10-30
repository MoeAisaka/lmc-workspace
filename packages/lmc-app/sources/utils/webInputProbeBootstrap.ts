// A small lifecycle controller: no session/transport dependency and no reload.
declare global {
    interface Window {
        __lmcInputProbeEnabled?: boolean;
        __lmcInputLayoutReport?: () => string;
        __lmcStopInputLayoutProbe?: () => void;
    }
}
let loading: HTMLScriptElement | null = null;

export function webInputProbeQueryEnabled(): boolean {
    return typeof window !== 'undefined'
        && new URLSearchParams(window.location.search).get('lmc_input_probe') === '1';
}

export function clearWebInputProbeQuery(): void {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has('lmc_input_probe')) return;
    url.searchParams.delete('lmc_input_probe');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
}

export function setWebInputProbeEnabled(enabled: boolean): void {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    window.__lmcInputProbeEnabled = enabled;
    if (!enabled) {
        window.__lmcStopInputLayoutProbe?.();
        loading?.remove();
        loading = null;
        return;
    }
    if (window.__lmcStopInputLayoutProbe || window.__lmcInputLayoutReport || loading) return;
    const script = document.createElement('script');
    loading = script;
    script.src = '/diagnostics/input-layout-probe-20261011-v9.js';
    script.async = true;
    const done = () => {
        if (loading === script) loading = null;
        script.remove();
        if (!window.__lmcInputProbeEnabled) window.__lmcStopInputLayoutProbe?.();
    };
    script.onload = done;
    script.onerror = done;
    document.head.appendChild(script);
}

// Keep previously shared diagnostic links working.
if (webInputProbeQueryEnabled()) setWebInputProbeEnabled(true);
