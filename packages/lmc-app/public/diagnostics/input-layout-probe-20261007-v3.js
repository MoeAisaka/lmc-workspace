// Explicitly opted-in geometry diagnostics. No text, IDs, URLs, storage,
// credentials, or network reporting. Reload without the query to disable.
// The v287 A/B experiment is retired. Old frame query parameters are ignored;
// this probe only observes the current layout and never overrides it.
(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('lmc_input_probe') !== '1' || window.__lmcInputLayoutReport) return;
    const trial = false, mode = 'observe';
    let timer = null, expiry = null, pending = null, active = false, panel = null;
    const root = document.documentElement, started = performance.now(), runs = [];
    const round = n => Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
    const rect = element => {
        if (!element) return null;
        const r = element.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height].map(round);
    };
    const input = () => {
        const element = document.activeElement;
        return element instanceof HTMLTextAreaElement && element.matches('[data-lmc-text-input]') ? element : null;
    };
    const newRun = () => {
        const run = { mode, first: null, latest: null, keyboard: null, largestChange: null, change: -1, timeline: [] };
        runs.push(run);
        if (runs.length > 4) runs.shift();
        return run;
    };
    const current = newRun();
    const snapshot = reason => {
        const field = input();
        if (!field) return;
        const viewport = window.visualViewport, bodyStyle = getComputedStyle(document.body);
        const record = {
            t: round(performance.now() - started), reason,
            viewport: viewport ? [viewport.width, viewport.height, viewport.offsetLeft, viewport.offsetTop, viewport.pageLeft, viewport.pageTop, viewport.scale].map(round) : null,
            window: [innerWidth, innerHeight, scrollX, scrollY].map(round),
            document: [root.clientWidth, root.clientHeight, root.scrollTop, document.body.scrollTop].map(round),
            body: rect(document.body), field: rect(field),
            header: rect(document.querySelector('[data-lmc-session-header]')),
            composer: rect(field.closest('[data-lmc-composer]')),
            reference: rect(panel),
            layout: [root.style.getPropertyValue('--lmc-layout-height'), root.style.getPropertyValue('--lmc-layout-top'), bodyStyle.position, bodyStyle.top, bodyStyle.zoom, bodyStyle.bottom],
            frame: root.classList.contains('lmc-input-native-bottom') ? 'native-bottom' : root.classList.contains('lmc-input-viewport') ? 'visual-offset' : 'idle',
        };
        // Keep raw coordinate systems separate: offsetTop + height - field.bottom
        // is not a trustworthy physical-screen gap on the affected iOS browser.
        const previous = current.latest;
        const change = previous ? Math.abs(record.body[1] - previous.body[1]) + Math.abs(record.field[1] - previous.field[1]) : 0;
        current.first ??= record;
        current.latest = record;
        // Dismissal/copy can otherwise replace all full samples with idle
        // geometry, hiding the layout owner and CSS while the bug happened.
        if (viewport && viewport.height < root.clientHeight - 1) current.keyboard = record;
        if (change > current.change) { current.change = change; current.largestChange = record; }
        current.timeline.push([record.t, reason, record.viewport, record.window, record.body[1], record.field[1], record.header?.[1] ?? null, record.composer?.[1] ?? null, record.reference?.[1] ?? null, record.frame, record.layout]);
        if (current.timeline.length > 20) current.timeline.shift();
    };
    const report = () => JSON.stringify({
        schema: 'lmc-input-layout-v3',
        release: document.querySelector('meta[name="lmc-release"]')?.getAttribute('content') || 'local',
        browser: navigator.userAgent,
        screen: [screen.width, screen.height, devicePixelRatio],
        trial, mode,
        keys: {
            modes: { observe: 'read-only; no A/B overrides' },
            rect: 'x,y,width,height', viewport: 'width,height,offsetLeft,offsetTop,pageLeft,pageTop,scale',
            window: 'width,height,scrollX,scrollY', document: 'clientWidth,clientHeight,htmlScrollTop,bodyScrollTop',
            layout: 'cssHeight,cssTop,bodyPosition,bodyTop,bodyZoom,bodyBottom',
            timeline: 't,reason,viewport,window,bodyY,fieldY,headerY,composerY,referenceY,frame,layout',
        },
        runs: runs.map(run => ({ mode: run.mode, samples: [...new Set([run.first, run.largestChange, run.keyboard, run.latest])].filter(Boolean), timeline: run.timeline })),
    });
    const stopSampling = () => {
        active = false;
        if (timer !== null) clearInterval(timer);
        if (expiry !== null) clearTimeout(expiry);
        if (pending !== null) clearTimeout(pending);
        timer = expiry = pending = null;
    };
    const focus = () => {
        stopSampling();
        if (!input()) return;
        active = true;
        snapshot('focus');
        timer = setInterval(() => snapshot('sample'), 500);
        expiry = setTimeout(stopSampling, 120000);
    };
    // At most ten event samples per second; never measure the entire ancestor
    // chain on every compositor scroll, or the probe itself could add stutter.
    const viewportEvent = () => {
        if (!active || pending !== null) return;
        pending = setTimeout(() => { pending = null; snapshot('viewport'); }, 100);
    };
    document.addEventListener('focusin', event => { if (event.target?.matches?.('textarea[data-lmc-text-input]')) focus(); });
    document.addEventListener('focusout', stopSampling);
    window.visualViewport?.addEventListener('resize', viewportEvent);
    window.visualViewport?.addEventListener('scroll', viewportEvent);
    window.addEventListener('pagehide', stopSampling);
    window.addEventListener('pageshow', focus);
    const mount = () => {
        panel = document.createElement('div');
        panel.dataset.lmcInputProbePanel = 'true';
        panel.style.cssText = 'position:fixed;top:6px;right:6px;z-index:2147483647;display:flex;flex-wrap:wrap;gap:4px;max-width:calc(100vw - 12px);padding:4px;border:1px solid #aaa;border-radius:10px;background:#fff;color:#111;font:12px system-ui;box-shadow:0 2px 10px #0002';
        // Outside the shifted/zoomed body: this is also the raw native-fixed
        // reference in the report and video. Do not move it using viewport JS.
        root.appendChild(panel);
        const makeButton = (key, text, handler) => {
            const button = document.createElement('button');
            button.type = 'button'; button.dataset.lmcInputProbe = key; button.textContent = text;
            button.style.cssText = 'appearance:none;min-height:36px;padding:6px 9px;border:1px solid #ccd0d6;border-radius:7px;background:#fff;color:#111;font:13px system-ui;touch-action:manipulation';
            // WebKit suppresses the compatibility click when pointerdown is
            // cancelled to retain the textarea focus. Activate on pointerup,
            // with a movement/cancel guard; keep click(detail=0) for keyboard/AT.
            let press = null;
            button.addEventListener('pointerdown', event => {
                if (event.button !== 0 || event.isPrimary === false) return;
                event.preventDefault();
                press = { id: event.pointerId, x: event.clientX, y: event.clientY };
            });
            button.addEventListener('pointerup', event => {
                const down = press; press = null;
                if (!down || down.id !== event.pointerId) return;
                event.preventDefault();
                const bounds = button.getBoundingClientRect();
                if (Math.hypot(event.clientX - down.x, event.clientY - down.y) <= 12
                    && event.clientX >= bounds.left && event.clientX <= bounds.right
                    && event.clientY >= bounds.top && event.clientY <= bounds.bottom) handler();
            });
            button.addEventListener('pointercancel', () => { press = null; });
            button.addEventListener('mousedown', event => event.preventDefault());
            button.addEventListener('click', event => { if (event.detail === 0) handler(); else event.preventDefault(); });
            panel.appendChild(button);
            return button;
        };
        const copy = makeButton('copy', '复制检查', async () => {
            snapshot('copy');
            try {
                await navigator.clipboard.writeText(report());
                copy.textContent = runs.some(run => run.latest) ? '已复制' : '已复制；尚未输入';
            } catch { copy.textContent = '复制失败'; }
        });
        window.__lmcInputLayoutReport = report;
        focus();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
    else mount();
})();
