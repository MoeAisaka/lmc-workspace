// Real touch hit-testing and event order on the exported composer. Keyboard
// geometry is synthetic; this is not an iPhone software-keyboard acceptance.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const build = path.resolve(process.argv[2]);
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lmc-keyboard-send-'));
const child = spawn(process.execPath, [path.join(__dirname, 'session-header.cjs'), build, '--serve'], {stdio: ['ignore', 'pipe', 'inherit']});
const {webkit, chromium} = require(process.env.LMC_PLAYWRIGHT_MODULE);
const checks = [], errors = [];
let browser;
(async () => {
    const url = await new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('Fixture startup timeout')), 15000);
        child.stdout.on('data', chunk => {
            output += chunk;
            const match = output.match(/Fixture: (http:\/\/127\.0\.0\.1:\d+)/);
            if (match) { clearTimeout(timer); resolve(match[1]); }
        });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}`)); });
    });
    browser = await (process.env.LMC_WEBKIT ? webkit : chromium).launch({headless: true,
        ...(!process.env.LMC_WEBKIT && process.env.LMC_CHROME_PATH ? {executablePath: process.env.LMC_CHROME_PATH} : {})});
    const context = await browser.newContext({viewport: {width: 440, height: 756}, isMobile: true, hasTouch: true});
    await context.addInitScript(() => {
        const nativeHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
        window.fixtureLayoutHeight = 756;
        Object.defineProperty(window, 'innerHeight', {configurable: true, get: () => window.fixtureLayoutHeight ?? nativeHeight.get.call(window)});
    });
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.getByRole('button', {name: '隐藏测试控件', exact: true}).click();
    const field = page.locator('textarea:not([aria-hidden="true"])').first();
    await field.waitFor();
    await page.evaluate(() => {
        setMeta({engineAuth: {status: 'ready', checkedAt: Date.now()}, sessionConfigState: 'applied', sessionConfigError: null});
        window.sendProbe = {sends: [], events: []};
        sync.sendMessage = async (_id, text) => sendProbe.sends.push(text);
        for (const type of ['pointerdown', 'touchstart', 'pointerup', 'touchend', 'mousedown', 'blur', 'focusout', 'mouseup', 'click']) {
            document.addEventListener(type, event => {
                sendProbe.events.push({type, target: event.target.closest?.('[aria-label]')?.getAttribute('aria-label') || event.target.tagName,
                    focused: document.activeElement?.tagName, sendY: document.querySelector('[aria-label="Send"]')?.getBoundingClientRect().top});
            }, true);
        }
    });
    for (const size of [{width: 440, height: 756}, {width: 820, height: 1080}]) {
        await page.setViewportSize(size);
        await page.evaluate(height => { window.fixtureLayoutHeight = height; window.dispatchEvent(new Event('resize')); }, size.height);
        for (const flavor of ['claude', 'codex']) {
            await page.evaluate(flavor => setFlavor(flavor), flavor);
            for (const mode of ['visual-only', 'resized']) {
                await field.fill(`触屏发送 ${flavor} ${mode}`);
                await page.evaluate(({mode, height}) => {
                    window.fixtureLayoutHeight = mode === 'resized' ? 424 : height;
                    for (const [key, value] of Object.entries({height: 424, offsetTop: mode === 'resized' ? height - 424 : 0, scale: 1})) {
                        Object.defineProperty(visualViewport, key, {configurable: true, get: () => value});
                    }
                    visualViewport.dispatchEvent(new Event('resize'));
                    sendProbe.sends = []; sendProbe.events = [];
                }, {mode, height: size.height});
                await page.waitForTimeout(800);
                const button = page.getByRole('button', {name: 'Send', exact: true});
                const rect = await button.boundingBox();
                await page.touchscreen.tap(rect.x + rect.width / 2, rect.y + rect.height / 2);
                await page.waitForTimeout(150);
                const result = await field.evaluate(node => ({text: node.value, focused: document.activeElement === node, ...sendProbe}));
                checks.push({label: `${size.width}/${flavor}/${mode}: first touch sends once without losing input focus`, passed: result.sends.length === 1 && result.text === '' && result.focused, rect, ...result});
                await page.touchscreen.tap(rect.x + rect.width / 2, rect.y + rect.height / 2);
                await page.waitForTimeout(60);
                checks.push({label: `${size.width}/${flavor}/${mode}: empty follow-up tap does not send twice`, passed: await page.evaluate(() => sendProbe.sends.length === 1)});
                await field.blur();
                await page.evaluate(height => {
                    window.fixtureLayoutHeight = height;
                    for (const key of ['height', 'offsetTop', 'scale']) delete visualViewport[key];
                    window.dispatchEvent(new Event('resize'));
                }, size.height);
            }
            await field.fill(`键盘按钮发送 ${flavor}`);
            await page.evaluate(() => { sendProbe.sends = []; });
            const sendButton = page.getByRole('button', {name: 'Send', exact: true});
            await sendButton.focus();
            await sendButton.press('Space');
            await page.waitForTimeout(100);
            checks.push({label: `${size.width}/${flavor}: keyboard can still activate the Send button`, passed: await page.evaluate(flavor => sendProbe.sends.length === 1 && sendProbe.sends[0] === `键盘按钮发送 ${flavor}`, flavor)});
        }
    }
    await context.close();
})().catch(error => errors.push(String(error))).finally(async () => {
    await browser?.close(); child.kill('SIGTERM');
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({build, engine: process.env.LMC_WEBKIT ? 'webkit' : 'chromium', checks, errors}, null, 2));
    const failed = checks.filter(check => !check.passed).map(check => check.label);
    console.log(JSON.stringify({out, checks: checks.length, failed, errors}, null, 2));
    if (failed.length || errors.length) process.exitCode = 1;
});
