const STYLE_ID = 'lmc-sidebar-motion';
const DURATION_MS = 280;
const EASING = 'cubic-bezier(.2,.8,.2,1)';

/**
 * The sidebar collapse animates through the View Transitions API rather than a
 * CSS width transition. A transitioning width re-flows the chat on every frame,
 * which re-measures the whole message list; a view transition animates GPU
 * snapshots instead, so the sidebar morphs from full width to the rail at a
 * steady frame rate and the chat is laid out exactly once.
 */
export function installSidebarMotion() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
::view-transition-group(root),::view-transition-old(root),::view-transition-new(root){animation-duration:${DURATION_MS}ms;animation-timing-function:${EASING}}
::view-transition-group(lmc-sidebar){animation-duration:${DURATION_MS}ms;animation-timing-function:${EASING}}
::view-transition-old(lmc-sidebar),::view-transition-new(lmc-sidebar){animation-duration:${DURATION_MS}ms;animation-timing-function:${EASING};height:100%;overflow:clip}
::view-transition-group(lmc-main){animation-duration:${DURATION_MS}ms;animation-timing-function:${EASING}}
/* The chat pane only changes size and position, so keep both snapshots fully
   opaque and let the group morph carry the motion — a cross-fade of nearly
   identical frames is what reads as a flicker. */
::view-transition-old(lmc-main),::view-transition-new(lmc-main){animation:none;mix-blend-mode:normal;height:100%;width:100%;object-fit:cover;object-position:left top}
::view-transition-old(lmc-main){opacity:0}
::view-transition-new(lmc-main){opacity:1}
@media(prefers-reduced-motion:reduce){::view-transition-group(*),::view-transition-old(*),::view-transition-new(*){animation:none!important}}
`;
    document.head.appendChild(style);
}

export function runSidebarTransition(update: () => void) {
    const start = typeof document !== 'undefined' ? (document as any).startViewTransition : undefined;
    if (typeof start !== 'function') {
        update();
        return;
    }
    start.call(document, update);
}
