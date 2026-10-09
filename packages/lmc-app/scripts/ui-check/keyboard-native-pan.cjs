// Exported components + recorded iPhone viewport event orders. The OSK itself
// is NOT emulated; native pan is supplied as data. No account/network/messages.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {webkit, chromium} = require(process.env.LMC_PLAYWRIGHT_MODULE);
const build = path.resolve(process.argv[2]);
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-native-pan-'));
const checks = [], frames = [], errors = [];
const check = (label, passed, details) => checks.push({label, passed: !!passed, details});
const child = spawn(process.execPath, [path.join(__dirname, 'session-header.cjs'), build, '--serve'], {stdio: ['ignore', 'pipe', 'inherit']});
let browser;
(async () => {
    const url = await new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('Fixture timeout')), 15000);
        child.stdout.on('data', data => {
            output += data;
            const match = output.match(/Fixture: (http:\/\/127\.0\.0\.1:\d+)/);
            if (match) {clearTimeout(timer); resolve(match[1]);}
        });
        child.once('exit', code => {clearTimeout(timer); reject(new Error(`Fixture exit ${code}`));});
    });
    browser = await (process.env.LMC_WEBKIT ? webkit : chromium).launch({headless: true,
        ...(!process.env.LMC_WEBKIT ? {executablePath: process.env.LMC_CHROME_PATH} : {})});
    const context = await browser.newContext({viewport: {width: 440, height: 756}, isMobile: true, hasTouch: true,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0_0 like Mac OS X) AppleWebKit/605.1.15 EdgiOS/153.0 Mobile Safari/604.1'});
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await context.addInitScript(() => {
        window.panModel = {height: 756, pan: 0, pageTop: 0};
        window.focusCalls = [];
        const focus = HTMLElement.prototype.focus;
        HTMLElement.prototype.focus = function (options) {
            if (this.matches('textarea[data-lmc-text-input]')) focusCalls.push({preventScroll: options?.preventScroll === true,
                wasFocused: document.activeElement === this});
            return focus.call(this, options);
        };
        Object.defineProperty(window, 'innerHeight', {configurable: true, get: () => Math.max(panModel.height, 756 - panModel.pan)});
        Object.defineProperty(window, 'scrollY', {configurable: true, get: () => panModel.pan});
        for (const [key, get] of Object.entries({height: () => panModel.height, width: () => 440, scale: () => 1,
            pageTop: () => panModel.pageTop, offsetTop: () => Math.min(panModel.pan, 756 - panModel.height)})) {
            Object.defineProperty(visualViewport, key, {configurable: true, get});
        }
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.getByRole('button', {name: '隐藏测试控件', exact: true}).click();
    const field = page.locator('textarea[data-lmc-text-input]').first(); await field.waitFor();
    // Use production Expo root clipping too; the old fixture only copied CSS
    // links and substituted its own root without the export's inline reset.
    const reset = fs.readFileSync(path.join(build, 'index.html'), 'utf8').match(/<style id="expo-reset">([\s\S]*?)<\/style>/)?.[1];
    if (reset) await page.addStyleTag({content: reset});
    await page.evaluate(() => {
        setMeta({engineAuth: {status: 'ready', checkedAt: Date.now()}, sessionConfigState: 'applied', sessionConfigError: null});
        window.panProbe = {node: document.querySelector('textarea[data-lmc-text-input]'), blurs: 0, sends: []};
        panProbe.node.addEventListener('blur', () => panProbe.blurs++);
        sync.sendMessage = async (id, text) => panProbe.sends.push({id, text});
    });
    const measure = () => page.evaluate(() => {
        const node = panProbe.node, rect = node.getBoundingClientRect();
        let owner = node;
        while (owner && !owner.style.getPropertyValue('--lmc-keyboard-inset')) owner = owner.parentElement;
        const hit = label => {
            const e = document.querySelector(`[aria-label="${label}"]`), r = e?.getBoundingClientRect();
            return !!r && [[.5,.1],[.5,.5],[.5,.9]].every(([x,y]) => {
                const target = document.elementFromPoint(r.x+r.width*x, r.y+r.height*y);
                return target && (target === e || e.contains(target)) && r.bottom <= panModel.height + 1;
            });
        };
        return {pan: panModel.pan, height: panModel.height, fieldTop: rect.top, fieldHeight: rect.height,
            fieldBottom: rect.bottom, composerBottom: document.querySelector('[data-lmc-composer]').getBoundingClientRect().bottom,
            headerTop: document.querySelector('[data-lmc-session-header]').getBoundingClientRect().top,
            headerHit: hit('会话列表'), sendHit: hit('Send'),
            inset: owner?.style.getPropertyValue('--lmc-keyboard-inset'), extension: owner?.style.getPropertyValue('--lmc-composer-extension'),
            dockExtension: owner?.style.getPropertyValue('--lmc-dock-extension') || '',
            // The compact card ends `dockExtension` above the visible bottom (owner's choice, v300).
            dockMeets: Math.abs(document.querySelector('[data-lmc-composer]').getBoundingClientRect().bottom + parseFloat(owner?.style.getPropertyValue('--lmc-dock-extension') || '0') - panModel.height) < 1,
            backdropBottom: document.querySelector('[data-lmc-dock-backdrop]')?.getBoundingClientRect().bottom ?? null,
            same: node === document.querySelector('textarea[data-lmc-text-input]'), focused: document.activeElement === node,
            controlledFocus: node.dataset.lmcFocusScroll === 'controlled',
            rootClip: [document.documentElement, document.body].some(e => e.style.overflow === 'clip'), text: node.value};
    });
    const update = async (height, pan, pageTop = pan) => {
        await page.evaluate(({height, pan, pageTop}) => {
            Object.assign(panModel, {height, pan, pageTop}); document.body.style.translate = `0 ${-pan}px`;
            visualViewport.dispatchEvent(new Event('resize')); visualViewport.dispatchEvent(new Event('scroll'));
        }, {height, pan, pageTop});
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const geometry = await measure(); frames.push(geometry); return geometry;
    };
    for (const gesture of ['drag', 'multitouch', 'cancel']) {
        const result = await field.evaluate((node, gesture) => {
            const before = focusCalls.length;
            const touch = (id, x = 100) => ({identifier: id, clientX: x, clientY: 650});
            const dispatch = (type, touches, changedTouches = touches) => {
                const event = new Event(type, {bubbles: true, cancelable: true});
                Object.defineProperties(event, {touches: {value: touches}, changedTouches: {value: changedTouches}});
                return node.dispatchEvent(event);
            };
            dispatch('touchstart', [touch(1)]);
            if (gesture === 'drag') dispatch('touchmove', [touch(1, 140)]);
            if (gesture === 'multitouch') dispatch('touchstart', [touch(1), touch(2)]);
            if (gesture === 'cancel') dispatch('touchcancel', [], [touch(1)]);
            const changed = gesture === 'multitouch' ? [touch(1), touch(2)] : [touch(1, gesture === 'drag' ? 140 : 100)];
            const nativeAllowed = dispatch('touchend', [], changed);
            return {nativeAllowed, calls: focusCalls.length - before, focused: document.activeElement === node};
        }, gesture);
        check(`${gesture} does not force composer focus or cancel the gesture`, result.nativeAllowed && result.calls === 0 && !result.focused, result);
    }
    const initialField = await field.boundingBox();
    await page.touchscreen.tap(initialField.x + initialField.width / 2, initialField.y + initialField.height / 2);
    check('first iOS touch establishes controlled focus before native caret reveal', (await measure()).controlledFocus
        && await page.evaluate(() => focusCalls.some(call => call.preventScroll && !call.wasFocused)), await page.evaluate(() => focusCalls));
    const beforeSecondTap = await page.evaluate(() => focusCalls.length);
    await page.touchscreen.tap(initialField.x + initialField.width / 2, initialField.y + initialField.height / 2);
    check('touching an already-focused field does not refocus it', await page.evaluate(() => focusCalls.length) === beforeSecondTap);
    await field.fill('我');
    const baseline = await measure();
    for (const flavor of ['claude', 'codex']) {
        await page.evaluate(flavor => setFlavor(flavor), flavor);
        // Controlled focus: the keyboard opens at scrollY=0 and the dock lifts.
        for (const [height, pan] of [[756,0],[447,0],[424,0]]) {
            const r = await update(height, pan);
            check(`${flavor}: compact focused editor at ${height}/${pan}`, !r.extension
                && !r.rootClip && Math.abs(r.fieldHeight-baseline.fieldHeight)<1 && r.same && r.focused, r);
            if (height < 756) check(`${flavor}: dock meets the keyboard at ${height}/${pan}`,
                r.dockMeets && r.fieldTop >= 56 && r.fieldBottom <= height && Math.abs(r.headerTop)<1 && r.headerHit && r.sendHit, r);
        }
        // WebKit reveals the caret on each keystroke: a bounded model from the
        // v294/v295 device records (raise the field top to 251, 54px steps).
        // v295 followed the visible bottom back down and crept 419px in six
        // reveals. The field must now keep its document position, so WebKit
        // stops after one reveal; the backdrop covers the strip past the body.
        const anchored = await measure();
        // The second flavor runs after the first one taught the 54px strip
        // (same page, same localStorage): its field is pre-lifted and WebKit
        // has nothing to reveal. The first flavor learns it here.
        const learnedBefore = await page.evaluate(() => !!localStorage.getItem('lmc.ios-keyboard-reveal-gap.v2'));
        // The strip remembered so far (0 before any reveal). A re-anchor followed
        // by another modelled reveal legitimately teaches a larger strip, so the
        // second flavor starts from whatever the first one ended with.
        const gap0 = await page.evaluate(() => JSON.parse(localStorage.getItem('lmc.ios-keyboard-reveal-gap.v2') || '{"gap":0}').gap);
        const expectedPan = learnedBefore ? 0 : 54;
        let reveals = 0, settled = anchored;
        for (let keystroke = 0; keystroke < 6; keystroke++) {
            let r = settled, steps = 0;
            while (r.fieldTop > 251 && steps < 8) { r = await update(424, r.pan + Math.min(54, r.fieldTop - 251), r.pan + Math.min(54, r.fieldTop - 251) - 0.3); steps++; reveals++; }
            settled = r;
            // The field keeps its document position; the controls row docks to
            // the visible bottom through the in-card spacer (owner's choice,
            // v296 device screenshots: Edge and Safari both left a strip).
            check(`${flavor}: keystroke ${keystroke + 1} leaves the field where WebKit revealed it and docks the controls`, steps === (keystroke === 0 && !learnedBefore ? 1 : 0)
                && r.pan === expectedPan && Math.abs((r.fieldTop + r.pan) - (anchored.fieldTop + anchored.pan)) < 1 && r.dockMeets
                && r.dockExtension === `${gap0 + expectedPan}px` && Math.abs(r.fieldHeight-baseline.fieldHeight)<1
                && r.fieldTop >= 56 && r.fieldBottom <= 424 && Math.abs(r.headerTop)<1 && r.headerHit && r.sendHit && r.focused && !r.extension, r);
        }
        check(`${flavor}: ${learnedBefore ? 'no' : 'one'} caret reveal in total, no creep`, reveals === (learnedBefore ? 0 : 1), {reveals, learnedBefore});
        // Learning waits 400ms after the pan settles; the keyboard must stay open that long.
        await page.waitForTimeout(500);
        // v294 record: pageTop lags scrollY by 20px during the pan. The
        // visible bottom still comes from scrollY; the backdrop covers 54px.
        for (const [pan, pageTop] of [[54, 34], [54, 54]]) {
            const r = await update(424, pan, pageTop);
            check(`${flavor}: lagging pageTop ${pageTop} does not move the field`, Math.abs((r.fieldTop + r.pan) - (anchored.fieldTop + anchored.pan)) < 1
                && r.dockMeets && r.dockExtension === `${54 + gap0}px` && r.sendHit && r.fieldBottom <= 424, r);
        }
        // The 54px reveal has settled (waits above exceed the 400ms learning
        // delay). Dismiss the keyboard with the field still focused, re-tap:
        // the tap must refocus with preventScroll (WebKit would otherwise
        // force-scroll the old position to the page limit), and the field is
        // pre-lifted by the remembered 54px so WebKit has nothing to reveal.
        await update(756, 0);
        const beforeRetap = await page.evaluate(() => focusCalls.length);
        const dismissedField = await field.boundingBox();
        await page.touchscreen.tap(dismissedField.x + dismissedField.width / 2, dismissedField.y + dismissedField.height / 2);
        await page.waitForTimeout(50);
        const retap = await page.evaluate(() => ({ calls: focusCalls.slice(), focused: document.activeElement === panProbe.node, text: panProbe.node.value,
            learned: JSON.parse(localStorage.getItem('lmc.ios-keyboard-reveal-gap.v2') || 'null') }));
        // The strip in effect from here on: the modelled pans above are recorded
        // device data, so a pre-lifted flavor may legitimately have learned more.
        const gap = retap.learned?.gap ?? 0;
        check(`${flavor}: re-tapping the focused field after keyboard dismissal refocuses with preventScroll`, retap.calls.length === beforeRetap + 1
            && retap.calls[beforeRetap].preventScroll && !retap.calls[beforeRetap].wasFocused && retap.focused && retap.text === '我'
            && gap >= gap0 + expectedPan && retap.learned?.keyboardHeight === 332, retap);
        // That deliberate blur/refocus is the only focus loss allowed; the send checks below count from here.
        await page.evaluate(() => { panProbe.blurs = 0; });
        // v299 device trace: WebKit checks the caret while the keyboard frame
        // is still changing, before any viewport event. The tap alone must
        // already have lifted the dock to the remembered keyboard geometry.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const anticipated = await measure(); frames.push(anticipated);
        check(`${flavor}: the tap lifts the dock before any keyboard viewport event`, anticipated.height === 756 && Math.abs(anticipated.fieldTop - (305 - gap)) < 1
            && Math.abs(anticipated.composerBottom + parseFloat(anticipated.dockExtension || '0') - 424) < 1 && anticipated.dockExtension === `${gap}px` && anticipated.focused, anticipated);
        const reopened = await update(424, 0);
        const reopenReveal = reopened.fieldTop > 251 ? 'needed' : 'none';
        check(`${flavor}: the remembered reveal pre-lifts the field so the reopened keyboard needs no pan`, reopenReveal === 'none' && reopened.dockMeets
            && reopened.dockExtension === `${gap}px` && Math.abs(reopened.fieldTop - (305 - gap)) < 1 && reopened.sendHit && reopened.focused, reopened);
        // v296 device screenshot: an unsuppressed focus reveal panned the page
        // to its limit, leaving the field above the header. Re-anchor after
        // the pan settles, then WebKit's next reveal is anchored again.
        const overPanned = await update(424, 332);
        check(`${flavor}: a limit pan first hides the field above the header`, overPanned.fieldBottom <= 56 + 1 && overPanned.dockExtension === `${332 + gap}px`, overPanned);
        await page.waitForTimeout(450);
        await page.evaluate(() => { visualViewport.dispatchEvent(new Event('scroll')); });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const recovered = await measure(); frames.push(recovered);
        check(`${flavor}: the field returns to the keyboard once the limit pan settles`, recovered.dockMeets
            && Math.abs(recovered.fieldTop - (305 - gap)) < 1 && recovered.fieldBottom <= 424 && recovered.dockExtension === `${gap}px` && recovered.sendHit && recovered.focused, recovered);
        // A further modelled reveal after the re-anchor: anchored, and (being a
        // real pan) it teaches the larger strip for the next flavor.
        const revealed = await update(424, 386, 365.7);
        check(`${flavor}: WebKit's following reveal is anchored again`, revealed.dockMeets && revealed.dockExtension === `${gap + 54}px`
            && revealed.fieldTop >= 56 && revealed.fieldBottom <= 424 && revealed.sendHit, revealed);
        // Back to the ordinary 54px reveal state: the field is hidden below
        // the keyboard until the settle delay re-anchors it.
        await update(424, 54); await page.waitForTimeout(450);
        await page.evaluate(() => { visualViewport.dispatchEvent(new Event('scroll')); });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const rebased = await measure(); frames.push(rebased);
        const gapNow = await page.evaluate(() => JSON.parse(localStorage.getItem('lmc.ios-keyboard-reveal-gap.v2') || '{"gap":0}').gap);
        check(`${flavor}: a settled under-pan lifts the field back to the keyboard`, rebased.dockMeets && rebased.dockExtension === `${gapNow}px` && Math.abs(rebased.fieldTop - (305 - gapNow)) < 1 && rebased.sendHit, rebased);
        // A finger pan with the keyboard open is followed once it ends.
        await page.evaluate(() => document.dispatchEvent(new Event('touchstart', {bubbles: true})));
        const dragged = await update(424, 386, 365.7);
        check(`${flavor}: a finger pan keeps the field anchored while touching`, Math.abs((dragged.fieldTop + dragged.pan) - (rebased.fieldTop + rebased.pan)) < 1
            && dragged.backdropBottom >= 424 - 1, dragged);
        await page.evaluate(() => { const e = new Event('touchend', {bubbles: true}); Object.defineProperty(e, 'touches', {value: []}); document.dispatchEvent(e); });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const followed = await measure(); frames.push(followed);
        // The body ends 54px above the visible bottom at this pan; the dock
        // returns to the body's end and the backdrop covers the rest.
        check(`${flavor}: after the finger lifts the dock meets the keyboard again`, followed.dockMeets
            && Math.abs(followed.fieldHeight-baseline.fieldHeight)<1 && followed.fieldTop >= 56 && followed.fieldBottom <= 424 && Math.abs(followed.headerTop)<1 && followed.headerHit && followed.sendHit && followed.focused, followed);
        await update(424,386,365.7);
        await field.dispatchEvent('compositionstart', {data: '我'});
        await field.dispatchEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true, cancelable: true});
        await field.dispatchEvent('compositionend', {data: '我'});
        check(`${flavor}: IME confirmation does not send`, await page.evaluate(() => panProbe.sends.length) === (flavor === 'claude' ? 0 : 1));
        const button = await page.getByRole('button', {name: 'Send', exact: true}).boundingBox();
        await page.touchscreen.tap(button.x+button.width/2, button.y+button.height/2);
        await page.waitForTimeout(150);
        check(`${flavor}: send exactly once without losing focus`, await page.evaluate(count => panProbe.sends.length === count
            && panProbe.blurs === 0 && document.activeElement === panProbe.node && panProbe.node.value === '', flavor === 'claude' ? 1 : 2));
        // The recording alternates one-character and empty drafts. Neither
        // should change the field height just because the root is panned.
        await field.fill('我'); await update(424,386); await field.fill('');
        const empty = await measure();
        check(`${flavor}: empty/one-character editor stays compact`, Math.abs(empty.fieldHeight-baseline.fieldHeight)<1 && empty.same && empty.focused);
        await field.fill('长草稿\n'.repeat(45));
        const long = await field.evaluate(node => {node.scrollTop=node.scrollHeight; return {height: node.getBoundingClientRect().height, scroll: node.scrollTop};});
        check(`${flavor}: long draft scrolls within bounded field`, long.height <= 170 && long.scroll > 0, long);
        await field.fill('我');
    }
    await update(424,332); await page.screenshot({path: path.join(out, 'keyboard.png'), clip: {x:0,y:0,width:440,height:424}});
    await update(424,386,365.7); await page.screenshot({path: path.join(out, 'keyboard-overpan.png'), clip: {x:0,y:0,width:440,height:424}});
    await update(756,0); await field.blur(); await page.waitForTimeout(100);
    const closed = await measure();
    check('dismissal restores header and compact draft', closed.inset === '0px' && !closed.extension && Math.abs(closed.headerTop)<1 && closed.same && closed.text === '我');
    await context.close();
})().catch(error => errors.push(String(error))).finally(async () => {
    await browser?.close(); child.kill('SIGTERM');
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({build, engine: process.env.LMC_WEBKIT ? 'webkit' : 'edge', checks, frames, errors}, null, 2));
    const failed = checks.filter(c => !c.passed).map(c => c.label);
    console.log(JSON.stringify({out, checks: checks.length, failed, errors}, null, 2));
    if (failed.length || errors.length) process.exitCode=1;
});
