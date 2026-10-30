// Explicitly opted-in geometry diagnostics. No text, IDs, URLs, storage,
// credentials, or network reporting. Developer Mode can dispose this probe live.
// The v287 A/B experiment is retired. Old frame query parameters are ignored;
// this probe only observes the current layout and never overrides it.
// v8 (2026-10-11): controls follow the visual viewport; the raw fixed
// reference stays unshifted. Only diagnostic UI is moved.
// v7 (2026-10-10): the blank strip under the composer appears at random. Per
// keyboard open this version also logs the raw order of viewport resize /
// pan events against the composer's own lift and backdrop writes, and the
// remembered reveal strip the composer pre-lifts by. Still read-only.
(() => {
    const params = new URLSearchParams(location.search);
    if (!(window.__lmcInputProbeEnabled ?? (params.get('lmc_input_probe') === '1')) || window.__lmcStopInputLayoutProbe || window.__lmcInputLayoutReport) return;
    let disposed = false;
    const cleanups = [];
    const listen = (target, type, handler, options) => {
        target?.addEventListener(type, handler, options);
        cleanups.push(() => target?.removeEventListener(type, handler, options));
    };
    const trial = false, mode = 'observe';
    let positionControls = () => {};
    let timer = null, expiry = null, pending = null, active = false, panel = null, controls = null;
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
    // What the composer remembered about this browser's keyboard (no scope
    // string: it only repeats the user agent and screen size reported below).
    const learned = () => {
        try {
            const raw = localStorage.getItem('lmc.ios-keyboard-reveal-gap.v2');
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            const scope = `${navigator.userAgent}|${screen.height}|${root.clientHeight}`;
            return { lift: parsed.gap ?? null, keyboardHeight: parsed.keyboardHeight ?? null, misses: parsed.misses ?? null, disabled: parsed.disabled === true, scopeMatches: parsed.scope === scope };
        } catch { return null; }
    };
    const newRun = () => {
        const run = { mode, first: null, latest: null, keyboard: null, largestChange: null, change: -1, timeline: [], changes: [], signature: null, events: [], learnedAtFocus: learned() };
        runs.push(run);
        if (runs.length > 4) runs.shift();
        return run;
    };
    let current = newRun();
    let owner = null, ownerObserver = null, lastDock = '';
    const dockValues = () => owner ? [owner.style.getPropertyValue('--lmc-keyboard-inset') || '', owner.style.getPropertyValue('--lmc-dock-extension') || ''] : ['', ''];
    // One cheap row per event, keeping the order of resize / pan / lift /
    // backdrop that 500ms samples lose. Pan events carry no field rect: a
    // pan does not move the field in the document, and a layout read on
    // every compositor scroll could add stutter of the probe's own.
    const event = type => {
        if (!active) return;
        if (type === 'focus' || type === 'dock') positionControls();
        const field = type.endsWith('-scroll') ? null : input();
        const viewport = window.visualViewport, dock = dockValues();
        const row = [round(performance.now() - started), type,
            viewport ? round(viewport.height) : null, viewport ? round(viewport.offsetTop) : null, viewport ? round(viewport.pageTop) : null,
            round(innerHeight), round(scrollY), field ? round(field.getBoundingClientRect().bottom) : null, dock[0], dock[1]];
        current.events.push(row);
        if (current.events.length > 240) current.events.splice(120, 1);
    };
    const handling = field => {
        let owner = field;
        while (owner && !owner.style.getPropertyValue('--lmc-keyboard-inset')) owner = owner.parentElement;
        return [field.dataset.lmcFocusScroll || 'native',
            owner?.style.getPropertyValue('--lmc-keyboard-inset') || '',
            owner?.style.getPropertyValue('--lmc-composer-max-height') || '',
            field.parentElement?.dataset.nativeSizing || '',
            owner?.style.getPropertyValue('--lmc-dock-extension') || ''];
    };
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
            controls: rect(controls),
            handling: handling(field),
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
        const row = [record.t, reason, record.viewport, record.window, record.body[1], record.field[1], record.header?.[1] ?? null, record.composer?.[1] ?? null, record.reference?.[1] ?? null, record.frame, record.layout, record.handling];
        current.timeline.push(row);
        // A long stable tail previously erased all keyboard-opening movement.
        // Keep geometry changes separately: first 24 + latest 24, bounded.
        // Time/reason/reference-panel changes alone are not page movement.
        const signature = JSON.stringify([record.viewport, record.window, record.body, record.field, record.header, record.composer, record.layout, record.handling]);
        if (signature !== current.signature) {
            current.signature = signature;
            current.changes.push(row);
            if (current.changes.length > 48) current.changes.splice(24, 1);
        }
        if (current.timeline.length > 20) current.timeline.shift();
    };
    const report = () => JSON.stringify({
        schema: 'lmc-input-layout-v9',
        release: document.querySelector('meta[name="lmc-release"]')?.getAttribute('content') || 'local',
        browser: navigator.userAgent,
        screen: [screen.width, screen.height, devicePixelRatio],
        trial, mode,
        keys: {
            modes: { observe: 'read-only; no A/B overrides' },
            reference: 'unshifted native-fixed wrapper; controls is the viewport-following copy UI',
            rect: 'x,y,width,height', viewport: 'width,height,offsetLeft,offsetTop,pageLeft,pageTop,scale',
            window: 'width,height,scrollX,scrollY', document: 'clientWidth,clientHeight,htmlScrollTop,bodyScrollTop',
            layout: 'cssHeight,cssTop,bodyPosition,bodyTop,bodyZoom,bodyBottom',
            handling: 'focusScroll,composerInset,composerMaxHeight,nativeFieldSizing,dockExtension',
            changes: 'same columns as timeline; geometry changes only, first 24 + latest 24',
            timeline: 't,reason,viewport,window,bodyY,fieldY,headerY,composerY,referenceY,frame,layout,handling',
            events: 't,type,visualHeight,visualOffsetTop,visualPageTop,innerHeight,scrollY,fieldBottom,composerInset,dockExtension; first 120 + latest 120 per keyboard open',
            learned: 'lift,keyboardHeight,misses,disabled,scopeMatches: the composer\'s remembered reveal strip at focus (learnedAtFocus) and at copy (learnedNow)',
        },
        learnedNow: learned(),
        runs: runs.map(run => ({ mode: run.mode, learnedAtFocus: run.learnedAtFocus, events: run.events, samples: [...new Set([run.first, run.largestChange, run.keyboard, run.latest])].filter(Boolean), timeline: run.timeline, changes: run.changes })),
    });
    const stopSampling = () => {
        if (active) event('blur');
        active = false;
        ownerObserver?.disconnect(); ownerObserver = null; owner = null;
        if (timer !== null) clearInterval(timer);
        if (expiry !== null) clearTimeout(expiry);
        if (pending !== null) clearTimeout(pending);
        timer = expiry = pending = null;
    };
    const focus = () => {
        stopSampling();
        const field = input();
        if (!field) return;
        active = true;
        if (current.latest) current = newRun();
        else current.learnedAtFocus = learned();
        owner = field;
        while (owner && !owner.style.getPropertyValue('--lmc-keyboard-inset')) owner = owner.parentElement;
        lastDock = dockValues().join('|');
        if (owner && typeof MutationObserver !== 'undefined') {
            ownerObserver = new MutationObserver(() => {
                const next = dockValues().join('|');
                if (next !== lastDock) { lastDock = next; event('dock'); }
            });
            ownerObserver.observe(owner, { attributes: true, attributeFilter: ['style'] });
        }
        event('focus');
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
    listen(document, 'focusin', event => { if (event.target?.matches?.('textarea[data-lmc-text-input]')) focus(); });
    listen(document, 'focusout', stopSampling);
    listen(window.visualViewport, 'resize', viewportEvent);
    listen(window.visualViewport, 'scroll', viewportEvent);
    listen(window.visualViewport, 'resize', () => event('vv-resize'));
    listen(window.visualViewport, 'scroll', () => event('vv-scroll'));
    listen(window, 'resize', () => event('win-resize'));
    listen(window, 'scroll', e => { if (e.target === document || e.target === window) event('win-scroll'); }, { capture: true, passive: true });
    listen(document, 'touchstart', () => event('touchstart'), { capture: true, passive: true });
    listen(document, 'touchend', () => event('touchend'), { capture: true, passive: true });
    listen(window, 'pagehide', stopSampling);
    listen(window, 'pageshow', focus);
    const mount = () => {
        if (disposed) return;
        panel = document.createElement('div');
        panel.dataset.lmcInputProbePanel = 'true';
        // Keep the raw reference outside the shifted/zoomed body. Moving its
        // child leaves the reference's native-fixed coordinates uncorrected.
        panel.style.cssText = 'position:fixed;top:6px;right:6px;z-index:2147483647;pointer-events:none';
        controls = document.createElement('div');
        controls.dataset.lmcInputProbeControls = 'true';
        controls.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;max-width:calc(100vw - 12px);padding:4px;border:1px solid #aaa;border-radius:10px;background:#fff;color:#111;font:12px system-ui;box-shadow:0 2px 10px #0002;pointer-events:auto';
        panel.appendChild(controls);
        root.appendChild(panel);
        // A keyboard can pan the visual viewport past the layout viewport's
        // top. Only translate this diagnostic control, never body/composer.
        // No rect reads on scroll: preserve the probe's cheap event recording.
        let placementFrame = null;
        const placeControls = () => {
            const viewport = window.visualViewport;
            const x = viewport ? viewport.offsetLeft + viewport.width - (root.clientWidth || innerWidth) : 0;
            const y = viewport ? viewport.offsetTop : 0;
            controls.style.transform = `translate(${x}px, ${y}px)`;
            controls.style.visibility = input() && typeof requestAnimationFrame === 'function' ? 'hidden' : '';
            if (placementFrame !== null || typeof requestAnimationFrame !== 'function') return;
            // A panned/resized composer can occupy the same corner as the
            // diagnostic button. Never let that overlay intercept Send.
            // Coalesce collision reads into one frame; do not move the composer.
            placementFrame = requestAnimationFrame(() => {
                placementFrame = null;
                if (disposed) return;
                const composer = input()?.closest('[data-lmc-composer]');
                if (!composer) { controls.style.visibility = ''; return; }
                const box = controls.getBoundingClientRect(), field = composer.getBoundingClientRect();
                if (box.right <= field.left || box.left >= field.right || box.bottom <= field.top || box.top >= field.bottom) { controls.style.visibility = ''; return; }
                const vv = window.visualViewport;
                const top = vv?.offsetTop ?? 0, bottom = top + (vv?.height ?? innerHeight);
                const target = field.top - box.height - 8 >= top + 6 ? field.top - box.height - 8
                    : field.bottom + 8 + box.height <= bottom - 6 ? field.bottom + 8 : null;
                if (target === null) { controls.style.visibility = 'hidden'; return; }
                const dx = vv ? vv.offsetLeft + vv.width - (root.clientWidth || innerWidth) : 0;
                controls.style.transform = `translate(${dx}px, ${top + target - box.top}px)`;
                controls.style.visibility = '';
            });
        };
        positionControls = placeControls;
        cleanups.push(() => {
            if (placementFrame !== null) cancelAnimationFrame(placementFrame);
            positionControls = () => {};
        });
        listen(window.visualViewport, 'resize', placeControls);
        listen(window.visualViewport, 'scroll', placeControls);
        listen(window, 'resize', placeControls);
        listen(window, 'pageshow', placeControls);
        placeControls();
        const makeButton = (key, text, handler) => {
            const button = document.createElement('button');
            button.type = 'button'; button.dataset.lmcInputProbe = key; button.textContent = text;
            button.style.cssText = 'appearance:none;min-height:36px;padding:6px 9px;border:1px solid #ccd0d6;border-radius:7px;background:#fff;color:#111;font:13px system-ui;touch-action:manipulation';
            // WebKit suppresses the compatibility click when pointerdown is
            // cancelled to retain the textarea focus. Activate on pointerup,
            // with a movement/cancel guard; keep click(detail=0) for keyboard/AT.
            let press = null;
            listen(button, 'pointerdown', event => {
                if (event.button !== 0 || event.isPrimary === false) return;
                event.preventDefault();
                press = { id: event.pointerId, x: event.clientX, y: event.clientY };
            });
            listen(button, 'pointerup', event => {
                const down = press; press = null;
                if (!down || down.id !== event.pointerId) return;
                event.preventDefault();
                const bounds = button.getBoundingClientRect();
                if (Math.hypot(event.clientX - down.x, event.clientY - down.y) <= 12
                    && event.clientX >= bounds.left && event.clientX <= bounds.right
                    && event.clientY >= bounds.top && event.clientY <= bounds.bottom) handler();
            });
            listen(button, 'pointercancel', () => { press = null; });
            listen(button, 'mousedown', event => event.preventDefault());
            listen(button, 'click', event => { if (event.detail === 0) handler(); else event.preventDefault(); });
            controls.appendChild(button);
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
    window.__lmcStopInputLayoutProbe = () => {
        if (disposed) return;
        disposed = true;
        stopSampling();
        cleanups.splice(0).forEach(remove => remove());
        panel?.remove();
        delete window.__lmcInputLayoutReport;
        delete window.__lmcStopInputLayoutProbe;
    };
    if (document.readyState === 'loading') listen(document, 'DOMContentLoaded', mount, { once: true });
    else mount();
})();
