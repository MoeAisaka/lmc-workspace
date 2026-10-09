// Real exported modules; synthetic sessions; no external requests or credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const base = process.env.LMC_STYLE_URL || 'http://127.0.0.1:4201/app';
const settings = process.env.LMC_SETTINGS_FIXTURE_URL || 'http://127.0.0.1:4187/app';
const out = fs.mkdtempSync('/tmp/lmc-additional-font-qa-');
const choices = [
    { font: 'misans', label: 'MiSans', latin: 'MiSans', chinese: 'MiSans' },
    { font: 'wenkai', label: '霞鹜文楷', latin: 'LXGW WenKai', chinese: 'LXGW WenKai' },
    { font: 'newsreader', label: 'Newsreader', latin: 'Newsreader', chinese: 'Noto Serif SC', reading: 'editorial' },
    { font: 'sourceSerif', label: 'Source Serif 4', latin: 'Source Serif 4', chinese: 'Noto Serif SC', reading: 'academic' },
    { font: 'sarasa', label: '更纱等宽 SC', latin: 'Sarasa Mono SC', chinese: 'Sarasa Mono SC', codeOnly: true },
    { font: 'jetbrains', label: 'JetBrains Mono', latin: 'JetBrains Mono', chinese: 'Sarasa Mono SC', codeOnly: true },
];
console.log('Artifacts: ' + out);
const settle = async page => {
    await page.waitForFunction(() => document.documentElement.dataset.lmcFontStatus !== 'loading' && document.documentElement.dataset.lmcCodeFontStatus !== 'loading');
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('html').getAttribute('data-lmc-font-status'), 'ready');
    assert.equal(await page.locator('html').getAttribute('data-lmc-code-font-status'), 'ready');
};
const select = async (page, row, label) => {
    await page.getByRole('button', { name: new RegExp('^' + row + ':') }).click();
    const menu = page.getByTestId('settings-select-menu');
    await menu.getByRole('button', { name: new RegExp('^' + label + '(?:$|\\s)') }).click();
    await menu.waitFor({ state: 'hidden' });
    await settle(page);
};
const read = page => page.evaluate(() => moduleExport('storage').storage.getState().localSettings.personalization);

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const results = [], menus = [];
    try {
        for (const width of [320, 390, 1100]) for (const theme of ['light', 'dark']) {
            const height = width === 320 ? 568 : 900;
            for (const choice of choices) {
                const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
                const external = [], errors = [], failed = [];
                await context.route('**/*', route => {
                    if (new URL(route.request().url()).origin === new URL(base).origin) return route.continue();
                    external.push(route.request().url()); return route.abort();
                });
                const page = await context.newPage(); page.setDefaultTimeout(20000);
                page.on('pageerror', error => errors.push(error.message));
                page.on('response', response => { if (response.status() >= 400) failed.push(response.url()); });
                await page.goto(base + `?screen=reading&theme=${theme}&font=${choice.codeOnly ? 'songti' : choice.font}&code=${choice.font}&reading=${choice.reading || 'standard'}`);
                await page.locator('[data-reading-reply=claude]').waitFor(); await settle(page);
                const cdp = await context.newCDPSession(page); await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
                const fonts = async (selector, text, name) => {
                    await page.locator(selector).evaluate((root, { text, name }) => {
                        const node = [...root.querySelectorAll('*')].find(n => !n.children.length && n.textContent === text);
                        if (!node) throw Error('Missing glyph probe: ' + text);
                        node.setAttribute('data-font-probe', name);
                    }, { text, name });
                    const { root } = await cdp.send('DOM.getDocument');
                    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-font-probe="${name}"]` });
                    return (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
                };
                const expectFont = (rendered, family) => assert.ok(rendered.some(f => f.isCustomFont && f.familyName.startsWith(family)), JSON.stringify({ family, rendered }));
                const rendered = [];
                for (const engine of ['claude', 'codex']) {
                    const reply = `[data-reading-reply=${engine}]`;
                    const chinese = await fonts(reply, '重要的信息', engine + '-body-zh');
                    const latin = await fonts(reply, 'Clear emphasis', engine + '-body-en');
                    const inline = await fonts(reply, 'src/reading.ts', engine + '-code');
                    const codeChinese = await fonts(`[data-engine=${engine}] [data-lmc-mail=task]`, '/workspace/project/docs/verification/reading-layout-and-mail-card-regression-20261002.md', engine + '-mail-code');
                    expectFont(chinese, choice.codeOnly ? 'Noto Serif SC' : choice.chinese);
                    expectFont(latin, choice.codeOnly ? 'Noto Serif SC' : choice.latin);
                    expectFont(inline, choice.latin);
                    expectFont(codeChinese, choice.latin);
                    const metrics = await page.locator(reply).evaluate(root => {
                        const css = selector => { const s = getComputedStyle(root.querySelector(selector)); return { size: parseFloat(s.fontSize), line: parseFloat(s.lineHeight), weight: s.fontWeight, font: s.fontFamily }; };
                        return { h1: css('[data-lmc-heading="1"]'), h2: css('[data-lmc-heading="2"]'), body: css('[data-lmc-block="paragraph"]') };
                    });
                    assert.ok(metrics.h1.size > metrics.h2.size && metrics.h2.size > metrics.body.size);
                    assert.equal(metrics.body.size, 16);
                    const mailSizes = await page.locator(`[data-engine=${engine}] [data-lmc-mail] [data-lmc-block=paragraph], [data-engine=${engine}] [data-lmc-mail] [data-lmc-list-text]`).evaluateAll(nodes => nodes.map(n => parseFloat(getComputedStyle(n).fontSize)));
                    assert.ok(mailSizes.length && mailSizes.every(s => s === 14), 'mail must remain smaller than normal prose');
                    rendered.push({ engine, chinese, latin, inline, metrics });
                }
                // Same text, same font, actual pixels: real weight differs even
                // without browser synthesis (WenKai has a genuine Medium face).
                if (!choice.codeOnly) for (const probe of ['claude-body-zh', 'claude-body-en']) {
                    const target = page.locator(`[data-font-probe="${probe}"]`);
                    await target.evaluate(n => { n.style.fontSynthesis = 'none'; });
                    const emphasized = await target.screenshot();
                    await target.evaluate(n => { n.style.fontWeight = '400'; });
                    await page.evaluate(() => document.fonts.ready);
                    const regular = await target.screenshot();
                    assert.ok(!emphasized.equals(regular), `${choice.font} ${probe} must visibly preserve bold`);
                    await target.evaluate(n => { n.style.removeProperty('font-weight'); n.style.removeProperty('font-synthesis'); });
                }
                // Mixed Chinese code uses the selected family, including the
                // explicit CJK companion for JetBrains Mono.
                await page.evaluate(() => {
                    const root = document.querySelector('[data-reading-reply=claude]');
                    const code = [...root.querySelectorAll('*')].find(n => !n.children.length && n.textContent === 'src/reading.ts');
                    code.textContent = '代码路径/example.ts'; code.dataset.fontProbe = 'mixed-code';
                });
                await page.evaluate(() => document.fonts.ready);
                const mixed = await fonts('[data-reading-reply=claude]', '代码路径/example.ts', 'mixed-code');
                expectFont(mixed, choice.chinese); expectFont(mixed, choice.latin);
                if (choice.font === 'sarasa') {
                    const widths = await page.evaluate(() => { const c = document.createElement('canvas').getContext('2d'); c.font = '16px "LMC Sarasa Mono"'; return ['中', 'a', 'i', 'W'].map(s => c.measureText(s).width); });
                    assert.ok(Math.abs(widths[0] - widths[1] * 2) < 0.05); assert.equal(widths[1], widths[2]); assert.equal(widths[2], widths[3]);
                }
                assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
                await page.locator('#reading-fixture').evaluate(n => { n.scrollTop = 0; });
                await page.screenshot({ path: path.join(out, `${choice.font}-${width}-${theme}-reply.png`) });
                await page.locator('[data-engine=claude] [data-lmc-mail=message]').screenshot({ path: path.join(out, `${choice.font}-${width}-${theme}-mail.png`) });
                const downloads = await page.evaluate(() => performance.getEntriesByType('resource').filter(r => r.name.includes('/fonts/personalization-') && r.name.endsWith('.woff2')).map(r => ({ path: new URL(r.name).pathname, bytes: r.encodedBodySize })));
                assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(failed, []);
                results.push({ font: choice.font, width, theme, rendered, mixed, downloads, fontBytes: downloads.reduce((n, r) => n + r.bytes, 0) });
                console.log('PASS reading', choice.font, width, theme);
                await context.close();
            }
            // Real menus, live inheritance, reload persistence and both presets.
            const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
            await context.route('**/*', r => new URL(r.request().url()).origin === new URL(settings).origin ? r.continue() : r.abort());
            const page = await context.newPage(); page.setDefaultTimeout(20000);
            const errors = []; page.on('pageerror', e => errors.push(e.message));
            await page.goto(settings + `?theme=${theme}&lang=zh-Hans&personalization=1&codeFonts=1`);
            await page.getByTestId('lmc-settings-dialog').waitFor(); await settle(page);
            assert.equal(await page.locator('link[href*="/fonts/personalization-v2/"]').count(), 0, 'default users must not load new font assets');
            for (const choice of choices) {
                if (!choice.codeOnly) { await select(page, '界面字体', choice.label); assert.equal((await read(page)).uiFont, choice.font); }
                await select(page, '代码字体', choice.label); assert.equal((await read(page)).codeFont, choice.font);
                await page.reload(); await page.getByTestId('lmc-settings-dialog').waitFor(); await settle(page);
                assert.equal((await read(page)).codeFont, choice.font);
                if (!choice.codeOnly) assert.equal((await read(page)).uiFont, choice.font);
            }
            await select(page, '代码字体', '跟随界面字体'); await select(page, '界面字体', 'MiSans');
            assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--lmc-code-regular')), await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--lmc-font-regular')));
            for (const [label, font, code, reading] of [['杂志阅读', 'newsreader', 'jetbrains', 'editorial'], ['学术阅读', 'sourceSerif', 'sarasa', 'academic']]) {
                await page.getByRole('button', { name: label, exact: true }).click(); await settle(page);
                assert.deepEqual([(await read(page)).uiFont, (await read(page)).codeFont, (await read(page)).readingStyle], [font, code, reading]);
                await page.screenshot({ path: path.join(out, `preset-${reading}-${width}-${theme}.png`) });
                await page.reload(); await page.getByTestId('lmc-settings-dialog').waitFor(); await settle(page);
                assert.equal((await read(page)).uiFont, font); assert.equal((await read(page)).readingStyle, reading);
            }
            await page.getByRole('button', { name: /^界面字体:/ }).click();
            const last = page.getByTestId('settings-select-menu').getByRole('button', { name: /^Source Serif 4(?:\s|$)/ });
            await last.scrollIntoViewIfNeeded(); const bounds = await last.boundingBox();
            assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y >= 0 && bounds.y + bounds.height <= height + 1);
            await page.screenshot({ path: path.join(out, `font-menu-${width}-${theme}.png`) });
            await last.click(); await settle(page);
            assert.deepEqual(errors, []); menus.push({ width, theme, choices: choices.length, presets: 2, persistence: true, lazy: true });
            await context.close(); console.log('PASS settings', width, theme);
        }
        fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ results, menus }, null, 2));
        console.log('PASS', results.length, 'font/viewport/theme cases +', menus.length, 'settings/preset cases');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
