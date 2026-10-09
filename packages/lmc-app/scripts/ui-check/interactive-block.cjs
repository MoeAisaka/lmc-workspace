#!/usr/bin/env node
// D30: an interactive answer renders in a sandboxed frame that fits its page;
// an unfinished fence waits, a broken or oversized page says so, a ref shows
// an earlier block, the off setting collapses it, and full screen opens a modal.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {webkit, chromium} = require(process.env.LMC_PLAYWRIGHT_MODULE);
const build = path.resolve(process.argv[2]);
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-interactive-'));
const checks = [], errors = [];
const check = (label, passed, details) => checks.push({label, passed: !!passed, details});
const child = spawn(process.execPath, [path.join(__dirname, 'session-header.cjs'), build, '--serve'], {stdio: ['ignore', 'pipe', 'inherit']});
let browser;
const page = (body, extra = '') => `<!doctype html><html><head><meta charset="utf-8">${extra}</head><body>${body}</body></html>`;
const msg = (id, text) => ({kind: 'agent-text', id, localId: null, createdAt: 1700000000000 + Number(id.replace(/\D/g, '') || 0), text, isThinking: false});
const tall = page('<div style="height:900px;background:linear-gradient(#cde,#eee)">tall</div>');
const short = page('<p id="hello">短页面</p>');
(async () => {
    const url = await new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('Fixture timeout')), 15000);
        child.stdout.on('data', data => { output += data; const match = output.match(/Fixture: (http:\/\/127\.0\.0\.1:\d+)/); if (match) {clearTimeout(timer); resolve(match[1]);} });
        child.once('exit', code => {clearTimeout(timer); reject(new Error(`Fixture exit ${code}`));});
    });
    browser = await (process.env.LMC_WEBKIT ? webkit : chromium).launch({headless: true, ...(!process.env.LMC_WEBKIT ? {executablePath: process.env.LMC_CHROME_PATH} : {})});
    for (const [name, viewport, mobile] of [['desktop', {width: 1280, height: 900}, false], ['phone', {width: 390, height: 844}, true]]) {
        const context = await browser.newContext({viewport, hasTouch: mobile});
        // The page may reach the network; everything but the fixture and one allowed host is refused here.
        await context.route('**/*', route => { const host = new URL(route.request().url()).hostname; return host === '127.0.0.1' ? route.continue() : host === 'cdn.example' ? route.fulfill({status: 200, contentType: 'application/javascript', body: 'window.cdnLoaded=true'}) : route.abort(); });
        const tab = await context.newPage();
        // The broken page below throws on purpose; Playwright reports frame errors on the page.
        tab.on('pageerror', error => { if (!error.message.includes('undefinedFunction')) errors.push(`${name}: ${error.message}`); });
        await tab.goto(url); await tab.getByRole('button', {name: '隐藏测试控件', exact: true}).click();
        await tab.locator('textarea[data-lmc-text-input]').waitFor();
        const set = list => tab.evaluate(list => window.setMessages(list), list);
        const read = () => tab.evaluate(() => {
            const blocks = [...document.querySelectorAll('[data-testid="interactive-block"]')].map(b => ({state: b.dataset.lmcInteractiveState, kind: b.dataset.lmcInteractive, title: b.querySelector('[data-testid="interactive-source"]') ? b.innerText.split('\n')[0] : b.innerText.split('\n')[0],
                shown: b.querySelector('[data-testid="interactive-viewport"]')?.getBoundingClientRect().height, expand: b.querySelector('[data-testid="interactive-expand"]')?.innerText, frame: (f => f ? {h: f.getBoundingClientRect().height, w: f.getBoundingClientRect().width, sandbox: f.getAttribute('sandbox'), srcdoc: (f.getAttribute('srcdoc') || '').length} : null)(b.querySelector('iframe[data-testid="interactive-frame"]')),
                text: b.innerText.replace(/\s+/g, ' ').trim(), network: !!b.querySelector('[data-testid="interactive-network"]')}));
            return {blocks, collapsed: document.querySelectorAll('[data-testid="interactive-collapsed"]').length, fullscreen: !!document.querySelector('[data-testid="interactive-fullscreen"]'), fullscreenFrame: (f => f ? f.getBoundingClientRect().height : 0)(document.querySelector('iframe[data-testid="interactive-fullscreen-frame"]')), pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth};
        });
        // 1. A tall page and a short page, each sized to its content.
        await set([msg('m1', '两张页面：\n\n```lmc-ui id=tall title="高页面"\n' + tall + '\n```\n\n```lmc-ui id=short title="短页面"\n' + short + '\n```\n\n完。')]);
        await tab.waitForFunction(() => [...document.querySelectorAll('iframe[data-testid="interactive-frame"]')].length === 2 && [...document.querySelectorAll('iframe[data-testid="interactive-frame"]')].every(f => f.getBoundingClientRect().height >= 96), null, {timeout: 15000}).catch(() => {});
        await tab.waitForTimeout(1500);
        let r = await read();
        const cap = Math.round(viewport.height * 0.7);
        check(`${name}: both pages render in sandboxed frames`, r.blocks.length === 2 && r.blocks.every(b => b.frame && b.frame.sandbox === 'allow-scripts allow-forms allow-modals' && b.state === 'shown'), r.blocks);
        check(`${name}: the tall page is cut at 70% of the screen with a way to show all, and the short one fits its content`, r.blocks[0]?.shown === cap && r.blocks[0]?.frame?.h > 900 && r.blocks[0]?.expand === '展开全部' && r.blocks[1]?.frame?.h >= 96 && r.blocks[1]?.frame?.h < 200 && !r.blocks[1]?.expand && r.pageOverflow <= 1, {blocks: r.blocks.map(b => ({shown: b.shown, h: b.frame?.h, expand: b.expand})), cap, overflow: r.pageOverflow});
        // Neither page may scroll inside its frame: an inner scroller stalls the transcript at the block's edge.
        const inner = await Promise.all(tab.frames().filter(f => f !== tab.mainFrame()).map(f => f.evaluate(() => ({overflow: getComputedStyle(document.documentElement).overflowY, room: document.documentElement.scrollHeight - document.documentElement.clientHeight})).catch(() => null)));
        check(`${name}: the pages cannot scroll inside their frames`, inner.length === 2 && inner.every(f => f && f.overflow === 'hidden' && f.room <= 0), inner);
        await tab.getByTestId('interactive-expand').click(); await tab.waitForTimeout(200); r = await read();
        check(`${name}: show all reveals the whole page and can be undone`, r.blocks[0]?.shown === r.blocks[0]?.frame?.h && r.blocks[0]?.expand === '收起', {shown: r.blocks[0]?.shown, h: r.blocks[0]?.frame?.h, expand: r.blocks[0]?.expand});
        await tab.getByTestId('interactive-expand').click(); await tab.waitForTimeout(200); r = await read();
        check(`${name}: the header carries the title`, r.blocks[0]?.text.startsWith('高页面') && r.blocks[1]?.text.startsWith('短页面'), r.blocks.map(b => b.text.slice(0, 20)));
        // The frame must not creep: its own height echoed back used to add 2px a second.
        const heights = () => tab.evaluate(() => [...document.querySelectorAll('iframe[data-testid="interactive-frame"]')].map(f => f.getBoundingClientRect().height));
        const h0 = await heights(); await tab.waitForTimeout(3500); const h1 = await heights();
        check(`${name}: a shown page keeps its height`, JSON.stringify(h0) === JSON.stringify(h1), {h0, h1});
        if (!mobile) {
            // Wheel over the page must move the transcript the same way as wheel over the text beside it.
            // Newest first: the page sits at the bottom of the transcript with older text above it.
            await set([msg('m99', '短页面：\n\n```lmc-ui id=short title="短页面"\n' + short + '\n```\n\n完。'), ...Array.from({length: 12}, (_, i) => msg('f' + i, '填充段落 ' + i + '\n\n' + '内容 '.repeat(500)))]);
            await tab.locator('iframe[data-testid="interactive-frame"]').waitFor(); await tab.waitForTimeout(1500);
            const top = () => tab.evaluate(() => document.querySelector('iframe[data-testid="interactive-frame"]').getBoundingClientRect().top);
            const box = await tab.locator('iframe[data-testid="interactive-frame"]').boundingBox();
            const moves = [];
            for (const y of [box.y - 60, box.y + box.height / 2]) {
                const before = await top(); await tab.mouse.move(box.x + box.width / 2, y); await tab.mouse.wheel(0, -120); await tab.waitForTimeout(500);
                const after = await top(); moves.push(after - before);
                await tab.mouse.move(box.x + box.width / 2, box.y - 60); await tab.mouse.wheel(0, 120); await tab.waitForTimeout(500);
            }
            check(`${name}: wheel over the page scrolls the transcript the same way as over text`, moves[0] > 20 && moves[1] > 20, moves);
            await set([msg('m1', '两张页面：\n\n```lmc-ui id=tall title="高页面"\n' + tall + '\n```\n\n```lmc-ui id=short title="短页面"\n' + short + '\n```\n\n完。')]);
            await tab.waitForFunction(() => document.querySelectorAll('iframe[data-testid="interactive-frame"]').length === 2, null, {timeout: 15000}).catch(() => {});
            await tab.waitForTimeout(600);
        }
        await tab.screenshot({path: path.join(out, `${name}-pages.png`)});
        // 2. Streaming, errors, size, network, ref.
        const big = page('<p>' + 'x'.repeat(210 * 1024) + '</p>');
        await set([msg('m1', '```lmc-ui id=short title="短页面"\n' + short + '\n```'),
            msg('m2', '```lmc-ui id=broken title="坏页面"\n' + page('<p>x</p><script>undefinedFunction()</script>') + '\n```'),
            msg('m3', '```lmc-ui id=big title="大页面"\n' + big + '\n```'),
            msg('m4', '```lmc-ui id=net title="联网页面"\n' + page('<p>n</p>', '<script src="https://cdn.example/lib.js"></script>') + '\n```'),
            msg('m5', '```lmc-ui ref=short\n```\n\n```lmc-ui ref=nothing\n```'),
            msg('m6', '```lmc-ui id=writing title="写到一半"\n<html><body>')]);
        await tab.waitForFunction(() => document.querySelectorAll('[data-testid="interactive-network"]').length === 1 && document.querySelectorAll('[data-testid="interactive-error"]').length >= 3, null, {timeout: 15000}).catch(() => {});
        await tab.waitForTimeout(400);
        r = await read();
        const by = title => r.blocks.find(b => b.text.startsWith(title));
        check(`${name}: a page whose script throws is reported, not shown`, by('坏页面')?.state === 'error' && by('坏页面')?.text.includes('没能显示'), by('坏页面'));
        check(`${name}: a page over 200 KB is refused`, by('大页面')?.state === 'error' && by('大页面')?.text.includes('200 KB'), by('大页面')?.text);
        check(`${name}: a page that loads from the network is tagged`, by('联网页面')?.network === true && by('联网页面')?.state === 'shown' && !by('短页面')?.network, {net: by('联网页面'), short: by('短页面')?.network});
        const refs = r.blocks.filter(b => b.kind === 'ref');
        check(`${name}: a ref shows the earlier block, a missing ref says so`, refs.length === 2 && refs[0].state === 'shown' && refs[0].text.startsWith('短页面') && refs[0].frame?.srcdoc > 100 && refs[1].state === 'error' && refs[1].text.includes('没找到'), refs.map(b => ({state: b.state, text: b.text.slice(0, 30)})));
        check(`${name}: an unfinished block waits instead of rendering half a page`, by('写到一半')?.state === 'pending' && by('写到一半')?.text.includes('正在生成') && !by('写到一半')?.frame, by('写到一半'));
        await tab.screenshot({path: path.join(out, `${name}-states.png`)});
        // 3. Source view and full screen.
        await set([msg('m1', '```lmc-ui id=short title="短页面"\n' + short + '\n```')]);
        await tab.locator('[data-testid="interactive-source"]').first().click(); await tab.waitForTimeout(200);
        r = await read();
        check(`${name}: the source button shows the page's HTML`, r.blocks[0]?.text.includes('<p id="hello">') && !r.blocks[0]?.frame, r.blocks[0]?.text.slice(0, 80));
        await tab.locator('[data-testid="interactive-source"]').first().click(); await tab.waitForTimeout(200);
        await tab.locator('[data-testid="interactive-fullscreen-button"]').first().click();
        await tab.waitForFunction(() => (document.querySelector('iframe[data-testid="interactive-fullscreen-frame"]')?.getBoundingClientRect().height || 0) > 400, null, {timeout: 10000}).catch(() => {});
        r = await read();
        check(`${name}: full screen opens a modal with the page filling the window`, r.fullscreen && r.fullscreenFrame > viewport.height * 0.8, {fullscreen: r.fullscreen, h: r.fullscreenFrame});
        await tab.screenshot({path: path.join(out, `${name}-fullscreen.png`)});
        await tab.keyboard.press('Escape'); await tab.waitForTimeout(300);
        r = await read();
        check(`${name}: Escape closes full screen`, !r.fullscreen, r.fullscreen);
        // 4. Off: collapsed until tapped.
        await tab.evaluate(() => window.setSettings({interactiveAnswers: 'off'})); await tab.waitForTimeout(300);
        r = await read();
        check(`${name}: with the feature off the block collapses to one line`, r.collapsed === 1 && r.blocks.length === 0, {collapsed: r.collapsed, blocks: r.blocks.length});
        await tab.locator('[data-testid="interactive-collapsed"]').click(); await tab.waitForTimeout(500);
        r = await read();
        check(`${name}: tapping the collapsed line shows the page`, r.collapsed === 0 && r.blocks[0]?.state === 'shown', {collapsed: r.collapsed, state: r.blocks[0]?.state});
        await tab.evaluate(() => window.setSettings({interactiveAnswers: 'auto'}));
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
