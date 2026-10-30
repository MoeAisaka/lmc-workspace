import { afterEach, expect, it, vi } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require('jsdom');
import { readFileSync } from 'node:fs';
const probe = readFileSync(new URL('../../public/diagnostics/input-layout-probe-20261011-v9.js', import.meta.url), 'utf8');
let dom: any;
afterEach(() => { dom?.window.__lmcStopInputLayoutProbe?.(); dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });
async function setup(query = '') {
    dom = new JSDOM('<body></body>', { url: 'https://fixture.invalid/session/demo' + query, runScripts: 'outside-only' });
    vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
    return import('./webInputProbeBootstrap');
}
it('is opt-in, deduplicates loads, ignores late disabled loads, and can re-enable', async () => {
    const { setWebInputProbeEnabled: set } = await setup();
    expect(document.scripts).toHaveLength(0);
    set(true); set(true);
    expect(document.scripts).toHaveLength(1);
    set(false);
    dom.window.eval(probe); // network response races with switching off
    expect(document.querySelector('[data-lmc-input-probe-panel]')).toBeNull();
    expect(document.scripts).toHaveLength(0);
    set(true); dom.window.eval(probe);
    document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    expect(document.querySelectorAll('[data-lmc-input-probe-panel]')).toHaveLength(1);
    set(false);
    expect(document.querySelector('[data-lmc-input-probe-panel]')).toBeNull();
});
it('supports old links and disabling removes only the diagnostic query without reloading', async () => {
    const { clearWebInputProbeQuery, webInputProbeQueryEnabled } = await setup('?other=keep&lmc_input_probe=1#message');
    expect(document.scripts).toHaveLength(1);
    expect(webInputProbeQueryEnabled()).toBe(true);
    clearWebInputProbeQuery();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/session/demo?other=keep#message');
    expect(webInputProbeQueryEnabled()).toBe(false);
});
