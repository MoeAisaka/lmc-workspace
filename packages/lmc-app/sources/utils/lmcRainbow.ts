const STYLE_ID = 'lmc-rainbow-ring';

/**
 * The mark of a working agent: one soft point circling the composer at a
 * breathing pace.
 *
 * Two choices carry the feeling. The lap is eased rather than linear — a
 * shallow S-curve, so the point drifts up to speed and settles once per turn
 * without ever lurching — and the bloom breathes on its own, slower cycle, so
 * the light reads as something steadily working rather than something racing.
 *
 * It is a conic gradient that is transparent everywhere except a long, soft
 * tail, rotating behind the card — so the blurred copy lights the moving point
 * alone instead of haloing the whole box.
 */
export function installLmcRainbow() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
@keyframes lmc-rainbow-spin {
    from { transform: translate(-50%, -50%) rotate(0turn); }
    to   { transform: translate(-50%, -50%) rotate(1turn); }
}
@keyframes lmc-rainbow-breathe {
    0%, 100% { opacity: 0.5; }
    50%      { opacity: 0.9; }
}
/* A square keeps the angular sectors undistorted, so the point keeps its shape
   along every edge; 100vmax always covers the composer. */
[data-lmc-rainbow="true"] {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 100vmax;
    height: 100vmax;
    transform: translate(-50%, -50%);
    background: conic-gradient(from 0deg,
        rgba(0, 96, 240, 0) 0deg,
        rgba(0, 96, 240, 0) 250deg,
        rgba(168, 85, 247, 0.16) 292deg,
        rgba(34, 211, 238, 0.48) 332deg,
        rgba(0, 96, 240, 0.80) 353deg,
        rgba(0, 96, 240, 0) 360deg);
    animation: lmc-rainbow-spin 5.2s cubic-bezier(0.45, 0.22, 0.55, 0.78) infinite;
    will-change: transform;
}
[data-lmc-glow="true"] {
    filter: blur(8px);
    animation: lmc-rainbow-breathe 3.2s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
    [data-lmc-rainbow="true"] { animation-duration: 12s; }
    [data-lmc-glow="true"] { animation: none; opacity: 0.7; }
}
`;
    document.head.appendChild(style);
}
