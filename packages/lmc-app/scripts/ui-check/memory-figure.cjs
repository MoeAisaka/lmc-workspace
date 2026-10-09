#!/usr/bin/env node
// D27: the memory figure sits centred in the row under the composer; the
// machine part turns amber above 85% used; nothing is drawn without a sample.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {webkit, chromium} = require(process.env.LMC_PLAYWRIGHT_MODULE);
const build = path.resolve(process.argv[2]);
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-memory-figure-'));
const checks = [], errors = [];
const check = (label, passed, details) => checks.push({label, passed: !!passed, details});
const child = spawn(process.execPath, [path.join(__dirname, 'session-header.cjs'), build, '--serve'], {stdio: ['ignore', 'pipe', 'inherit']});
let browser;
const GB = 1024 ** 3;
const sample = (availableGb, sessionGb) => ({sampledAt: Date.now(), memory: {totalBytes: 32 * GB, availableBytes: availableGb * GB},
    sessions: sessionGb === null ? {} : {fixture: {rssBytes: sessionGb * GB, processes: 3}}, daemonRssBytes: 80 * 1024 * 1024});
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
    for (const [name, viewport, mobile] of [['phone', {width: 390, height: 844}, true], ['desktop', {width: 1280, height: 900}, false]]) {
        const context = await browser.newContext({viewport, isMobile: mobile && !process.env.LMC_WEBKIT ? true : undefined, hasTouch: mobile});
        await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
        const page = await context.newPage(); page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
        await page.goto(url); await page.getByRole('button', {name: '隐藏测试控件', exact: true}).click();
        await page.locator('textarea[data-lmc-text-input]').waitFor();
        const measure = () => page.evaluate(() => {
            const rect = sel => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r ? {x: r.x, y: r.y, w: r.width, h: r.height} : null; };
            const node = document.querySelector('[data-testid="agent-input-memory"]');
            const machine = document.querySelector('[data-testid="agent-input-memory-machine"]');
            return {memory: rect('[data-testid="agent-input-memory"]'), row: rect('[data-testid="agent-input-usage"]'),
                composer: rect('[data-lmc-composer]'), text: node?.textContent ?? null,
                machineText: machine?.textContent ?? null, machineColor: machine ? getComputedStyle(machine).color : null,
                scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth};
        });
        const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const empty = await measure();
        check(`${name}: no sample, no figure`, empty.memory === null, empty);
        const composerBefore = empty.composer;
        await page.evaluate(resources => setMachineResources(resources), sample(16, 1.1)); await settle();
        const shown = await measure();
        const centred = shown.memory && shown.row && Math.abs((shown.memory.x + shown.memory.w / 2) - (shown.row.x + shown.row.w / 2)) < 1.5;
        check(`${name}: figure shows session and machine memory`, shown.text === (mobile ? '1.1 GB · 本机 16/32 GB' : '会话 1.1 GB · MacMini 16/32 GB'), shown);
        check(`${name}: figure is centred in the row`, centred, shown);
        check(`${name}: figure stays inside the row and the page does not scroll sideways`, shown.memory && shown.memory.x >= shown.row.x && shown.memory.x + shown.memory.w <= shown.row.x + shown.row.w + 0.5
            && shown.scrollWidth <= shown.clientWidth, shown);
        check(`${name}: normal usage is not highlighted`, shown.machineColor !== 'rgb(255, 149, 0)', shown);
        await page.screenshot({path: path.join(out, `${name}-normal.png`), clip: {x: 0, y: Math.max(0, viewport.height - 220), width: viewport.width, height: 220}});
        await page.evaluate(resources => setMachineResources(resources), sample(3, 2.3)); await settle();
        const tight = await measure();
        check(`${name}: above 85% only the machine part turns amber`, tight.machineColor === 'rgb(255, 149, 0)' && tight.machineText === (mobile ? '本机 29/32 GB' : 'MacMini 29/32 GB')
            && tight.text.startsWith(mobile ? '2.3 GB · ' : '会话 2.3 GB · '), tight);
        await page.screenshot({path: path.join(out, `${name}-tight.png`), clip: {x: 0, y: Math.max(0, viewport.height - 220), width: viewport.width, height: 220}});
        await page.evaluate(resources => setMachineResources(resources), sample(16, null)); await settle();
        const untracked = await measure();
        check(`${name}: an untracked session still shows its machine`, untracked.text === (mobile ? '本机 16/32 GB' : 'MacMini 16/32 GB'), untracked);
        await page.evaluate(() => setMachineResources(null)); await settle();
        const gone = await measure();
        check(`${name}: an offline machine removes the figure`, gone.memory === null, gone);
        check(`${name}: the composer card does not move when the figure comes and goes`, composerBefore && gone.composer && shown.composer
            && Math.abs(shown.composer.y - gone.composer.y) < 1 && Math.abs(shown.composer.h - gone.composer.h) < 1, {before: composerBefore, shown: shown.composer, gone: gone.composer});
        await context.close();
    }
})().catch(error => errors.push(String(error))).finally(async () => {
    await browser?.close(); child.kill('SIGTERM');
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({build, engine: process.env.LMC_WEBKIT ? 'webkit' : 'edge', checks, errors}, null, 2));
    const failed = checks.filter(c => !c.passed).map(c => c.label);
    console.log(JSON.stringify({out, checks: checks.length, failed, errors}, null, 2));
    if (failed.length || errors.length) process.exitCode = 1;
});
