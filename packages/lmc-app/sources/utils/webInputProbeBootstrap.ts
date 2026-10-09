// Expo's single-page export does not execute +html.tsx. Load the opt-in probe
// from the real entrypoint, without adding diagnostics to ordinary sessions.
if (typeof document !== 'undefined' && typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('lmc_input_probe') === '1') {
    const script = document.createElement('script');
    script.src = '/diagnostics/input-layout-probe-20261008-v6.js';
    script.async = true;
    document.head.appendChild(script);
}

export {};
