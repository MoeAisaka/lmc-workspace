#!/usr/bin/env node
// D29: the usage dashboard's AI traffic card — totals per provider with the
// up/down split, per-machine rows, the monthly projection from whole days,
// the period and device filters, and the state before any machine reports.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {webkit, chromium} = require(process.env.LMC_PLAYWRIGHT_MODULE);
const build = path.resolve(process.argv[2]);
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-ai-traffic-'));
const checks = [], errors = [];
const check = (label, passed, details) => checks.push({label, passed: !!passed, details});
const child = spawn(process.execPath, [path.join(__dirname, 'usage-dashboard.cjs'), build], {stdio: ['ignore', 'pipe', 'inherit']});
let browser;
(async () => {
    const url = await new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('Fixture timeout')), 15000);
        child.stdout.on('data', data => { output += data; const match = output.match(/Fixture: (http:\/\/127\.0\.0\.1:\d+)/); if (match) {clearTimeout(timer); resolve(match[1]);} });
        child.once('exit', code => {clearTimeout(timer); reject(new Error(`Fixture exit ${code}`));});
    });
    browser = await (process.env.LMC_WEBKIT ? webkit : chromium).launch({headless: true, ...(!process.env.LMC_WEBKIT ? {executablePath: process.env.LMC_CHROME_PATH} : {})});
    for (const [name, viewport] of [['desktop', {width: 1280, height: 900}], ['phone', {width: 390, height: 844}]]) {
        const context = await browser.newContext({viewport});
        await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
        const page = await context.newPage(); page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
        await page.goto(url);
        const card = page.locator('[data-testid="usage-traffic-card"]');
        await card.waitFor();
        const read = () => page.evaluate(() => {
            const text = sel => (document.querySelector(sel)?.innerText ?? '').replace(/\s+/g, ' ').trim();
            const box = sel => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r ? {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)} : null; };
            const card = document.querySelector('[data-testid="usage-traffic-card"]');
            return {total: text('[data-testid="ai-traffic-total"]'), claude: text('[data-testid="ai-traffic-claude"]'), openai: text('[data-testid="ai-traffic-openai"]'), projection: text('[data-testid="ai-traffic-projection"]'),
                rows: [...document.querySelectorAll('[data-testid^="ai-traffic-row-"]')].map(n => n.getAttribute('data-testid').slice(15) + ' ' + n.innerText.replace(/\s+/g, ' ').trim()),
                empty: text('[data-testid="ai-traffic-empty"]'), card: box('[data-testid="usage-traffic-card"]'), model: box('[data-testid="usage-model-card"]'), session: box('[data-testid="usage-session-card"]'),
                boxes: ['total', 'claude', 'openai', 'projection'].map(k => box(`[data-testid="ai-traffic-${k}"]`)),
                overflow: card ? card.scrollWidth - card.clientWidth : null, pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth};
        });
        const today = await read();
        // Fixture today: Mac mini Claude 1.5 GB up/60 MB down, OpenAI 90/100 MB; MacBook Claude 2 GB/70 MB, OpenAI 55/65 MB.
        check(`${name}: today's totals carry the up/down split`, today.total.includes('3.93 GB') && today.total.includes('↑ 3.64 GB') && today.total.includes('↓ 295 MB')
            && today.claude.includes('3.63 GB') && today.claude.includes('↑ 3.50 GB') && today.openai.includes('310 MB') && today.openai.includes('↑ 145 MB · ↓ 165 MB'), today);
        check(`${name}: machines are listed largest first with a Claude and an OpenAI row each`, today.rows.length === 4 && today.rows[0].startsWith('m2-claude') && today.rows[0].includes('2.07 GB')
            && today.rows[1].startsWith('m2-openai') && today.rows[2].startsWith('m1-claude') && today.rows[2].includes('↑ 1.50 GB') && today.rows[3].includes('190 MB'), today.rows);
        // Mac mini: six whole days of 4 GB in the last seven; MacBook began yesterday, so it has no whole day.
        check(`${name}: the month is projected from whole days only`, today.projection.includes('≈ 119 GB') && today.projection.includes('日均 3.98 GB × 30') && !today.projection.includes('仅'), today.projection);
        check(`${name}: the card sits between the model card and the session card without overflowing`, today.card && today.model && today.session && today.card.y >= today.model.y + today.model.h && today.session.y >= today.card.y + today.card.h
            && today.overflow <= 1 && today.pageOverflow <= 1, {card: today.card, model: today.model, session: today.session, overflow: today.overflow, pageOverflow: today.pageOverflow});
        const ys = new Set(today.boxes.map(b => b.y));
        check(`${name}: the four figures are ${name === 'phone' ? 'two rows of two' : 'one row'}`, name === 'phone' ? ys.size === 2 && today.boxes[0].y === today.boxes[1].y && today.boxes[2].y === today.boxes[3].y : ys.size === 1, today.boxes);
        await card.scrollIntoViewIfNeeded(); await page.screenshot({path: path.join(out, `${name}-today.png`)});
        await page.getByText('7 天', {exact: true}).first().click();
        const week = await read();
        // 7 days: today + six days at 3 GB/100 MB/400 MB/500 MB for Mac mini, + MacBook's yesterday.
        check(`${name}: the period filter changes the totals`, week.total.includes('28.0 GB') && week.claude.includes('·') && week.rows[0].startsWith('m1-claude'), week);
        if (name === 'desktop') {
            await page.getByText('MacBook', {exact: true}).first().click();
            const one = await read();
            check('desktop: the device filter narrows the card to that machine', one.rows.length === 2 && one.rows.every(r => r.startsWith('m2-')) && one.projection.includes('—') && one.projection.includes('满一整天后开始推算'), one);
            await page.getByText('全部设备', {exact: true}).first().click();
            await page.getByRole('button', {name: '深色', exact: true}).click(); await page.waitForTimeout(300);
            await card.scrollIntoViewIfNeeded(); await page.screenshot({path: path.join(out, 'desktop-dark-7days.png')});
            await page.getByRole('button', {name: '浅色', exact: true}).click();
        }
        await page.getByRole('button', {name: '空数据', exact: true}).click(); await page.waitForTimeout(200);
        const empty = await read();
        check(`${name}: before any machine reports, the card says so and shows no figures`, empty.empty.includes('还没有流量数据') && !empty.total && !empty.rows.length, empty);
        await page.getByRole('button', {name: '午夜空数据', exact: true}).click(); await page.waitForTimeout(200);
        check(`${name}: without a ledger source the card is left out`, await card.count() === 0);
        await context.close();
    }
    check('No page errors', errors.length === 0, errors);
})().catch(error => check('Run completed', false, String(error.stack || error))).finally(async () => {
    await browser?.close(); child.kill();
    const failed = checks.filter(c => !c.passed);
    fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify(checks, null, 1));
    for (const c of checks) console.log(`${c.passed ? 'PASS' : 'FAIL'} ${c.label}${c.passed ? '' : ' ' + JSON.stringify(c.details)}`);
    console.log(`Artifacts: ${out}`);
    process.exit(failed.length ? 1 : 0);
});
