#!/usr/bin/env node
// D24: a table in a reply can be copied as a table and as a picture. A mouse
// shows the two buttons by pointing at the table, a finger by tapping it; a
// browser that cannot put a picture on the clipboard offers to save it instead.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {webkit, chromium} = require(process.env.LMC_PLAYWRIGHT_MODULE);
const build = path.resolve(process.argv[2]);
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-table-copy-'));
const checks = [], errors = [];
const check = (label, passed, details) => checks.push({label, passed: !!passed, details});
const child = spawn(process.execPath, [path.join(__dirname, 'session-header.cjs'), build, '--serve'], {stdio: ['ignore', 'pipe', 'inherit']});
const isWebkit = !!process.env.LMC_WEBKIT;
let browser;
const msg = (id, text) => ({kind: 'agent-text', id, localId: null, createdAt: 1700000000000 + Number(id.replace(/\D/g, '') || 0), text, isThinking: false});
const TABLE = ['上面一段正文。', '', '| 机器 | 最近落盘 | Claude 上行 | Claude 下行 | OpenAI 上行 | OpenAI 下行 |', '|---|---|---|---|---|---|',
    '| Mac **mini** | 1 分钟内 | 3.8 MB | 7.0 MB | 9.2 MB | 104.7 MB |', '| `workstation-a` | 1 分钟内 | 0.5 MB | 1.7 MB | 5.6 MB | 184.0 MB |',
    '| MacBook | 这一格的文字特别长，长到一行放不下，用来确认图片里会自动换行而不是被截断或者溢出到隔壁那一列里去，再多写一些字凑够长度 | 0.8 MB | 2.9 MB | 0.2 MB | 21.3 MB |', '', '下面一段正文。'].join('\n');
// What a paste target would receive.
const clipboard = tab => tab.evaluate(async () => {
    const items = await navigator.clipboard.read(), result = {};
    for (const item of items) for (const type of item.types) {
        const blob = await item.getType(type);
        if (type === 'image/png') { const bitmap = await createImageBitmap(blob); const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height; const x = c.getContext('2d'); x.drawImage(bitmap, 0, 0);
            const px = (u, v) => [...x.getImageData(u, v, 1, 1).data]; let ink = 0; const row = x.getImageData(0, Math.floor(bitmap.height / 2), bitmap.width, 1).data; for (let i = 0; i < row.length; i += 4) if (row[i] < 128) ink++;
            result[type] = {width: bitmap.width, height: bitmap.height, corner: px(2, 2), ink, data: c.toDataURL('image/png')}; }
        else result[type] = await blob.text();
    }
    return result;
});
const pill = tab => tab.evaluate(() => { const b = [...document.querySelectorAll('[role="button"]')].filter(e => /^(复制表格|复制为图片|保存图片|已复制 ✓|复制失败)$/.test(e.innerText.trim())); return b.map(e => e.innerText.trim()); });
(async () => {
    const url = await new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('Fixture timeout')), 15000);
        child.stdout.on('data', data => { output += data; const match = output.match(/Fixture: (http:\/\/127\.0\.0\.1:\d+)/); if (match) {clearTimeout(timer); resolve(match[1]);} });
        child.once('exit', code => {clearTimeout(timer); reject(new Error(`Fixture exit ${code}`));});
    });
    browser = await (isWebkit ? webkit : chromium).launch({headless: true, ...(!isWebkit ? {executablePath: process.env.LMC_CHROME_PATH} : {})});
    for (const [name, viewport, mobile, scheme] of [['desktop', {width: 1280, height: 900}, false, 'light'], ['desktop-dark', {width: 1280, height: 900}, false, 'dark'], ['phone', {width: 390, height: 1200}, true, 'light'], ['phone-no-image-clipboard', {width: 390, height: 1200}, true, 'light']]) {
        const context = await browser.newContext({viewport, hasTouch: mobile, isMobile: mobile && !isWebkit ? true : undefined, colorScheme: scheme, acceptDownloads: true, ...(!isWebkit ? {permissions: ['clipboard-read', 'clipboard-write']} : {})});
        if (name === 'phone-no-image-clipboard') await context.addInitScript(() => { delete window.ClipboardItem; /* no share sheet in a headless browser: take the download path */ Object.defineProperty(navigator, 'canShare', {value: undefined}); });
        const tab = await context.newPage();
        tab.on('pageerror', error => errors.push(`${name}: ${error.message}`));
        await tab.goto(url); await tab.getByRole('button', {name: '隐藏测试控件', exact: true}).click();
        await tab.locator('textarea[data-lmc-text-input]').waitFor();
        await tab.evaluate(list => window.setMessages(list), [msg('m1', TABLE)]);
        const cell = tab.getByText('1 分钟内').first(); await cell.waitFor();
        await tab.evaluate(() => document.fonts.ready);
        check(`${name}: no buttons until the table is pointed at or tapped`, (await pill(tab)).length === 0, await pill(tab));
        if (mobile) await cell.tap(); else await cell.hover();
        await tab.waitForTimeout(150);
        const labels = await pill(tab);
        const second = name === 'phone-no-image-clipboard' ? '保存图片' : '复制为图片';
        check(`${name}: ${mobile ? 'a tap' : 'pointing'} shows 复制表格 and ${second}`, labels.join('|') === `复制表格|${second}`, labels);
        // The buttons sit astride the top edge: they must not cover the header text.
        const headerBox = await tab.getByText('机器', {exact: true}).first().boundingBox();
        const pillBox = await tab.getByRole('button', {name: '复制表格', exact: true}).locator('..').boundingBox();
        const overlap = {pillBottom: pillBox.y + pillBox.height, headerTextTop: headerBox.y, pillRight: pillBox.x + pillBox.width, width: viewport.width};
        check(`${name}: the buttons clear the header text and stay on screen`, overlap.pillBottom <= overlap.headerTextTop + 1 && overlap.pillRight <= overlap.width, overlap);
        await tab.screenshot({path: path.join(out, `${name}-shown.png`)});
        if (name === 'phone-no-image-clipboard') {
            const [download] = await Promise.all([tab.waitForEvent('download', {timeout: 8000}).catch(() => null), tab.getByRole('button', {name: '保存图片', exact: true}).tap()]);
            const file = download && await download.path(); const size = file ? fs.statSync(file).size : 0;
            if (file) fs.copyFileSync(file, path.join(out, `${name}-saved.png`));
            check(`${name}: 保存图片 hands over a PNG file`, download?.suggestedFilename() === 'table.png' && size > 2000, {name: download?.suggestedFilename(), size});
            await context.close(); continue;
        }
        const press = label => mobile ? tab.getByRole('button', {name: label, exact: true}).tap() : tab.getByRole('button', {name: label, exact: true}).click();
        await press('复制表格'); await tab.waitForTimeout(250);
        if (!isWebkit) {
            const got = await clipboard(tab);
            check(`${name}: the clipboard holds a real table with the formatting`, /^<meta[^>]*>?<table>|<table>/.test(got['text/html'] || '') && got['text/html'].includes('<th>机器</th>') && got['text/html'].includes('Mac <b>mini</b>') && got['text/html'].includes('<code>workstation-a</code>'), (got['text/html'] || '').slice(0, 300));
            const lines = (got['text/plain'] || '').split('\n');
            check(`${name}: the plain text is one line per row, tabs between columns`, lines.length === 4 && lines.every(l => l.split('\t').length === 6) && lines[1].startsWith('Mac mini\t1 分钟内\t3.8 MB'), lines.map(l => l.slice(0, 40)));
        }
        if (mobile) {
            // The toast layer belongs to the app shell, which this fixture does not mount; only the buttons can be seen leaving.
            check(`${name}: the buttons go away once used`, (await pill(tab)).length === 0, await pill(tab));
            await cell.tap(); await tab.waitForTimeout(150);
            await tab.getByText('下面一段正文。').first().tap(); await tab.waitForTimeout(150);
            check(`${name}: tapping elsewhere puts the buttons away`, (await pill(tab)).length === 0, await pill(tab));
            await cell.tap(); await tab.waitForTimeout(150);
        } else {
            const now = await pill(tab);
            check(`${name}: the button itself says 已复制 for a moment, then goes back`, now[0] === '已复制 ✓', now);
            await tab.waitForTimeout(1700);
            check(`${name}: and goes back`, (await pill(tab))[0] === '复制表格', await pill(tab));
        }
        await press('复制为图片'); await tab.waitForTimeout(600);
        if (!isWebkit) {
            const got = (await clipboard(tab))['image/png'];
            if (got?.data) fs.writeFileSync(path.join(out, `${name}-copied.png`), Buffer.from(got.data.split(',')[1], 'base64'));
            const shown = await tab.getByText('机器', {exact: true}).first().evaluate(t => { let n = t; while (n.parentElement && !(n.scrollWidth > n.clientWidth + 1)) n = n.parentElement; return {visible: n.clientWidth, full: n.scrollWidth}; });
            check(`${name}: the picture is the whole table at 2x on white, whatever the theme`, got && got.width >= 1200 && got.height > 300 && got.corner.slice(0, 3).every(v => v === 255) && got.ink > 20, got && {width: got.width, height: got.height, corner: got.corner, ink: got.ink, shown});
        }
        if (!mobile) { await tab.mouse.move(5, 5); await tab.waitForTimeout(150); check(`${name}: the buttons leave with the pointer`, (await pill(tab)).length === 0, await pill(tab)); }
        await context.close();
    }
    check('No page errors', errors.length === 0, errors);
})().catch(error => check('Run completed', false, String(error.stack || error))).finally(async () => {
    await browser?.close(); child.kill();
    fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify(checks, null, 1));
    for (const c of checks) console.log(`${c.passed ? 'PASS' : 'FAIL'} ${c.label}${c.passed ? '' : ' ' + JSON.stringify(c.details)}`);
    console.log(`Artifacts: ${out}`);
    process.exit(checks.some(c => !c.passed) ? 1 : 0);
});
