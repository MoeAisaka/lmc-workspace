import { afterEach, expect, it, vi } from 'vitest';
// jsdom is already the test environment dependency; it has no bundled types.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require('jsdom') as { JSDOM: new (html: string, options: object) => { window: Window & typeof globalThis & { close(): void } } };
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../public/diagnostics/input-layout-probe-20261011-v9.js', import.meta.url), 'utf8');
const windows: InstanceType<typeof JSDOM>[] = [];
function page(query = '&lmc_input_probe=1') {
    const dom = new JSDOM('<meta name="lmc-release" content="fixture-v288"><style>body{position:fixed;top:200px}</style><body style="height:800px"><div data-lmc-composer><textarea data-lmc-text-input="true">PRIVATE_DRAFT</textarea></div></body>', {
        url: 'https://fixture.invalid/session/PRIVATE_SESSION?token=PRIVATE_TOKEN' + query,
        runScripts: 'outside-only',
    });
    windows.push(dom);
    const win = dom.window;
    win.document.documentElement.className = 'lmc-app-zoomed lmc-input-viewport';
    const viewport = Object.assign(new win.EventTarget(), { width: 390, height: 400, offsetLeft: 0, offsetTop: 200, pageLeft: 0, pageTop: 200, scale: 1 });
    Object.defineProperty(win, 'visualViewport', { value: viewport });
    const clipboard = vi.fn(async (_text: string) => {});
    Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: clipboard } });
    const interval = vi.spyOn(win, 'setInterval');
    const measure = vi.spyOn(win.HTMLElement.prototype, 'getBoundingClientRect');
    win.eval(source);
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    return { win, viewport, clipboard, interval, measure, input: win.document.querySelector('textarea')! };
}
afterEach(() => { windows.splice(0).forEach(dom => dom.window.close()); vi.restoreAllMocks(); });

it('keeps copy reachable through keyboard pan without moving the raw reference or stealing focus', async () => {
    const { win, viewport, clipboard, input, measure } = page();
    Object.defineProperty(win.document.documentElement, 'clientWidth', { configurable: true, value: 390 });
    const panel = win.document.querySelector('[data-lmc-input-probe-panel]') as HTMLElement;
    const controls = win.document.querySelector('[data-lmc-input-probe-controls]') as HTMLElement;
    expect(controls).not.toBeNull();
    input.focus(); input.setSelectionRange(3, 6);
    const before = win.document.body.getAttribute('style');
    const scroll = vi.spyOn(win, 'scrollTo');
    measure.mockClear();
    viewport.offsetTop = 332; viewport.pageTop = 332;
    viewport.dispatchEvent(new win.Event('scroll'));
    expect(controls.style.transform).toBe('translate(0px, 332px)');
    expect(panel.style.top).toBe('6px');
    expect(panel.style.transform).toBe('');
    expect(measure).not.toHaveBeenCalled();
    viewport.width = 300; viewport.offsetLeft = 20;
    viewport.dispatchEvent(new win.Event('resize'));
    expect(controls.style.transform).toBe('translate(-70px, 332px)');
    (win.document.querySelector('[data-lmc-input-probe="copy"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(clipboard).toHaveBeenCalledTimes(1);
    expect(win.document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 6]);
    expect(win.document.body.getAttribute('style')).toBe(before);
    expect(scroll).not.toHaveBeenCalled();
    viewport.offsetTop = 0; viewport.offsetLeft = 0; viewport.width = 390;
    input.blur();
    viewport.dispatchEvent(new win.Event('resize'));
    expect(controls.style.transform).toBe('translate(0px, 0px)');
});

it.each(['', '&lmc_input_frame=native'])('does no collection, timer, or UI work without probe opt-in (%s)', query => {
    const { win, interval, measure, input } = page(query);
    input.focus();
    expect(interval).not.toHaveBeenCalled();
    expect(measure).not.toHaveBeenCalled();
    expect(win.document.querySelector('[data-lmc-input-probe]')).toBeNull();
    expect(win.document.documentElement.hasAttribute('data-lmc-input-frame-trial')).toBe(false);
});

it('copies bounded geometry and the loaded release, without text, URL, credentials or layout writes', async () => {
    const { win, viewport, clipboard, interval, input } = page();
    const before = win.document.body.getAttribute('style');
    input.focus();
    const focus = vi.spyOn(input, 'focus');
    const scroll = vi.spyOn(win, 'scrollTo');
    for (let i = 0; i < 60; i++) {
        viewport.offsetTop = i;
        (interval.mock.calls[0][0] as () => void)();
    }
    input.blur(); // Last focused geometry remains available after keyboard dismissal.
    (win.document.querySelector('[data-lmc-input-probe]') as HTMLButtonElement).click();
    await Promise.resolve();
    const text = clipboard.mock.calls[0][0];
    const report = JSON.parse(text);
    expect(report.release).toBe('fixture-v288');
    expect(report.schema).toBe('lmc-input-layout-v9');
    expect(report.trial).toBe(false);
    expect(report.mode).toBe('observe');
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0].samples.length).toBeGreaterThan(0);
    expect(report.runs[0].samples.length).toBeLessThanOrEqual(4);
    expect(report.runs[0].timeline).toHaveLength(20);
    const changedOffsets = report.runs[0].changes.map((row: any[]) => row[2][3]);
    expect(changedOffsets).toEqual([
        200, ...Array.from({ length: 23 }, (_, i) => i),
        ...Array.from({ length: 24 }, (_, i) => i + 36),
    ]);
    expect(report.runs[0].samples[0].reference).toHaveLength(4);
    expect(report.runs[0].samples[0].composer).toHaveLength(4);
    expect(text).not.toContain('"gap"');
    expect(text).not.toMatch(/PRIVATE_DRAFT|PRIVATE_SESSION|PRIVATE_TOKEN|fixture.invalid/);
    expect(focus).not.toHaveBeenCalled();
    expect(scroll).not.toHaveBeenCalled();
    expect(win.document.body.getAttribute('style')).toBe(before);
    expect(input.value).toBe('PRIVATE_DRAFT');
    expect(win.document.querySelector('[data-lmc-input-probe="native"]')).toBeNull();
    expect(win.document.querySelector('[data-lmc-input-probe-trial]')).toBeNull();
    expect(win.document.documentElement.hasAttribute('data-lmc-input-frame-trial')).toBe(false);
    expect(win.document.querySelector('[data-lmc-input-probe-panel]')?.parentElement).toBe(win.document.documentElement);
});

it.each(['native', 'offset'])('retires the v287 %s trial without moving a focused field', mode => {
    const { win, input } = page('&lmc_input_probe=1&lmc_input_frame=' + mode);
    input.focus(); input.setSelectionRange(3, 6);
    expect(win.document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 6]);
    expect(input.value).toBe('PRIVATE_DRAFT');
    expect(win.getComputedStyle(win.document.body).top).toBe('200px');
    expect(win.document.querySelectorAll('[data-lmc-input-probe]')).toHaveLength(1);
    expect(win.document.querySelector('[data-lmc-input-probe-trial]')).toBeNull();
    expect(win.document.documentElement.hasAttribute('data-lmc-input-frame-trial')).toBe(false);
});

it('retains keyboard geometry when later idle samples and copying would otherwise replace it', async () => {
    const { win, clipboard, viewport, interval, input } = page();
    Object.defineProperty(win.document.documentElement, 'clientHeight', { configurable: true, get: () => 756 });
    win.document.documentElement.classList.add('lmc-input-native-bottom');
    input.focus();
    viewport.offsetTop = 332;
    (interval.mock.calls[0][0] as () => void)();
    viewport.height = 756; viewport.offsetTop = 0;
    win.document.documentElement.classList.remove('lmc-input-native-bottom', 'lmc-input-viewport');
    for (let i = 0; i < 40; i++) (interval.mock.calls[0][0] as () => void)();
    input.blur();
    (win.document.querySelector('[data-lmc-input-probe="copy"]') as HTMLButtonElement).click();
    await Promise.resolve();
    const run = JSON.parse(clipboard.mock.calls[0][0]).runs[0];
    expect(run.samples.some((s: { frame: string; viewport: number[] }) => s.frame === 'native-bottom' && s.viewport[3] === 332)).toBe(true);
    expect(run.samples.length).toBeLessThanOrEqual(4);
    expect(run.timeline.every((row: unknown[]) => row[9] === 'idle')).toBe(true);
    // A stable tail must not erase the keyboard-opening sequence. v290's
    // device report lost the entire transition after ten seconds at rest.
    expect(run.changes).toBeDefined();
    expect(run.changes.some((row: any[]) => row[9] === 'native-bottom' && row[2][3] === 332)).toBe(true);
    expect(run.changes.length).toBeLessThanOrEqual(48);
});

it('coalesces viewport bursts instead of measuring on every scroll and cancels pending work on blur', () => {
    const { win, viewport, measure, input } = page();
    input.focus(); measure.mockClear();
    const timeout = vi.spyOn(win, 'setTimeout'), clear = vi.spyOn(win, 'clearTimeout');
    for (let i = 0; i < 60; i++) viewport.dispatchEvent(new win.Event('scroll'));
    expect(measure).not.toHaveBeenCalled();
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenLastCalledWith(expect.any(Function), 100);
    input.blur();
    expect(clear).toHaveBeenCalledWith(timeout.mock.results[0].value);
    for (let i = 0; i < 60; i++) viewport.dispatchEvent(new win.Event('scroll'));
    expect(timeout).toHaveBeenCalledTimes(1);
});

it('activates a focus-preserving touch exactly once, ignores cancelled or moved touches, and supports keyboard clicks', async () => {
    const { win, clipboard, input } = page('&lmc_input_probe=1&lmc_input_frame=native');
    input.focus();
    const copy = win.document.querySelector('[data-lmc-input-probe="copy"]')!;
    const pointer = (type: string, clientX = 0) => copy.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX }));
    pointer('pointerdown'); pointer('pointerup');
    copy.dispatchEvent(new win.MouseEvent('click', { bubbles: true, detail: 1 }));
    await Promise.resolve();
    expect(clipboard).toHaveBeenCalledTimes(1);
    pointer('pointerdown'); pointer('pointercancel'); pointer('pointerup');
    pointer('pointerdown'); pointer('pointerup', 30);
    expect(clipboard).toHaveBeenCalledTimes(1);
    (copy as HTMLButtonElement).click();
    await Promise.resolve();
    expect(clipboard).toHaveBeenCalledTimes(2);
    expect(win.document.activeElement).toBe(input);
});

it('stops sampling on blur and page hide', () => {
    const { win, interval, input } = page();
    const clear = vi.spyOn(win, 'clearInterval');
    input.focus();
    expect(interval).toHaveBeenLastCalledWith(expect.any(Function), 500);
    input.blur();
    expect(clear).toHaveBeenCalledWith(interval.mock.results[0].value);
    input.focus();
    win.dispatchEvent(new win.Event('pagehide'));
    expect(clear).toHaveBeenLastCalledWith(interval.mock.results[1].value);
});

it('v7: logs the raw order of viewport, pan, lift and backdrop events per keyboard open, and the remembered strip', async () => {
    const { win, viewport, clipboard, input } = page();
    win.localStorage.setItem('lmc.ios-keyboard-reveal-gap.v2', JSON.stringify({ scope: 'other', gap: 77, keyboardHeight: 332, misses: 1, disabled: false }));
    const owner = input.closest('[data-lmc-composer]') as HTMLElement;
    owner.style.setProperty('--lmc-keyboard-inset', '0px');
    input.focus();
    viewport.height = 424; viewport.dispatchEvent(new win.Event('resize'));
    owner.style.setProperty('--lmc-keyboard-inset', '332px');
    await new Promise(resolve => setTimeout(resolve, 0)); // MutationObserver delivery
    viewport.offsetTop = 180; viewport.pageTop = 180; viewport.dispatchEvent(new win.Event('scroll'));
    owner.style.setProperty('--lmc-dock-extension', '180px');
    await new Promise(resolve => setTimeout(resolve, 0));
    input.blur();
    (win.document.querySelector('[data-lmc-input-probe="copy"]') as HTMLButtonElement).click();
    await Promise.resolve();
    const text = clipboard.mock.calls[0][0];
    const report = JSON.parse(text);
    expect(report.schema).toBe('lmc-input-layout-v9');
    const run = report.runs[0];
    expect(run.events.map((row: unknown[]) => row[1])).toEqual(['focus', 'vv-resize', 'dock', 'vv-scroll', 'dock', 'blur']);
    expect(run.events[1][2]).toBe(424);
    expect(run.events[2].slice(8)).toEqual(['332px', '']);
    expect(run.events[3][4]).toBe(180);
    expect(run.events[3][7]).toBeNull(); // no layout read on pan events
    expect(run.events[2][7]).not.toBeNull(); // lift rows read the field (jsdom reports 0)
    expect(run.events[4].slice(8)).toEqual(['332px', '180px']);
    expect(run.learnedAtFocus).toEqual({ lift: 77, keyboardHeight: 332, misses: 1, disabled: false, scopeMatches: false });
    expect(report.learnedNow.lift).toBe(77);
    expect(text).not.toContain('"scope"');
    expect(text).not.toMatch(/PRIVATE_DRAFT|PRIVATE_SESSION|PRIVATE_TOKEN|fixture.invalid/);
    // Each focus opens a new run; at most four are kept.
    for (let i = 0; i < 5; i++) { input.focus(); input.blur(); }
    (win.document.querySelector('[data-lmc-input-probe="copy"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(JSON.parse(clipboard.mock.calls[1][0]).runs.length).toBeLessThanOrEqual(4);
});

it('can start without a query and fully dispose listeners, observers, timers and controls before restarting', async () => {
    const { win, input, viewport, measure, interval } = page('');
    Object.defineProperty(win.document, 'readyState', { configurable: true, value: 'complete' });
    win.__lmcInputProbeEnabled = true;
    win.eval(source);
    const owner = input.closest('[data-lmc-composer]') as HTMLElement;
    owner.style.setProperty('--lmc-keyboard-inset', '0px');
    input.focus();
    expect(win.document.querySelectorAll('[data-lmc-input-probe="copy"]')).toHaveLength(1);
    expect(interval).toHaveBeenCalledTimes(1);
    const clear = vi.spyOn(win, 'clearInterval');
    const remove = vi.spyOn(win.document, 'removeEventListener');
    const before = win.document.body.getAttribute('style');
    win.__lmcInputProbeEnabled = false;
    win.__lmcStopInputLayoutProbe!();
    expect(win.__lmcInputLayoutReport).toBeUndefined();
    expect(win.__lmcStopInputLayoutProbe).toBeUndefined();
    expect(win.document.querySelector('[data-lmc-input-probe-panel]')).toBeNull();
    expect(clear).toHaveBeenCalledWith(interval.mock.results[0].value);
    expect(remove.mock.calls.some(args => args[0] === 'focusin')).toBe(true);
    measure.mockClear(); interval.mockClear();
    owner.style.setProperty('--lmc-keyboard-inset', '332px');
    viewport.dispatchEvent(new win.Event('resize'));
    input.blur(); input.focus();
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(measure).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    expect(win.document.body.getAttribute('style')).toBe(before);
    win.__lmcInputProbeEnabled = true;
    win.eval(source);
    expect(win.document.querySelectorAll('[data-lmc-input-probe="copy"]')).toHaveLength(1);
    expect(interval).toHaveBeenCalledTimes(1);
});

it('keeps diagnostics out of the composer and cancels the coalesced collision check on disable', () => {
    const { win, input, viewport } = page();
    let frame: FrameRequestCallback = () => {};
    win.requestAnimationFrame = vi.fn(callback => { frame = callback; return 7; });
    win.cancelAnimationFrame = vi.fn();
    Object.defineProperty(win.document.documentElement, 'clientWidth', { value: 390 });
    viewport.offsetTop = 332; viewport.height = 424;
    const controls = win.document.querySelector('[data-lmc-input-probe-controls]') as HTMLElement;
    const composer = input.closest('[data-lmc-composer]') as HTMLElement;
    vi.spyOn(controls, 'getBoundingClientRect').mockReturnValue({ left: 300, right: 384, top: 338, bottom: 388, height: 50 } as DOMRect);
    const composerRect = vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 390, top: 310, bottom: 392 } as DOMRect);
    input.focus(); frame(0);
    expect(controls.style.transform).toBe('translate(0px, 394px)'); // 400px top, below composer
    composerRect.mockReturnValue({ left: 0, right: 390, top: 332, bottom: 756 } as DOMRect);
    viewport.dispatchEvent(new win.Event('resize')); frame(0);
    expect(controls.style.visibility).toBe('hidden'); // no free space: never block typing/sending
    input.blur(); viewport.offsetTop = 0; viewport.height = 756;
    viewport.dispatchEvent(new win.Event('resize')); frame(0);
    expect(controls.style.visibility).toBe('');
    viewport.dispatchEvent(new win.Event('scroll'));
    win.__lmcStopInputLayoutProbe!();
    expect(win.cancelAnimationFrame).toHaveBeenCalledWith(7);
});
