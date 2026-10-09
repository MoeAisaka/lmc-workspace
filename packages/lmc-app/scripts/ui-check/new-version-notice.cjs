#!/usr/bin/env node
// D28: when the server publishes a newer web build, a pill floats at the top of
// the transcript, the same on desktop and phone. Nothing reloads by itself.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {webkit, chromium} = require(process.env.LMC_PLAYWRIGHT_MODULE);
const build = path.resolve(process.argv[2]);
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-new-version-'));
const checks = [], errors = [];
const check = (label, passed, details) => checks.push({label, passed: !!passed, details});
const V1 = 'lmc-redesign-20260908-v900', V2 = 'lmc-redesign-20260908-v901', V3 = 'lmc-redesign-20260908-v902';
const child = spawn(process.execPath, [path.join(__dirname, 'session-header.cjs'), build, '--serve', `--release=${V1}`], {stdio: ['ignore', 'pipe', 'inherit']});
let browser;
(async () => {
    const url = await new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('Fixture timeout')), 15000);
        child.stdout.on('data', data => { output += data; const match = output.match(/Fixture: (http:\/\/127\.0\.0\.1:\d+)/); if (match) {clearTimeout(timer); resolve(match[1]);} });
        child.once('exit', code => {clearTimeout(timer); reject(new Error(`Fixture exit ${code}`));});
    });
    browser = await (process.env.LMC_WEBKIT ? webkit : chromium).launch({headless: true, ...(!process.env.LMC_WEBKIT ? {executablePath: process.env.LMC_CHROME_PATH} : {})});
    const publish = marker => fetch(`${url}/__publish?marker=${encodeURIComponent(marker)}`).then(r => r.text());
    const open = async (viewport, mobile) => {
        await publish(V1);
        const context = await browser.newContext({viewport, hasTouch: mobile, isMobile: mobile && !process.env.LMC_WEBKIT ? true : undefined});
        await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
        const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
        const checksSeen = []; page.on('request', request => { if (request.url().includes('lmc-release-check')) checksSeen.push(request.url()); });
        await page.goto(url); await page.getByRole('button', {name: '隐藏测试控件', exact: true}).click();
        await page.locator('textarea[data-lmc-text-input]').first().waitFor();
        return {context, page, checksSeen};
    };
    const comeBack = page => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const appear = async page => { await page.locator('[data-testid="new-version-notice"]').waitFor({timeout: 8000}); await page.waitForTimeout(300); };
    const notice = page => page.evaluate(() => {
        const nodes = document.querySelectorAll('[data-testid="new-version-notice"]'), node = nodes[0];
        const rect = n => { const r = n?.getBoundingClientRect(); return r ? {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)} : null; };
        const hit = node ? (() => { const r = node.getBoundingClientRect(), top = document.elementFromPoint(r.x + 20, r.y + r.height / 2); return !!top && node.contains(top); })() : false;
        return {count: nodes.length, text: node ? [...node.querySelectorAll('[dir="auto"]')].map(n => n.textContent.trim()).filter(t => /[一-鿿]/.test(t)).join(' | ') : null,
            rect: rect(node), header: rect(document.querySelector('[data-lmc-session-header]')), composer: rect(document.querySelector('[data-lmc-composer]')),
            scene: rect(document.querySelector('[data-testid="scene"]')), hit, scrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth};
    });
    // One pill, on top, below the header, above the composer, centred in the content area and inside it.
    const placed = m => !!m.rect && !!m.header && !!m.composer && !!m.scene && m.count === 1 && m.hit && !m.scrollX
        && m.rect.y >= m.header.y + m.header.h - 2 && m.rect.y + m.rect.h < m.composer.y
        && Math.abs((m.rect.x + m.rect.w / 2) - (m.scene.x + m.scene.w / 2)) <= 2 && m.rect.x >= m.scene.x && m.rect.x + m.rect.w <= m.scene.x + m.scene.w;

    const desktop = await open({width: 1280, height: 900}, false);
    await desktop.page.waitForTimeout(600);
    const quiet = await notice(desktop.page);
    check('desktop: the page checks the server on load without the cache', desktop.checksSeen.length >= 1, desktop.checksSeen);
    check('desktop: nothing is shown while the server has the release this page loaded', quiet.count === 0, quiet);
    await publish(V2); await comeBack(desktop.page); await appear(desktop.page);
    const shown = await notice(desktop.page);
    check('desktop: a newer release shows one pill, centred at the top of the transcript, clickable, clear of the composer', shown.text === '网页有新版本 | 刷新' && placed(shown), shown);
    await desktop.page.screenshot({path: path.join(out, 'desktop-notice.png'), clip: {x: 0, y: 0, width: 1280, height: 420}});
    await desktop.page.evaluate(() => setDraftAttachments(2)); await desktop.page.waitForTimeout(2600);
    const unsent = await notice(desktop.page);
    check('desktop: unsent attachments are named before a refresh would drop them', unsent.text === '有新版本 · 刷新会清空未发送的 2 个附件 | 刷新' && placed(unsent), unsent);
    await desktop.page.screenshot({path: path.join(out, 'desktop-notice-unsent.png'), clip: {x: 0, y: 0, width: 1280, height: 420}});
    await desktop.page.evaluate(() => setDraftAttachments(0));
    await desktop.page.locator('[data-testid="new-version-later"]').click(); await desktop.page.waitForTimeout(300);
    const later = await notice(desktop.page);
    await comeBack(desktop.page); await desktop.page.waitForTimeout(700);
    const stillLater = await notice(desktop.page);
    check('desktop: "later" puts this release off, and another check does not bring it back', later.count === 0 && stillLater.count === 0, {later, stillLater});
    await publish(V3); await comeBack(desktop.page); await appear(desktop.page);
    check('desktop: an even newer release shows it again', (await notice(desktop.page)).text === '网页有新版本 | 刷新');
    const loads = []; desktop.page.on('load', () => loads.push(Date.now()));
    await desktop.page.locator('[data-testid="new-version-refresh"]').click();
    await desktop.page.waitForFunction(marker => document.querySelector('meta[name="lmc-release"]')?.getAttribute('content') === marker, V3, {timeout: 15000});
    await desktop.page.locator('textarea[data-lmc-text-input]').first().waitFor(); await desktop.page.waitForTimeout(800);
    check('desktop: refresh reloads onto the new release and the notice is gone', loads.length >= 1 && (await notice(desktop.page)).count === 0, {loads: loads.length});
    await desktop.context.close();

    const phone = await open({width: 390, height: 844}, true);
    await phone.page.waitForTimeout(600);
    const phoneQuiet = await notice(phone.page);
    await publish(V2); await comeBack(phone.page); await appear(phone.page);
    const phoneShown = await notice(phone.page);
    check('phone: nothing before, then the same pill under the header within the screen', phoneQuiet.count === 0 && phoneShown.text === '网页有新版本 | 刷新' && placed(phoneShown), {phoneQuiet, phoneShown});
    await phone.page.screenshot({path: path.join(out, 'phone-notice.png'), clip: {x: 0, y: 0, width: 390, height: 300}});
    await phone.page.evaluate(() => setDraftAttachments(3)); await phone.page.waitForTimeout(2600);
    const phoneUnsent = await notice(phone.page);
    check('phone: the longer unsent-attachments wording still fits the screen', phoneUnsent.text === '有新版本 · 刷新会清空未发送的 3 个附件 | 刷新' && placed(phoneUnsent) && phoneUnsent.rect.x >= 0 && phoneUnsent.rect.x + phoneUnsent.rect.w <= 390, phoneUnsent);
    await phone.page.screenshot({path: path.join(out, 'phone-notice-unsent.png'), clip: {x: 0, y: 0, width: 390, height: 300}});
    await phone.page.evaluate(() => { setDraftAttachments(0); toggleDrawer(true); }); await phone.page.waitForTimeout(700);
    check('phone: the drawer carries no second notice', (await notice(phone.page)).count === 1);
    await phone.context.close();
})().catch(error => errors.push(String(error))).finally(async () => {
    await browser?.close(); child.kill('SIGTERM');
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({build, engine: process.env.LMC_WEBKIT ? 'webkit' : 'edge', checks, errors}, null, 2));
    const failed = checks.filter(c => !c.passed).map(c => c.label);
    console.log(JSON.stringify({out, checks: checks.length, failed, errors}, null, 2));
    if (failed.length || errors.length) process.exitCode = 1;
});
