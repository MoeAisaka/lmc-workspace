#!/usr/bin/env node
// A reply from a Windows-hosted session shows a local image named by drive path.
// Usage: windows-image.cjs <web export> <image file>
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {webkit, chromium} = require(process.env.LMC_PLAYWRIGHT_MODULE);
const build = path.resolve(process.argv[2]), imageFile = path.resolve(process.argv[3]);
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-windows-image-'));
const checks = [], errors = [];
const check = (label, passed, details) => checks.push({label, passed: !!passed, details});
const child = spawn(process.execPath, [path.join(__dirname, 'session-header.cjs'), build, '--serve', `--windows-image=${imageFile}`], {stdio: ['ignore', 'pipe', 'inherit']});
let browser;
(async () => {
    const url = await new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('Fixture timeout')), 15000);
        child.stdout.on('data', data => { output += data; const match = output.match(/Fixture: (http:\/\/127\.0\.0\.1:\d+)/); if (match) {clearTimeout(timer); resolve(match[1]);} });
        child.once('exit', code => {clearTimeout(timer); reject(new Error(`Fixture exit ${code}`));});
    });
    browser = await (process.env.LMC_WEBKIT ? webkit : chromium).launch({headless: true, ...(!process.env.LMC_WEBKIT ? {executablePath: process.env.LMC_CHROME_PATH} : {})});
    const context = await browser.newContext({viewport: {width: 1280, height: 900}});
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    const consoleErrors = []; page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200)); });
    await page.goto(url); await page.getByRole('button', {name: '隐藏测试控件', exact: true}).click();
    await page.getByText('已补充并保存。').first().waitFor({timeout: 15000});
    await page.waitForTimeout(2500);
    const state = await page.evaluate(() => {
        const image = [...document.querySelectorAll('img')].find(node => node.getAttribute('alt') === '补充完成截图' || (node.src || '').startsWith('data:image/'));
        const labelled = document.querySelector('[aria-label="补充完成截图"]');
        return {calls: window.resourceCalls, retryShown: [...document.querySelectorAll('[role="button"]')].some(node => node.textContent.trim() === '重试'),
            unsupportedShown: document.body.innerText.includes('不支持') , captionShown: document.body.innerText.includes('补充完成截图'), labelled: !!labelled,
            image: image ? {srcPrefix: image.src.slice(0, 40), srcLength: image.src.length, complete: image.complete, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight} : null,
            backgroundImages: [...document.querySelectorAll('*')].map(node => getComputedStyle(node).backgroundImage).filter(value => value.startsWith('url("data:image/')).map(value => value.length)};
    });
    const size = fs.statSync(imageFile).size;
    check('the image is requested from the session, refused, then read from its host in order', JSON.stringify(state.calls.map(c => [c.via, c.offset ?? 0])) === JSON.stringify([['session', 0], ['machine', 0], ['session', 196608], ['machine', 196608]])
        && state.calls.every(c => c.path === 'D:/AgentWork/Projects/Demo Project/.lmc-inbox/qwen-section-updated-20261008.png'), state.calls);
    check('the image is drawn, not the retry placeholder', !state.retryShown && (!!state.image && state.image.naturalWidth > 0 || state.backgroundImages.length > 0), {...state, calls: undefined});
    check('the drawn image carries the whole file', (state.image?.srcLength ?? Math.max(0, ...state.backgroundImages)) > size * 1.3, {size, srcLength: state.image?.srcLength, backgroundImages: state.backgroundImages});
    await page.screenshot({path: path.join(out, 'windows-image.png')});
    check('no page or console errors', errors.length === 0 && consoleErrors.length === 0, {errors, consoleErrors});
    await context.close();
})().catch(error => errors.push(String(error))).finally(async () => {
    await browser?.close(); child.kill('SIGTERM');
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({build, engine: process.env.LMC_WEBKIT ? 'webkit' : 'edge', checks, errors}, null, 2));
    const failed = checks.filter(c => !c.passed).map(c => c.label);
    console.log(JSON.stringify({out, checks: checks.length, failed, errors}, null, 2));
    if (failed.length || errors.length) process.exitCode = 1;
});
