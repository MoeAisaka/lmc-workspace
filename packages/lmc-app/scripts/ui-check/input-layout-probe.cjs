// Check the read-only probe and retired A/B queries with local synthetic data.
// This checks diagnostic controls, NOT the iPhone native keyboard/compositor.
// LMC_PLAYWRIGHT_MODULE=/isolated/playwright node input-layout-probe.cjs EXPORT
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { chromium, webkit } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
assert(process.argv[2], 'Pass the release export directory');
const build = path.resolve(process.argv[2]);
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lmc-input-probe-check-'));
const diagnostic = '/diagnostics/input-layout-probe-20261008-v6.js';
const checks = [];
const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    const file = path.join(build, pathname === '/' ? 'index.html' : pathname);
    if (!file.startsWith(build + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404); res.end(); return;
    }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
});
let child;
const fixtureUrl = () => new Promise((resolve, reject) => {
    child = spawn(process.execPath, [path.join(__dirname, 'session-header.cjs'), build, '--serve'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    const timer = setTimeout(() => reject(new Error('Fixture startup timeout')), 15000);
    child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/Fixture: (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}`)); });
});
async function context(browser, origin) {
    const ctx = await browser.newContext({ viewport: { width: 440, height: 756 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
    await ctx.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedReport = text; } } });
    });
    return ctx;
}
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const fixture = await fixtureUrl();
    for (const [engine, type, options] of [
        ['webkit', webkit, {}],
        ['edge-chromium', chromium, { executablePath: process.env.LMC_CHROME_PATH || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' }],
    ]) {
        const browser = await type.launch({ headless: true, ...options });
        try {
            for (const mode of ['ordinary', 'observe', 'native']) {
                const ctx = await context(browser, origin);
                try {
                    const page = await ctx.newPage(), requests = [], errors = [];
                    page.on('request', request => { if (request.url().includes('/diagnostics/')) requests.push(new URL(request.url()).pathname); });
                    page.on('pageerror', error => errors.push(error.message));
                    const query = mode === 'ordinary' ? '' : '?lmc_input_probe=1' + (mode === 'native' ? '&lmc_input_frame=native' : '');
                    await page.goto(origin + '/' + query);
                    await page.waitForFunction(() => document.body.textContent.length > 0);
                    if (mode === 'ordinary') {
                        await page.waitForTimeout(700);
                        assert.deepEqual(requests, []);
                        assert.equal(await page.locator('[data-lmc-input-probe-panel]').count(), 0);
                    } else {
                        await page.locator('[data-lmc-input-probe="copy"]').waitFor();
                        assert.deepEqual(requests, [diagnostic]);
                        assert.equal(await page.locator('[data-lmc-input-probe="native"]').count(), 0);
                        assert.equal(await page.evaluate(() => document.documentElement.dataset.lmcInputFrameTrial || null), null);
                    }
                    assert.deepEqual(errors, []);
                    checks.push({ engine, check: `real export bootstrap: ${mode}`, passed: true, diagnosticRequests: requests });
                } finally { await ctx.close(); }
            }
            const ctx = await context(browser, fixture);
            try {
                const page = await ctx.newPage(), errors = [];
                page.on('pageerror', error => errors.push(error.message));
                await page.goto(fixture);
                const field = page.locator('textarea[data-lmc-text-input]').first();
                await field.waitFor();
                await page.getByText('隐藏测试控件', { exact: true }).click();
                await page.evaluate(() => {
                    history.replaceState(null, '', '?lmc_input_probe=1&lmc_input_frame=native');
                    setMeta({ engineAuth: { status: 'ready', checkedAt: Date.now() }, sessionConfigState: 'applied', sessionConfigError: null });
                    window.controlCheck = { field: document.querySelector('textarea[data-lmc-text-input]'), blurs: 0, sends: 0 };
                    controlCheck.field.addEventListener('blur', () => controlCheck.blurs++);
                    sync.sendMessage = async () => { controlCheck.sends++; };
                });
                await page.addScriptTag({ url: fixture + diagnostic });
                await field.fill('PRIVATE_DRAFT');
                await field.evaluate(element => element.setSelectionRange(3, 6));
                await page.evaluate(() => {
                    // Synthetic dimensions verify the copy action stays read-only;
                    // this does not emulate the iOS native keyboard or panning loop.
                    for (const [key, value] of Object.entries({ height: 424, offsetTop: 120, scale: 1 })) {
                        Object.defineProperty(visualViewport, key, { configurable: true, get: () => value });
                    }
                    visualViewport.dispatchEvent(new Event('resize'));
                });
                await page.waitForTimeout(150);
                const readState = () => page.evaluate(() => {
                    const field = controlCheck.field, body = getComputedStyle(document.body);
                    return {
                        same: field === document.querySelector('textarea[data-lmc-text-input]'), focused: document.activeElement === field,
                        selection: [field.selectionStart, field.selectionEnd], value: field.value,
                        bodyTop: body.top, position: body.position, height: document.body.getBoundingClientRect().height,
                        blurs: controlCheck.blurs, sends: controlCheck.sends,
                    };
                });
                const before = await readState();
                assert.ok(before.same && before.focused);
                assert.deepEqual(before.selection, [3, 6]); assert.equal(before.value, 'PRIVATE_DRAFT');
                assert.equal(before.bodyTop, 'auto'); assert.equal(before.position, 'static');
                assert.equal(before.height, 756); assert.equal(before.blurs, 0); assert.equal(before.sends, 0);
                await page.locator('[data-lmc-input-probe="copy"]').tap();
                await page.waitForFunction(() => !!window.copiedReport, undefined, { timeout: 2000 });
                const copied = await page.evaluate(() => window.copiedReport);
                assert.ok(!copied.includes('PRIVATE_DRAFT'));
                const report = JSON.parse(copied);
                assert.equal(report.schema, 'lmc-input-layout-v6'); assert.equal(report.trial, false);
                assert.deepEqual(report.runs.map(run => run.mode), ['observe']);
                assert.ok(report.runs.every(run => run.samples.length <= 4 && run.timeline.length <= 20 && run.changes.length <= 48));
                assert.deepEqual(await readState(), before);
                assert.equal(await page.locator('[data-lmc-input-probe]').count(), 1);
                assert.deepEqual(errors, []);
                checks.push({ engine, check: 'real composer copy: focus, selection and geometry unchanged; retired trial ignored; sanitized report; no sends', passed: true });
            } finally { await ctx.close(); }
        } finally { await browser.close(); }
    }
})().catch(error => { checks.push({ passed: false, error: error.stack }); process.exitCode = 1; }).finally(() => {
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(checks, null, 2));
    console.log(JSON.stringify({ artifacts: out, checks }, null, 2));
    server.close(); child?.kill('SIGTERM');
});
