import { flushSync } from 'react-dom';

export const SIDEBAR_MOTION_CSS = `
@keyframes lmc-sidebar-in{from{opacity:0;transform:translateX(-32px)}to{opacity:1;transform:translateX(0)}}
@keyframes lmc-sidebar-out{to{opacity:0;transform:translateX(-32px)}}
html[data-lmc-sidebar-motion]::view-transition-group(*){animation-duration:220ms;animation-timing-function:cubic-bezier(.2,.8,.2,1)}
html[data-lmc-sidebar-motion]::view-transition-new(lmc-sidebar){animation:lmc-sidebar-in 220ms cubic-bezier(.2,.8,.2,1) both}
html[data-lmc-sidebar-motion]::view-transition-old(lmc-sidebar){animation:lmc-sidebar-out 180ms ease both}
html[data-lmc-sidebar-motion]::view-transition-old(root),html[data-lmc-sidebar-motion]::view-transition-new(root){animation-duration:180ms}
html[data-lmc-sidebar-motion]::view-transition{pointer-events:none}
[data-lmc-resource-window]{transition:opacity 180ms ease,transform 220ms cubic-bezier(.2,.8,.2,1),visibility 0s 180ms}
[data-lmc-resource-window="open"]{transition-delay:0s}
@media(prefers-reduced-motion:reduce){[data-lmc-resource-window]{transition:none!important}}
`;
export function installSidebarMotion() {
    if(typeof document==='undefined'||document.getElementById('lmc-sidebar-motion'))return;
    const style=document.createElement('style');style.id='lmc-sidebar-motion';style.textContent=SIDEBAR_MOTION_CSS;document.head.appendChild(style);
}
let active: {skipTransition:()=>void;finished:Promise<void>;ready:Promise<void>} | undefined;
export function runSidebarTransition(update:()=>void) {
    if(typeof document==='undefined'||typeof document.startViewTransition!=='function'||window.matchMedia('(prefers-reduced-motion: reduce)').matches){update();return;}
    installSidebarMotion();active?.skipTransition();
    document.documentElement.setAttribute('data-lmc-sidebar-motion','');
    const transition=document.startViewTransition(()=>flushSync(update));active=transition;
    // Skipping an interrupted animation is normal; the update still runs.
    void transition.ready.catch(()=>{});
    void transition.finished.catch(()=>{}).finally(()=>{if(active===transition){active=undefined;document.documentElement.removeAttribute('data-lmc-sidebar-motion');}});
}
