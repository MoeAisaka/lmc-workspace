import { INTERACTIVE_BLOCK_MAX_BYTES, extractInteractiveBlocks } from 'lmc-wire';
import type { Message } from '@/sync/typesMessage';

/** The name the frame and the page agree on; the shim below posts it, the block listens for it. */
export const SANDBOX_CHANNEL = 'lmc-ui';

/**
 * What the sandboxed page may do. No same-origin, so it is an opaque origin
 * with no access to the app's storage or session; no navigation of the app,
 * no new windows. Scripts and forms inside the page are allowed, and so is
 * the network: a page may fetch a chart library or data (D30, 10-08).
 */
export const SANDBOX_FLAGS = 'allow-scripts allow-forms allow-modals';

/**
 * Prepended to the page. It reports the page's height so the block can fit it,
 * script errors so the block can say the page failed, and the first network
 * request so the block can show that the page talks to the outside.
 *
 * Height is the content's own, never the frame's: a root's scrollHeight is at
 * least the frame height, so echoing it back would grow the block for ever.
 * Wheel the page cannot use is handed to the app: left to the browser it
 * chains into the inverted chat list, which scrolls it the wrong way.
 */
const SHIM = `<script>(function(){var send=function(m){try{parent.postMessage(Object.assign({channel:${JSON.stringify(SANDBOX_CHANNEL)}},m),'*')}catch(e){}};
var last=-1,report=function(){var d=document.documentElement,b=document.body,s=document.scrollingElement||d;if(!d)return;var h=s.scrollHeight>s.clientHeight+1?s.scrollHeight:Math.max(d.offsetHeight,b?b.offsetHeight:0);if(h!==last){last=h;send({type:'size',height:h})}};
window.addEventListener('error',function(e){send({type:'error',message:String(e&&e.message||'error')})});
window.addEventListener('unhandledrejection',function(e){send({type:'error',message:String(e&&e.reason&&e.reason.message||e.reason||'rejection')})});
var net=false,seen=function(){if(!net){net=true;send({type:'network'})}};
try{var ofetch=window.fetch;if(ofetch)window.fetch=function(){seen();return ofetch.apply(this,arguments)};var oopen=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(){seen();return oopen.apply(this,arguments)};
if(window.PerformanceObserver){new PerformanceObserver(function(l){if(l.getEntries().length)seen()}).observe({entryTypes:['resource']})}}catch(e){}
window.addEventListener('wheel',function(e){if(e.ctrlKey)return;var k=e.deltaMode===1?16:e.deltaMode===2?innerHeight:1,dx=e.deltaX*k,dy=e.deltaY*k,v=Math.abs(dy)>=Math.abs(dx),d=v?dy:dx;
for(var n=e.target;n&&n.nodeType===1;n=n.parentElement){var o=getComputedStyle(n)[v?'overflowY':'overflowX'];if(o==='visible'&&n===document.scrollingElement)o='auto';if(o!=='auto'&&o!=='scroll')continue;var at=v?n.scrollTop:n.scrollLeft,max=v?n.scrollHeight-n.clientHeight:n.scrollWidth-n.clientWidth;if(max>1&&(d<0?at>0:at<max-1))return}
e.preventDefault();send({type:'wheel',deltaX:dx,deltaY:dy})},{passive:false});
window.addEventListener('load',function(){report();send({type:'ready'})});document.addEventListener('DOMContentLoaded',report);
if(window.ResizeObserver){new ResizeObserver(report).observe(document.documentElement)}setInterval(report,1000);
})()</script>`;

/** Base styles so an unstyled page reads like the transcript around it. */
const BASE = `<style>:root{color-scheme:light dark}html,body{margin:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Noto Sans SC",sans-serif;padding:12px;line-height:1.5}</style>`;

/**
 * In the transcript the page never scrolls as a whole: the frame is as tall as
 * the page, and a root that could still move by a pixel would capture a swipe
 * and stall the transcript at the block's edge. Full screen passes `scrolls`.
 */
const FIXED = `<style>html{overflow:hidden!important;overscroll-behavior:none}</style>`;

export function wrapForSandbox(html: string, scrolls = false): string {
    const head = SHIM + BASE + (scrolls ? '' : FIXED);
    const at = html.search(/<head[^>]*>/i);
    if (at >= 0) { const end = html.indexOf('>', at) + 1; return html.slice(0, end) + head + html.slice(end); }
    const htmlTag = html.search(/<html[^>]*>/i);
    if (htmlTag >= 0) { const end = html.indexOf('>', htmlTag) + 1; return html.slice(0, end) + '<head>' + head + '</head>' + html.slice(end); }
    return head + html;
}

export function sandboxByteLength(html: string): number {
    return new TextEncoder().encode(html).length;
}

export function isOverSandboxLimit(html: string): boolean {
    return sandboxByteLength(html) > INTERACTIVE_BLOCK_MAX_BYTES;
}

export type SandboxEvent = { type: 'size'; height: number } | { type: 'error'; message: string } | { type: 'network' } | { type: 'ready' } | { type: 'wheel'; deltaX: number; deltaY: number };

/** Reads a frame message; null for anything that is not from our shim. */
export function parseSandboxEvent(data: unknown): SandboxEvent | null {
    const value = data as { channel?: unknown; type?: unknown; height?: unknown; message?: unknown };
    if (!value || value.channel !== SANDBOX_CHANNEL || typeof value.type !== 'string') return null;
    if (value.type === 'size') return typeof value.height === 'number' && Number.isFinite(value.height) ? { type: 'size', height: Math.max(0, value.height) } : null;
    if (value.type === 'error') return { type: 'error', message: typeof value.message === 'string' ? value.message : 'error' };
    if (value.type === 'wheel') { const { deltaX, deltaY } = data as { deltaX?: unknown; deltaY?: unknown }; return typeof deltaX === 'number' && typeof deltaY === 'number' && Number.isFinite(deltaX) && Number.isFinite(deltaY) ? { type: 'wheel', deltaX, deltaY } : null; }
    if (value.type === 'network' || value.type === 'ready') return { type: value.type };
    return null;
}

/**
 * A `ref` names a block the engine wrote earlier in this session. The newest
 * complete block with that id wins; messages are the session's own record, so
 * a reference never reads another session.
 */
export function resolveInteractiveRef(messages: readonly Message[] | undefined, ref: string): { html: string; title: string | null } | null {
    if (!messages) return null;
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message.kind !== 'agent-text' || message.isThinking) continue;
        if (!message.text.includes(ref)) continue;
        const blocks = extractInteractiveBlocks(message.text);
        for (let b = blocks.length - 1; b >= 0; b--) {
            const block = blocks[b];
            if (block.id === ref && block.closed && block.html.trim()) return { html: block.html, title: block.title };
        }
    }
    return null;
}
