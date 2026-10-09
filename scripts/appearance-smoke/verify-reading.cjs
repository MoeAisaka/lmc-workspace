// Actual production MessageView + EnvelopeCard; no business sessions or network.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const base = process.env.LMC_STYLE_URL || 'http://127.0.0.1:4201/app';
const out = fs.mkdtempSync('/tmp/lmc-reading-qa-');
console.log('Artifacts: ' + out);
(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const results = [];
    try {
        for (const width of [320, 390, 1100]) for (const theme of ['light', 'dark']) {
            const context = await browser.newContext({ viewport: { width, height: 900 } });
            await context.route('**/*', r => new URL(r.request().url()).origin === new URL(base).origin ? r.continue() : r.abort());
            const page = await context.newPage(); page.setDefaultTimeout(12000); const errors = [];
            page.on('pageerror', e => { errors.push(e.message); console.error(e.stack); });
            await page.goto(base + '?screen=reading&font=magazine&theme=' + theme);
            await page.locator('[data-reading-reply=claude]').waitFor();
            await page.waitForFunction(() => document.documentElement.dataset.lmcFontStatus === 'ready');
            await page.evaluate(() => document.fonts.ready);
            await page.evaluate(() => { window.mountedHeading = document.querySelector('[data-reading-reply=claude] [data-lmc-heading="1"]'); });
            for (const readingStyle of ['standard', 'editorial', 'academic']) {
                await page.evaluate(readingStyle => { const state = moduleExport('storage').storage.getState(); state.applyLocalSettings({ personalization: { ...state.localSettings.personalization, readingStyle } }); }, readingStyle);
                await page.waitForFunction(style => document.documentElement.dataset.lmcReadingStyle === style, readingStyle);
                assert.ok(await page.evaluate(() => mountedHeading === document.querySelector('[data-reading-reply=claude] [data-lmc-heading="1"]')), 'live layout must update already-mounted text');
                const metrics = await page.locator('[data-reading-reply]').evaluateAll(nodes => nodes.map(n => {
                    const css = e => { const s = getComputedStyle(e); return { size: parseFloat(s.fontSize), line: parseFloat(s.lineHeight), font: s.fontFamily, weight: s.fontWeight, style: s.fontStyle }; };
                    const leaf = text => [...n.querySelectorAll('*')].find(e => !e.children.length && e.textContent === text);
                    const heading = n.querySelector('[data-lmc-heading="1"]');
                    return { engine: n.dataset.readingReply, h1: css(heading), h1Text: css(heading.querySelector('span')), h2: css(n.querySelector('[data-lmc-heading="2"]')), paragraph: css(n.querySelector('[data-lmc-block="paragraph"]')), list: css(n.querySelector('[data-lmc-list-text="body"]')), bold: css(leaf('重要的信息')), italic: css(leaf('解释与提醒')), code: css(leaf('src/reading.ts')), quote: n.querySelector('[data-lmc-block="quote"]').innerText };
                }));
                for (const m of metrics) {
                    assert.equal(m.h1.size, { standard: 24, editorial: 30, academic: 25 }[readingStyle]);
                    assert.equal(m.h1Text.size, m.h1.size, 'nested heading spans inherit live metrics');
                    assert.equal(m.paragraph.line, readingStyle === 'standard' ? 25 : 28);
                    assert.equal(m.list.line, m.paragraph.line);
                    assert.ok(m.h1.size > m.h2.size && m.h2.size > m.paragraph.size);
                    assert.ok(m.paragraph.font.includes('LMC Magazine') && m.code.font.includes('IBMPlexMono'));
                    assert.ok(Number(m.bold.weight) >= 600 && m.italic.style === 'italic');
                    assert.ok(m.quote.includes('先看结论') && !m.quote.includes('>'));
                }
                for (const engine of ['claude', 'codex']) {
                    const section = page.locator('[data-engine=' + engine + ']');
                    assert.equal(await section.locator('[data-lmc-mail=message] [data-lmc-list-text=body]').count(), 2);
                    assert.ok((await section.locator('[data-lmc-mail=message]').innerText()).includes('重点文字'));
                    const mailSizes = await section.locator('[data-lmc-mail] [data-lmc-block=paragraph], [data-lmc-mail] [data-lmc-list-text]').evaluateAll(nodes => nodes.map(n => parseFloat(getComputedStyle(n).fontSize)));
                    assert.ok(mailSizes.length > 0 && mailSizes.every(size => size === 14), 'mail prose stays one size below the 16px reply across reading presets');
                    const mailHeading = await section.locator('[data-lmc-mail=message] [data-lmc-heading="2"]').evaluate(n => parseFloat(getComputedStyle(n).fontSize));
                    assert.equal(mailHeading, metrics.find(m => m.engine === engine).h2.size * 0.875, 'mail keeps a quieter heading hierarchy');
                    assert.equal(await section.locator('[data-reading-user] [data-lmc-heading="1"]').evaluate(n => parseFloat(getComputedStyle(n).fontSize)), 24, 'user bubble keeps plain layout');
                    const longField = section.locator('[data-lmc-mail=task] [data-lmc-mail-section=constraints]');
                    const bounds = await longField.evaluate(n => { const label = n.firstElementChild.getBoundingClientRect(), body = n.lastElementChild.getBoundingClientRect(), field = n.getBoundingClientRect(); return { labelBottom: label.bottom, bodyTop: body.top, fieldWidth: field.width, bodyWidth: body.width, overflow: n.scrollWidth - n.clientWidth }; });
                    const columnLimit = width >= 900 ? ({ editorial: 760, academic: 700 }[readingStyle] || Infinity) : Infinity;
                    assert.ok(bounds.bodyTop >= bounds.labelBottom + 7 && Math.abs(bounds.bodyWidth - Math.min(bounds.fieldWidth, columnLimit)) <= 1, 'long fields stack above a full phone width / bounded desktop reading column: ' + JSON.stringify(bounds));
                    assert.ok(bounds.overflow <= 1, 'long path must not overflow');
                    assert.equal(await longField.locator('[data-lmc-list-text=body]').count(), 3);
                    assert.ok((await longField.innerText()).includes('完整内容可选择复制'));
                    const toggle = section.getByRole('button', { name: '展开证据', exact: true });
                    if (await toggle.count()) await toggle.click();
                    const evidence = section.getByText(/^pnpm test\s+const reading = "clear";$/);
                    assert.ok((await evidence.evaluate(n => getComputedStyle(n).fontFamily)).includes('IBMPlexMono'));
                    assert.ok((await section.getByRole('button', { name: '收起证据', exact: true }).boundingBox()).height >= 44);
                }
                assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
                await page.locator('#reading-fixture').evaluate(n => n.scrollTop = 0);
                await page.screenshot({ path: path.join(out, `${readingStyle}-${theme}-${width}-reply.png`) });
                await page.locator('[data-engine=claude] [data-lmc-mail=task]').screenshot({ path: path.join(out, `${readingStyle}-${theme}-${width}-mail.png`) });
                assert.deepEqual(errors, []);
                results.push({ width, theme, readingStyle, metrics }); console.log('PASS', width, theme, readingStyle);
            }
            // Large, relaxed text also reaches nested list text without a remount.
            await page.evaluate(() => { const s = moduleExport('storage').storage.getState(); s.applyLocalSettings({ personalization: { ...s.localSettings.personalization, textSize: 'large', lineHeight: 'relaxed' } }); });
            await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-lmc-mail=task] [data-lmc-list-text=body]')).fontSize === '15.75px');
            assert.equal(await page.locator('[data-reading-reply=claude] [data-lmc-list-text=body]').first().evaluate(n => parseFloat(getComputedStyle(n).fontSize)), 18, 'larger mail does not change the normal reply size');
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            // Use the real settings menu, then reload with no URL reading override.
            await page.goto(base + '?screen=general&font=magazine&theme=' + theme);
            await page.getByRole('button', { name: /^正文排版:/ }).click();
            await page.getByTestId('settings-select-menu').getByRole('button', { name: /^杂志(?:\s|$)/ }).click();
            await page.getByTestId('settings-select-menu').waitFor({ state: 'hidden' });
            await page.waitForFunction(() => document.documentElement.dataset.lmcReadingStyle === 'editorial');
            const preview = page.locator('[data-lmc-personalization-preview] [data-lmc-heading="1"]');
            assert.equal(await preview.evaluate(n => parseFloat(getComputedStyle(n).fontSize)), 33.75);
            await page.reload();
            await page.waitForFunction(() => document.documentElement.dataset.lmcReadingStyle === 'editorial');
            assert.deepEqual(await page.evaluate(() => { const p = moduleExport('storage').storage.getState().localSettings.personalization; return [p.uiFont, p.codeFont, p.readingStyle, p.textSize, p.lineHeight]; }), ['magazine', 'plex', 'editorial', 'large', 'relaxed']);
            assert.deepEqual(errors, []);
            await context.close();
        }
        fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
        console.log('PASS', results.length, 'reading layouts + both engines, mail sections, live updates, settings selection and persistence');
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
