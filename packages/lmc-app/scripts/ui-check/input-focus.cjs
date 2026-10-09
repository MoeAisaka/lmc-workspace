// Actual exported textarea + native browser focus scrolling. This isolates
// default focus in a partially clipped scroller, not an iPhone OS keyboard.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {webkit, chromium} = require(process.env.LMC_PLAYWRIGHT_MODULE);
const build = path.resolve(process.argv[2]);
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lmc-input-focus-'));
const child = spawn(process.execPath, [path.join(__dirname, 'session-header.cjs'), build, '--serve'], {stdio: ['ignore', 'pipe', 'inherit']});
const checks = [], errors = [];
let browser;
(async () => {
    const url = await new Promise((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => reject(new Error('Fixture timeout')), 15000);
        child.stdout.on('data', data => {buffer += data; const m = buffer.match(/Fixture: (http:\/\/127\.0\.0\.1:\d+)/); if (m) {clearTimeout(timer); resolve(m[1]);}});
        child.once('exit', code => {clearTimeout(timer); reject(new Error(`Fixture exit ${code}`));});
    });
    browser = await (process.env.LMC_WEBKIT ? webkit : chromium).launch({headless: true,
        ...(!process.env.LMC_WEBKIT ? {executablePath: process.env.LMC_CHROME_PATH} : {})});
    const context = await browser.newContext({viewport: {width: 440, height: 756}, isMobile: true, hasTouch: true});
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.locator('textarea').first().waitFor();
    await page.evaluate(() => {
        const React = moduleExport('useState'), h = React.createElement;
        const {createRoot} = moduleExport('createRoot');
        const {MultiTextInput} = moduleExport('MultiTextInput');
        const mount = document.createElement('div');
        mount.id = 'native-focus-scroller';
        mount.style.cssText = 'position:fixed;top:80px;left:20px;width:360px;height:180px;overflow:auto;background:white;z-index:2147483647';
        document.body.appendChild(mount);
        window.focusProbe = {ref: React.createRef(), events: [], requests: []};
        createRoot(mount).render(h('div', null,
            h('div', {id: 'focus-spacer', style: {height:164}}),
            h(MultiTextInput, {ref: focusProbe.ref, defaultValue: '保留这份草稿', paddingTop:10, paddingBottom:10})));
        for (const type of ['mousedown', 'focusin', 'touchend', 'click']) document.addEventListener(type, e => {
            if (mount.contains(e.target)) focusProbe.events.push({type, scroll: mount.scrollTop, prevented: e.defaultPrevented});
        });
    });
    const field = page.locator('#native-focus-scroller textarea'); await field.waitFor();
    await field.evaluate(node => {
        const nativeFocus = node.focus;
        node.focus = function (options) {
            focusProbe.requests.push(options?.preventScroll === true);
            return nativeFocus.call(this, options);
        };
    });
    const box = await field.boundingBox();
    await page.touchscreen.tap(box.x + 30, box.y + 6);
    await page.waitForTimeout(150);
    const touch = await field.evaluate(node => ({scroll: document.querySelector('#native-focus-scroller').scrollTop,
        focused: document.activeElement === node, text: node.value, coarse: matchMedia('(pointer:coarse)').matches,
        events: focusProbe.events, requests: [...focusProbe.requests]}));
    checks.push({label:'first touch requests focus with preventScroll before the native default',
        passed: touch.scroll === 0 && touch.focused && touch.text === '保留这份草稿'
            && touch.requests.length === 1 && touch.requests[0]
            && touch.events.some(event => event.type === 'mousedown' && event.prevented), ...touch});
    await field.blur();
    await page.evaluate(() => {
        // Fully obscure the field for a real browser focus-scroll regression.
        // This is ordinary element scrolling, not an emulated OS keyboard.
        document.querySelector('#focus-spacer').style.height = '380px';
        document.querySelector('#native-focus-scroller').scrollTop = 0;
        focusProbe.ref.current.focus();
    });
    const imperative = await field.evaluate(node => ({scroll: document.querySelector('#native-focus-scroller').scrollTop, focused: document.activeElement === node}));
    checks.push({label:'imperative focus keeps native scroll unchanged', passed: imperative.scroll === 0 && imperative.focused, ...imperative});
    // The already-focused field must keep native caret navigation. End is
    // document navigation in macOS WebKit, so explicitly seed the selection.
    await page.evaluate(() => {document.querySelector('#focus-spacer').style.height = '164px'; document.querySelector('#native-focus-scroller').scrollTop = 0;});
    await field.evaluate(node => node.setSelectionRange(node.value.length, node.value.length));
    await field.press('ArrowLeft'); await field.press('ArrowLeft');
    const caret = await field.evaluate(node => ({start:node.selectionStart, end:node.selectionEnd, expected:node.value.length - 2}));
    checks.push({label:'focused caret navigation remains native', passed: caret.start === caret.expected && caret.end === caret.expected, caret});
    await context.close();
})().catch(e => errors.push(String(e))).finally(async () => {
    await browser?.close(); child.kill('SIGTERM');
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({build, engine:process.env.LMC_WEBKIT?'webkit':'edge',checks,errors},null,2));
    const failed=checks.filter(c=>!c.passed).map(c=>c.label);
    console.log(JSON.stringify({out,checks:checks.length,failed,errors},null,2));
    if (failed.length || errors.length) process.exitCode=1;
});
