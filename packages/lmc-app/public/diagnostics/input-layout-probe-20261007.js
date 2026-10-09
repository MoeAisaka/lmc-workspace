// Opt-in, read-only iPhone layout probe. No input text, account/session IDs,
// URLs, storage, credentials, or network reporting. Remove the query to disable.
(() => {
    if (new URLSearchParams(location.search).get('lmc_input_probe') !== '1') return;
    let timer = null, expiry = null, first = null, latest = null, worst = null;
    const timeline = [];
    const started = performance.now();
    const round = n => Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
    const rect = element => {
        const r = element.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height].map(round);
    };
    const snapshot = reason => {
        const input = document.activeElement;
        if (!(input instanceof HTMLTextAreaElement) || !input.matches('[data-lmc-text-input]')) return;
        const viewport = window.visualViewport;
        const field = rect(input), body = rect(document.body);
        const ancestors = [];
        for (let el = input.parentElement; el && ancestors.length < 18; el = el.parentElement) {
            const style = getComputedStyle(el);
            ancestors.push({
                tag: el.tagName, rect: rect(el), client: [el.clientWidth, el.clientHeight],
                scroll: [round(el.scrollLeft), round(el.scrollTop)], position: style.position,
                overflow: [style.overflowX, style.overflowY], transform: style.transform,
                inset: el.style.getPropertyValue('--lmc-keyboard-inset') || undefined,
            });
            if (el === document.body) break;
        }
        const record = {
            t: round(performance.now() - started), reason,
            viewport: viewport ? [viewport.width, viewport.height, viewport.offsetLeft, viewport.offsetTop, viewport.pageLeft, viewport.pageTop, viewport.scale].map(round) : null,
            window: [innerWidth, innerHeight, scrollX, scrollY].map(round),
            document: [document.documentElement.clientWidth, document.documentElement.clientHeight, document.documentElement.scrollTop, document.body.scrollTop].map(round),
            body, field, font: getComputedStyle(input).fontSize,
            layout: [document.documentElement.style.getPropertyValue('--lmc-layout-height'), getComputedStyle(document.body).position, getComputedStyle(document.body).zoom],
            ancestors,
        };
        const gap = viewport ? viewport.height + viewport.offsetTop - field[1] - field[3] : 0;
        record.gap = round(gap);
        first ??= record; latest = record;
        if (!worst || gap > worst.gap) worst = record;
        timeline.push([record.t, reason, record.viewport, record.window, body[1], field[1], field[3], record.gap]);
        if (timeline.length > 20) timeline.shift();
    };
    const report = () => JSON.stringify({
        schema: 'lmc-input-layout-v1',
        release: document.querySelector('meta[name="lmc-release"]')?.getAttribute('content') || 'local',
        browser: navigator.userAgent,
        screen: [screen.width, screen.height, devicePixelRatio],
        keys: { rect: 'x,y,width,height', viewport: 'width,height,offsetLeft,offsetTop,pageLeft,pageTop,scale', window: 'width,height,scrollX,scrollY', document: 'clientWidth,clientHeight,htmlScrollTop,bodyScrollTop' },
        samples: [...new Set([first, worst, latest])].filter(Boolean), timeline,
    });
    const stopSampling = () => { if (timer !== null) clearInterval(timer); timer = null; };
    const focus = () => {
        snapshot('focus');
        stopSampling();
        // Bounded and opt-in. Read only: never focus, resize, scroll or apply
        // keyboard corrections, so the probe does not change the measured bug.
        timer = setInterval(() => snapshot('sample'), 500);
        if (expiry !== null) clearTimeout(expiry);
        expiry = setTimeout(stopSampling, 120000);
    };
    document.addEventListener('focusin', event => { if (event.target?.matches?.('textarea[data-lmc-text-input]')) focus(); });
    document.addEventListener('focusout', stopSampling);
    const viewportEvent = () => snapshot('viewport');
    window.visualViewport?.addEventListener('resize', viewportEvent);
    window.visualViewport?.addEventListener('scroll', viewportEvent);
    window.addEventListener('pagehide', () => { stopSampling(); if (expiry !== null) clearTimeout(expiry); });
    const mount = () => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.lmcInputProbe = 'copy';
        button.textContent = '复制输入布局检查';
        button.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;padding:10px 12px;border:1px solid #aaa;border-radius:10px;background:#fff;color:#111;font:14px system-ui;box-shadow:0 2px 10px #0002';
        button.addEventListener('pointerdown', event => { event.preventDefault(); snapshot('copy'); });
        button.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(report());
                button.textContent = latest ? '已复制，请贴回本会话' : '已复制版本信息；尚未捕获输入';
            } catch { button.textContent = '复制失败，请允许剪贴板权限'; }
        });
        document.body.appendChild(button);
        // Expose only the same sanitized report for deterministic local checks.
        window.__lmcInputLayoutReport = report;
        if (document.activeElement?.matches?.('textarea[data-lmc-text-input]')) focus();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
    else mount();
})();
