// Actual exported components + synthetic sessions. No account or business messages.
// LMC_PLAYWRIGHT_MODULE=/path/to/playwright [LMC_WEBKIT=1] node keyboard-input.cjs EXPORT
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const build = path.resolve(process.argv[2]);
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lmc-keyboard-check-'));
const child = spawn(process.execPath, [path.join(__dirname, 'session-header.cjs'), build, '--serve'], { stdio: ['ignore', 'pipe', 'inherit'] });
const { chromium, webkit } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const checks = [], failures = [], errors = [];
const check = (condition, label, details) => { checks.push({ label, passed: !!condition, details }); if (!condition) failures.push(label); };
let browser;
(async () => {
    const url = await new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('Fixture startup timeout')), 15000);
        child.stdout.on('data', chunk => { output += chunk; const match = output.match(/Fixture: (http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}`)); });
    });
    browser = await (process.env.LMC_WEBKIT ? webkit : chromium).launch({ headless: true, ...(!process.env.LMC_WEBKIT && process.env.LMC_CHROME_PATH ? { executablePath: process.env.LMC_CHROME_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 820, height: 1080 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
    // Define the host-property mock before loading compiled application code.
    // Mid-run replacement produced stale reads in a WebKit callback; keep
    // one accessor and change only the synthetic height's backing value.
    await context.addInitScript(() => {
        const nativeHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
        if (!nativeHeight?.get) throw new Error('Expected a native innerHeight getter');
        window.fixtureLayoutHeight = null;
        Object.defineProperty(window, 'innerHeight', {
            configurable: true,
            get: () => window.fixtureLayoutHeight ?? nativeHeight.get.call(window),
        });
    });
    if (process.env.LMC_FORCE_MIRROR) await context.addInitScript(() => {
        const supports = CSS.supports.bind(CSS);
        CSS.supports = (...args) => args[0] === 'field-sizing' && args[1] === 'content' ? false : supports(...args);
    });
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); const field = page.locator('textarea:not([aria-hidden="true"])').first(); await field.waitFor();
    await page.waitForTimeout(350);
    await page.evaluate(() => {
        setMeta({ engineAuth: { status: 'ready', checkedAt: Date.now() }, sessionConfigState: 'applied', sessionConfigError: null });
        window.inputProbe = { writes: 0, sends: [], blurs: 0, node: document.querySelector('textarea') };
        const original = storage.getState().updateSessionDraft;
        storage.setState({ updateSessionDraft: (...args) => { inputProbe.writes++; return original(...args); } });
        inputProbe.node.addEventListener('blur', () => inputProbe.blurs++);
        sync.sendMessage = async (sessionId, text) => { inputProbe.sends.push({ sessionId, text }); };
    });
    await field.focus(); await field.pressSequentially('abcdefghi', { delay: 35 });
    const typing = await page.evaluate(() => ({ writes: inputProbe.writes, same: inputProbe.node === document.querySelector('textarea'), focused: document.activeElement === inputProbe.node }));
    check(typing.writes === 1 && typing.same && typing.focused, 'typing is debounced and keeps focus', typing);
    check(await page.evaluate(() => getComputedStyle(document.body).position === 'static'), 'focused composer keeps the document in normal flow');
    for (const height of [750, 450, 600, 1080]) {
        await page.evaluate(height => { Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => height }); visualViewport.dispatchEvent(new Event('resize')); }, height);
        await page.waitForTimeout(120);
        const geometry = await field.evaluate(element => ({ bottom: element.getBoundingClientRect().bottom, viewportBottom: visualViewport.height + visualViewport.offsetTop, same: element === inputProbe.node, focused: document.activeElement === element, text: element.value }));
        check(geometry.bottom <= geometry.viewportBottom + 2 && geometry.same && geometry.focused && geometry.text === 'abcdefghi', `keyboard visible height ${height}`, geometry);
    }
    // Replay keyboard opening/closing geometry from the iOS report. Translate
    // the body by the VISUAL offset only, rather than translating html by total
    // document scroll (which creates a containing block and breaks fixed CSS).
    // This is only a visual-coordinate model, not a native software keyboard.
    // Real document scroll, before app event handlers, is tested separately.
    await page.setViewportSize({ width: 440, height: 756 });
    await page.evaluate(() => {
        window.nativePanReplay = { scrollY: Object.getOwnPropertyDescriptor(window, 'scrollY') };
        Object.defineProperty(window, 'scrollY', { configurable: true, get: () => window.fixturePan || 0 });
    });
    for (const [visible, pan, layout] of [[756, 0, 756], [447, 309, 447], [424, 218, 538], [756, 0, 756]]) {
        await page.evaluate(({ visible, pan, layout }) => {
            window.fixturePan = pan; window.fixtureLayoutHeight = layout;
            document.body.style.translate = `0 ${-pan}px`;
            // Chromium retains a 0.54 mobile auto-fit scale after the previous
            // tablet viewport. Replay the captured scale=1 too; otherwise the
            // app correctly opts out of keyboard correction for pinch zoom.
            for (const [key, value] of Object.entries({ width: 440, height: visible, offsetTop: pan, pageTop: pan, scale: 1 })) {
                Object.defineProperty(visualViewport, key, { configurable: true, get: () => value });
            }
            visualViewport.dispatchEvent(new Event('resize'));
            visualViewport.dispatchEvent(new Event('scroll'));
        }, { visible, pan, layout });
        await page.waitForTimeout(180);
        const geometry = await field.evaluate(element => ({
            bodyTop: document.body.getBoundingClientRect().top, bodyHeight: document.body.getBoundingClientRect().height,
            headerTop: document.querySelector('[data-lmc-session-header]').getBoundingClientRect().top,
            fieldTop: element.getBoundingClientRect().top, fieldBottom: element.getBoundingClientRect().bottom,
            same: element === inputProbe.node, focused: document.activeElement === element, text: element.value,
            cssFocused: element.matches(':focus'), scale: visualViewport.scale,
            visualHeight: visualViewport.height, pageTop: visualViewport.pageTop, scrollY,
            layoutTop: document.documentElement.style.getPropertyValue('--lmc-layout-top'),
            editingFrame: document.documentElement.classList.contains('lmc-input-viewport'),
        }));
        check(geometry.scale === 1 && !geometry.editingFrame && Math.abs(geometry.bodyTop + pan) <= 1 && Math.abs(geometry.headerTop) <= 1
            && Math.abs(geometry.bodyHeight - 756) <= 1 && geometry.bodyTop + geometry.bodyHeight >= visible - 1 && geometry.fieldTop >= 0
            && Math.abs(visible - geometry.fieldBottom - 77) <= 2
            && geometry.same && geometry.focused && geometry.text === 'abcdefghi',
            `iPhone report replay: visual ${visible}, pan ${pan}, inner ${layout}`, geometry);
        if (pan === 218) await page.screenshot({ path: path.join(out, 'iphone-report-replay.png') });
    }
    await page.evaluate(() => {
        Object.defineProperty(window, 'scrollY', window.nativePanReplay.scrollY);
        delete window.fixturePan;
        document.body.style.removeProperty('translate');
        window.fixtureLayoutHeight = 424;
        for (const [key, value] of Object.entries({height: 424, offsetTop: 332, scale: 1})) {
            Object.defineProperty(visualViewport, key, {configurable: true, get: () => value});
        }
        Object.defineProperty(visualViewport, 'pageTop', {configurable: true, get: () => scrollY});
        visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(800);
    const rootFrames = await page.evaluate(() => {
        const frames = [];
        // Same captured panning values: never mutate the document frame to
        // chase them. Composer occlusion is tested separately, once per frame.
        for (const offset of [332, 365.7, 332, 433.7, 454.7, 465.7, 332]) {
            Object.defineProperty(visualViewport, 'offsetTop', {configurable: true, get: () => offset});
            visualViewport.dispatchEvent(new Event('scroll'));
            frames.push({offset, bodyY: document.body.getBoundingClientRect().top,
                height: document.body.getBoundingClientRect().height,
                position: getComputedStyle(document.body).position,
                rootStyle: document.documentElement.style.cssText,
                field: inputProbe.node.getBoundingClientRect().top,
                same: inputProbe.node === document.querySelector('textarea'), focused: document.activeElement === inputProbe.node});
        }
        return frames;
    });
    check(rootFrames.every(r => r.position === 'static' && r.rootStyle === rootFrames[0].rootStyle
        && Math.abs(r.bodyY) <= 1 && Math.abs(r.height - 756) <= 1 && r.same && r.focused),
        'caret offsets never resize or reposition the document', rootFrames);
    if (process.argv.includes('--frame-anchor-only')) return;
    await page.evaluate(() => {
        // Resume the visual-only model for the separate REAL document scroll
        // check; do not leave a mocked 424px window over a real 756px viewport.
        window.fixtureLayoutHeight = null;
        Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, get: () => 0 });
        visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(100);
    const nativeScroll = await page.evaluate(() => {
        // Desktop overflow locks normally prevent document panning, while the
        // device keyboard bypasses those locks. Enable an actual document
        // scroll range solely in this fixture. Do not mock scrollY or translate
        // the root: doing so removes the native behavior we need to test.
        const styles = [document.documentElement, document.body].map(element => ({
            element, value: element.style.getPropertyValue('overflow'), priority: element.style.getPropertyPriority('overflow'),
        }));
        styles.forEach(({ element }) => element.style.setProperty('overflow', 'visible', 'important'));
        const range = document.createElement('div');
        Object.assign(range.style, { position: 'absolute', top: '0', left: '0', width: '1px', height: '2000px', pointerEvents: 'none' });
        document.documentElement.appendChild(range);
        scrollTo(0, 0); visualViewport.dispatchEvent(new Event('scroll'));
        const cssBefore = document.documentElement.style.getPropertyValue('--lmc-layout-top');
        const frames = [];
        // Stay in one JS task before application scroll callbacks. The document
        // must use its native coordinates, not a JS-maintained fixed layer.
        for (const pan of [25, 8, 40, 16, 0]) {
            scrollTo(0, pan);
            frames.push({ requested: pan, actual: scrollY,
                body: document.body.getBoundingClientRect().top,
                header: document.querySelector('[data-lmc-session-header]').getBoundingClientRect().top,
                field: inputProbe.node.getBoundingClientRect().top,
                same: inputProbe.node === document.querySelector('textarea'), focused: document.activeElement === inputProbe.node,
                cssTop: document.documentElement.style.getPropertyValue('--lmc-layout-top'),
            });
        }
        range.remove();
        styles.forEach(({ element, value, priority }) => {
            if (value) element.style.setProperty('overflow', value, priority);
            else element.style.removeProperty('overflow');
        });
        return { cssBefore, frames };
    });
    check(nativeScroll.frames.every(r => r.actual === r.requested && Math.abs(r.body + r.actual) <= 1
        && Math.abs(r.header + r.actual) <= 1 && Math.abs(r.field - (305 - r.actual)) <= 1
        && r.cssTop === nativeScroll.cssBefore && r.same && r.focused),
        'native document scroll remains native, without a second body correction', nativeScroll);
    await page.evaluate(() => {
        window.fixtureLayoutHeight = null;
        for (const key of ['width', 'height', 'offsetTop', 'pageTop', 'scale']) delete visualViewport[key];
        visualViewport.dispatchEvent(new Event('resize'));
    });
    // iOS may scroll a clipped ancestor to reveal the focused field after the
    // visual viewport has already resized. Recreate the actual DOM scroll,
    // without a second visualViewport event or replacing the focused input.
    for (const mode of [{ width: 820, height: 1080, target: 'scene' }, { width: 390, height: 844, target: 'scene' }, { width: 390, height: 844, target: 'document' }]) {
        await page.setViewportSize({ width: mode.width, height: mode.height });
        await page.evaluate(() => { Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => 450 }); visualViewport.dispatchEvent(new Event('resize')); });
        // The comparison needs the keyboard-open baseline, not the previous
        // 1080px frame. Chromium may deliver its RAF after a fixed 100ms wait.
        // The previous mode's inset can survive one frame after the resize;
        // take the baseline only once the lifted position holds for two polls.
        await page.waitForFunction(() => {
            const bottom = document.querySelector('textarea').getBoundingClientRect().bottom;
            const stable = bottom <= 452 && window.__lmcBaselineBottom === bottom;
            window.__lmcBaselineBottom = bottom;
            return stable;
        }, null, { timeout: 2000, polling: 120 });
        const beforePan = await field.evaluate(element => element.getBoundingClientRect().bottom);
        const requestedPan = await page.evaluate(target => {
            const scene = target === 'document' ? document.body : document.querySelector('[data-testid="scene"]');
            scene.style.overflow = 'hidden';
            const filler = document.createElement('div'); filler.id = 'keyboard-pan-fixture';
            Object.assign(filler.style, { position: 'absolute', top: '100%', height: '760px', width: '1px' });
            scene.appendChild(filler);
            // v291's reveal steps are 54px after JS already lifted the dock.
            // Forcing the entire keyboard height again would deliberately
            // scroll the now-visible caret above the screen, not reveal it.
            const pan = target === 'document' ? 54 : 720;
            if (target === 'document') window.scrollTo(0, pan); else scene.scrollTop = pan;
            return pan;
        }, mode.target);
        await page.waitForFunction(({ target, bottom }) => {
            const scene = document.querySelector('[data-testid="scene"]');
            return (target === 'document' || scene.scrollTop === 0)
                && Math.abs(document.querySelector('textarea').getBoundingClientRect().bottom - (bottom - (target === 'document' ? 54 : 0))) <= 2;
        }, { target: mode.target, bottom: beforePan }, { timeout: 1200 }).catch(() => {});
        const afterPan = await field.evaluate((element, target) => ({
            bottom: element.getBoundingClientRect().bottom, same: inputProbe.node === element,
            focused: document.activeElement === element,
            scroll: target === 'document' ? scrollY : document.querySelector('[data-testid="scene"]').scrollTop,
            scale: visualViewport.scale, pageTop: visualViewport.pageTop, offsetTop: visualViewport.offsetTop,
            sceneOverflow: getComputedStyle(document.querySelector('[data-testid="scene"]')).overflow,
        }), mode.target);
        check(afterPan.scroll === (mode.target === 'document' ? requestedPan : 0)
            && Math.abs(afterPan.bottom - (beforePan - (mode.target === 'document' ? requestedPan : 0))) <= 2
            && afterPan.bottom > 42 && afterPan.bottom <= 450 && afterPan.same && afterPan.focused,
            `${mode.width}/${mode.target}: native caret pan is preserved and clipped inner scroll is prevented`, { requestedPan, beforePan, ...afterPan });
        await page.screenshot({ path: path.join(out, `keyboard-pan-${mode.width}-${mode.target}.png`) });
        await page.evaluate(() => {
            const scene = document.querySelector('[data-testid="scene"]'); scene.scrollTop = 0;
            window.scrollTo(0, 0);
            document.getElementById('keyboard-pan-fixture').remove();
            delete visualViewport.height; visualViewport.dispatchEvent(new Event('resize'));
        });
    }
    await page.setViewportSize({ width: 820, height: 1080 });
    await page.waitForTimeout(2100);
    check(await page.evaluate(() => inputProbe.writes === 2), 'one final draft save after idle', await page.evaluate(() => inputProbe.writes));
    await page.evaluate(() => {
        inputProbe.heightReads = 0;
        let prototype = inputProbe.node;
        while (!Object.getOwnPropertyDescriptor(prototype, 'scrollHeight')) prototype = Object.getPrototypeOf(prototype);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'scrollHeight');
        Object.defineProperty(prototype, 'scrollHeight', { ...descriptor, get() {
            if (this.tagName === 'TEXTAREA') inputProbe.heightReads++;
            return descriptor.get.call(this);
        } });
    });
    await field.pressSequentially('abcdefghijklmnopqrstuvwxyz', { delay: 20 });
    await page.waitForTimeout(100);
    check(await page.evaluate(() => inputProbe.heightReads === 0), '26 ordinary characters need no JavaScript textarea height reads', await page.evaluate(() => ({ reads: inputProbe.heightReads, nativeSizing: inputProbe.node.parentElement.dataset.nativeSizing })));
    for (const flavor of ['claude', 'codex']) {
        await page.evaluate(flavor => { setFlavor(flavor); storage.getState().applySettingsLocal({ agentInputEnterToSend: true }); inputProbe.sends = []; }, flavor);
        await field.fill('候选确认');
        await field.dispatchEvent('compositionstart', { data: '候选' });
        await field.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
        await field.dispatchEvent('compositionend', { data: '候选确认' });
        await field.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true });
        check(await page.evaluate(() => inputProbe.sends.length === 0), `${flavor} IME confirmation does not send`);
        await field.press('Shift+Enter');
        check((await field.inputValue()).includes('\n') && await page.evaluate(() => inputProbe.sends.length === 0), `${flavor} Shift+Enter is a newline`);
        await field.fill(`${flavor} 回车发送`); await field.press('Enter'); await page.waitForTimeout(150);
        const send = await page.evaluate(() => ({ sends: inputProbe.sends, text: inputProbe.node.value, focused: document.activeElement === inputProbe.node, coarse: matchMedia('(pointer: coarse)').matches }));
        check(send.coarse && send.sends.length === 1 && send.sends[0].text === `${flavor} 回车发送` && send.text === '' && send.focused, `${flavor} touch Enter sends once and keeps focus`, send);
    }
    await field.fill('长草稿\n'.repeat(45));
    await page.evaluate(() => { Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => 450 }); visualViewport.dispatchEvent(new Event('resize')); });
    await page.waitForTimeout(150);
    const long = await field.evaluate(element => ({ height: element.getBoundingClientRect().height, bottom: element.getBoundingClientRect().bottom, top: element.getBoundingClientRect().top, focused: document.activeElement === element }));
    check(long.height <= 202 && long.top >= 0 && long.bottom <= 450 && long.focused, 'long draft leaves keyboard and actions usable', long);
    const draftScroll = await field.evaluate(element => {
        element.scrollTop = 180;
        return { scrollTop: element.scrollTop, overflowY: getComputedStyle(element).overflowY, text: element.value };
    });
    check(draftScroll.scrollTop > 0 && draftScroll.overflowY === 'auto' && draftScroll.text.startsWith('长草稿'), 'outer focus lock preserves long draft scrolling', draftScroll);
    await page.screenshot({ path: path.join(out, 'tablet-keyboard.png') });
    await page.evaluate(() => { delete visualViewport.height; visualViewport.dispatchEvent(new Event('resize')); });
    for (const viewport of [{ width: 1080, height: 820 }, { width: 820, height: 1080 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport); await page.evaluate(() => { window.dispatchEvent(new Event('pageshow')); document.dispatchEvent(new Event('visibilitychange')); });
        await page.waitForTimeout(400);
        const state = await field.evaluate(element => ({ same: inputProbe.node === element, focused: document.activeElement === element, text: element.value, right: element.getBoundingClientRect().right, viewport: innerWidth }));
        check(state.same && state.focused && state.text.startsWith('长草稿') && state.right <= state.viewport + 2, `rotation/restore ${viewport.width}`, state);
    }
    await field.press('Enter');
    await page.waitForTimeout(150);
    const cleared = await field.evaluate(element => ({ text: element.value, height: element.getBoundingClientRect().height, focused: document.activeElement === element }));
    check(cleared.text === '' && cleared.height <= 60 && cleared.focused, 'sending a long draft immediately restores short input height', cleared);
    await field.fill('宽度适配'.repeat(15));
    await page.waitForTimeout(50);
    const fullHeight = await field.evaluate(element => element.getBoundingClientRect().height);
    await field.evaluate(element => { element.parentElement.style.width = '50%'; });
    await page.waitForTimeout(150);
    const narrowHeight = await field.evaluate(element => element.getBoundingClientRect().height);
    check(narrowHeight > fullHeight, 'field remeasures wrapping after a pane width change without window resize', { fullHeight, narrowHeight });
    await field.evaluate(element => { element.parentElement.style.width = '100%'; });
    await field.fill('');
    await field.blur();
    check(await page.evaluate(() => !document.documentElement.classList.contains('lmc-input-viewport')), 'blur keeps the normal-flow page shell');
    for (const height of [620, 740, 560]) {
        // Exercise actual CSS viewport changes. Overriding innerHeight alone
        // cannot emulate dvh or browser chrome and must not define page height.
        await page.evaluate(() => { window.fixtureLayoutHeight = null; delete visualViewport.height; });
        await page.setViewportSize({width: 390, height});
        await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
        await page.waitForFunction(height => Math.abs(document.body.getBoundingClientRect().height - height) <= 1, height, { timeout: 1200 });
        const geometry = await field.evaluate(element => ({
            bodyHeight: document.body.getBoundingClientRect().height,
            layoutHeight: document.documentElement.style.getPropertyValue('--lmc-layout-height'),
            innerHeight, visualHeight: visualViewport.height,
            cssBodyHeight: getComputedStyle(document.body).height,
            zoom: getComputedStyle(document.body).zoom,
            bottom: element.getBoundingClientRect().bottom,
            headerTop: document.querySelector('[data-lmc-session-header]')?.getBoundingClientRect().top,
            same: inputProbe.node === element,
        }));
        check(Math.abs(geometry.bodyHeight - height) <= 1 && geometry.bottom <= height && geometry.headerTop === 0 && geometry.same, `browser chrome / foreground height ${height}`, geometry);
    }
    await page.screenshot({ path: path.join(out, 'phone-toolbar.png') });
    check(errors.length === 0, 'no script errors', errors);
    await context.close();
})().catch(error => { failures.push(String(error)); }).finally(async () => {
    await browser?.close(); child.kill('SIGTERM');
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ build, engine: process.env.LMC_WEBKIT ? 'webkit' : 'chromium', forceMirror: !!process.env.LMC_FORCE_MIRROR, checks, failures, errors }, null, 2));
    console.log(JSON.stringify({ out, checks: checks.length, failures }, null, 2));
    if (failures.length) process.exitCode = 1;
});
