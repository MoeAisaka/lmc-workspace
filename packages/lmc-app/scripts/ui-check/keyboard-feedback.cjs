// Exported composer + a bounded caret-reveal feedback model based on the v291
// device trace. This exercises real layout, not an iPhone software keyboard.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {webkit, chromium} = require(process.env.LMC_PLAYWRIGHT_MODULE);
const build = path.resolve(process.argv[2]);
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lmc-keyboard-feedback-'));
const child = spawn(process.execPath, [path.join(__dirname, 'session-header.cjs'), build, '--serve'], {stdio: ['ignore', 'pipe', 'inherit']});
const checks = [], frames = [], errors = [];
let browser;
(async () => {
    const url = await new Promise((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => reject(new Error('Fixture timeout')), 15000);
        child.stdout.on('data', data => {buffer += data; const match = buffer.match(/Fixture: (http:\/\/127\.0\.0\.1:\d+)/); if (match) {clearTimeout(timer); resolve(match[1]);}});
        child.once('exit', code => {clearTimeout(timer); reject(new Error(`Fixture exit ${code}`));});
    });
    browser = await (process.env.LMC_WEBKIT ? webkit : chromium).launch({headless: true,
        ...(!process.env.LMC_WEBKIT ? {executablePath: process.env.LMC_CHROME_PATH} : {})});
    const context = await browser.newContext({viewport: {width: 440, height: 756}, isMobile: true, hasTouch: true});
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await context.addInitScript(() => {
        window.revealModel = {pan: 0, height: 756};
        Object.defineProperty(window, 'innerHeight', {configurable: true, get: () => Math.max(revealModel.height, 756 - revealModel.pan)});
        Object.defineProperty(window, 'scrollY', {configurable: true, get: () => revealModel.pan});
        for (const [key, get] of Object.entries({
            height: () => revealModel.height, width: () => 440, scale: () => 1,
            pageTop: () => revealModel.pan, offsetTop: () => Math.min(revealModel.pan, 756 - revealModel.height),
        })) Object.defineProperty(visualViewport, key, {configurable: true, get});
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.getByRole('button', {name: '隐藏测试控件', exact: true}).click();
    const field = page.locator('textarea[data-lmc-text-input]').first(); await field.waitFor();
    await page.evaluate(() => {
        setMeta({engineAuth: {status: 'ready', checkedAt: Date.now()}, sessionConfigState: 'applied', sessionConfigError: null});
        window.feedbackProbe = {node: document.querySelector('textarea[data-lmc-text-input]'), sends: [], blurs: 0};
        feedbackProbe.node.addEventListener('blur', () => feedbackProbe.blurs++);
        sync.sendMessage = async (_id, text) => feedbackProbe.sends.push(text);
    });
    await field.fill('保留输入草稿');
    const geometry = () => page.evaluate(() => {
        const node = feedbackProbe.node, box = node.getBoundingClientRect();
        let owner = node;
        while (owner && !owner.style.getPropertyValue('--lmc-keyboard-inset')) owner = owner.parentElement;
        return {pan: revealModel.pan, height: revealModel.height, fieldY: box.top, fieldBottom: box.bottom,
            fieldHeight: box.height, headerY: document.querySelector('[data-lmc-session-header]')?.getBoundingClientRect().top,
            composerBottom: document.querySelector('[data-lmc-composer]')?.getBoundingClientRect().bottom,
            headerHit: (() => {const button = document.querySelector('[aria-label="会话列表"]'), r = button?.getBoundingClientRect();
                const hit = r && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                return !!hit && (hit === button || button.contains(hit));})(),
            documentY: box.top + revealModel.pan, inset: owner?.style.getPropertyValue('--lmc-keyboard-inset'),
            same: node === document.querySelector('textarea[data-lmc-text-input]'), focused: document.activeElement === node, text: node.value,
            bodyPosition: getComputedStyle(document.body).position, bodyHeight: document.body.getBoundingClientRect().height};
    });
    const update = async (height, pan) => {
        await page.evaluate(({height, pan}) => {
            Object.assign(revealModel, {height, pan});
            document.body.style.translate = `0 ${-pan}px`;
            visualViewport.dispatchEvent(new Event('resize'));
            visualViewport.dispatchEvent(new Event('scroll'));
        }, {height, pan});
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        frames.push(await geometry());
    };
    await update(447, 0); await update(424, 0);
    const before = await geometry(), target = before.fieldY - 54;
    let reveals = 0, current = before;
    while (current.fieldY > target + 1 && reveals < 10) {
        const pan = current.pan + Math.min(54, current.fieldY - target);
        await update(424, pan); reveals++; current = await geometry();
    }
    checks.push({label: 'one native caret reveal is not undone by the exported composer', passed: reveals === 1 && Math.abs(current.pan - 54) < 1, reveals, before, current});
    checks.push({label: 'field document position and applied inset stay unchanged during pan', passed: Math.abs(current.documentY - before.documentY) < 1 && current.inset === before.inset});
    checks.push({label: 'field stays visible and keeps the same focused draft', passed: current.fieldY >= 0 && current.fieldBottom <= 424 && current.same && current.focused && current.text === '保留输入草稿'});
    checks.push({label: 'header stays at the visible top and its menu remains hittable', passed: Math.abs(current.headerY) < 1 && current.headerHit});
    checks.push({label: 'native pan never expands a short editor', passed:
        Math.abs(current.composerBottom - 370) < 1 && Math.abs(current.fieldHeight - before.fieldHeight) < 1});
    await page.screenshot({path: path.join(out, 'keyboard-pan.png'), clip: {x: 0, y: 0, width: 440, height: 424}});
    const send = page.getByRole('button', {name: 'Send', exact: true});
    const button = await send.boundingBox();
    await page.touchscreen.tap(button.x + button.width / 2, button.y + button.height / 2);
    await page.waitForTimeout(150);
    const sent = await page.evaluate(() => ({sends: feedbackProbe.sends, blurs: feedbackProbe.blurs, focused: document.activeElement === feedbackProbe.node, text: feedbackProbe.node.value}));
    checks.push({label: 'touch send after caret reveal delivers once without blur', passed: sent.sends.length === 1 && sent.sends[0] === '保留输入草稿' && sent.blurs === 0 && sent.focused && sent.text === '', ...sent});
    await field.fill('长草稿\n'.repeat(45));
    await page.waitForTimeout(120);
    const expanded = await field.evaluate(node => {
        const mirror = node.parentElement.querySelector('.lmc-textarea-mirror').getBoundingClientRect();
        node.scrollTop = node.scrollHeight;
        return {height: node.getBoundingClientRect().height, mirrorHeight: mirror.height, scrollTop: node.scrollTop,
            composerBottom: document.querySelector('[data-lmc-composer]').getBoundingClientRect().bottom,
            headerTop: document.querySelector('[data-lmc-session-header]').getBoundingClientRect().top,
            focused: document.activeElement === node};
    });
    checks.push({label: 'long draft stays bounded and scrolls inside the field', passed:
        expanded.height <= 170 && expanded.scrollTop > 0
        && expanded.focused && Math.abs(expanded.composerBottom - 370) < 1 && Math.abs(expanded.headerTop) < 1, ...expanded});
    await field.fill('组合输入');
    await field.dispatchEvent('compositionstart', {data: '组合'});
    await field.dispatchEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true, cancelable: true});
    await field.dispatchEvent('compositionend', {data: '组合输入'});
    checks.push({label: 'editor preserves IME Enter without sending', passed: await page.evaluate(() => feedbackProbe.sends.length === 1 && feedbackProbe.node.value === '组合输入')});
    await update(756, 0);
    const closed = await geometry();
    checks.push({label: 'keyboard dismissal clears the lift and preserves normal document flow', passed: closed.inset === '0px' && closed.bodyPosition === 'static' && closed.bodyHeight === 756 && closed.focused});
    await context.close();
})().catch(error => errors.push(String(error))).finally(async () => {
    await browser?.close(); child.kill('SIGTERM');
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({build, engine: process.env.LMC_WEBKIT ? 'webkit' : 'edge', checks, frames, errors}, null, 2));
    const failed = checks.filter(check => !check.passed).map(check => check.label);
    console.log(JSON.stringify({out, checks: checks.length, failed, errors}, null, 2));
    if (failed.length || errors.length) process.exitCode = 1;
});
