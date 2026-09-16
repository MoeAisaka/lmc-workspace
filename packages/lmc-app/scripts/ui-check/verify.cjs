const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
const { buildFixture } = require('./build.cjs');

function loadPlaywright() {
    if (process.env.LMC_PLAYWRIGHT_MODULE) return require(process.env.LMC_PLAYWRIGHT_MODULE);
    for (const name of ['playwright', 'playwright-core']) {
        try { return require(name); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    }
    throw new Error('Install Playwright in a separate tools directory or set LMC_PLAYWRIGHT_MODULE; see scripts/ui-check/README.md.');
}

async function verify() {
    const { chromium } = loadPlaywright();
    const dir = await buildFixture(process.env.LMC_UI_CHECK_DIR);
    const server = http.createServer((req, res) => {
        const js = req.url === '/app.js';
        res.setHeader('Content-Type', js ? 'text/javascript' : 'text/html');
        res.end(fs.readFileSync(path.join(dir, js ? 'app.js' : 'index.html')));
    });
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        browser = await chromium.launch({
            headless: true,
            ...(process.env.LMC_CHROME_PATH ? { executablePath: process.env.LMC_CHROME_PATH } : {}),
        });
        const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
        page.setDefaultTimeout(10_000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.getByRole('button', { name: 'Open P1' }).waitFor();
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
        const open = async (id, sub) => {
            await page.getByRole('button', { name: `Open ${id}`, exact: true }).click();
            await page.getByRole('dialog').waitFor();
            await delay(250); // BaseModal entrance animation.
            if (sub === 'add') await page.getByRole('button', { name: 'Add worker', exact: true }).click();
            if (sub === 'custom') {
                await page.getByRole('button', { name: 'Custom duty', exact: true }).click();
                await page.getByPlaceholder('Duty', { exact: true }).fill('Unsubmitted');
            }
        };
        const order = () => page.locator('[data-group]').evaluateAll(nodes => nodes.map(node => node.dataset.group));
        const drag = async (id, to, hold = true, selector) => {
            const from = await page.locator(selector || `[data-session-sort-id="${id}"]`).boundingBox();
            const dest = await page.locator(`[data-group="${to}"]`).boundingBox();
            await page.mouse.move(from.x + Math.min(30, from.width / 2), from.y + 8);
            await page.mouse.down();
            if (hold) await delay(420); // Exceeds the production 350ms pickup hold.
            await page.mouse.move(dest.x + 100, dest.y + dest.height - 5, { steps: 12 });
            await page.mouse.up();
            await delay(280); // Drop animation and settings write.
        };
        for (const [id, sub] of [['P1', null], ['H1', null], ['W1', null], ['H1', 'add'], ['W1', 'custom']]) {
            for (const method of ['button', 'backdrop', 'escape']) {
                await open(id, sub);
                if (method === 'button') {
                    const close = page.getByRole('button', { name: 'Close', exact: true });
                    const box = await close.boundingBox();
                    assert(box.width >= 44 && box.height >= 44);
                    await close.click();
                } else if (method === 'backdrop') await page.mouse.click(850, 100);
                else await page.keyboard.press('Escape');
                await page.getByRole('dialog').waitFor({ state: 'detached' });
                console.log('PASS close', id, sub || 'role', method);
            }
        }
        await drag('H1', 'H3');
        assert.deepEqual(await order(), ['H2', 'H3', 'H1']);
        assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('orders'))['lmc:hubs']), ['H2', 'H3', 'H1']);
        assert.equal(await page.evaluate(() => window.navigations || 0), 0);
        const savesAfterDrag = await page.evaluate(() => window.saves || 0);
        await page.locator('[data-session-sort-id="H1"]').click({ button: 'right', position: { x: 30, y: 8 } });
        await page.locator('[data-menu-session="H1"]').waitFor();
        assert.equal(await page.locator('[data-menu-session]').count(), 1);
        console.log('PASS hub contextmenu after completed group drag');
        await delay(700); // Let the post-drag click guard expire before clicking the fixture's close button.
        await page.getByRole('button', { name: 'Close session menu', exact: true }).click();
        await page.locator('[data-menu-session]').waitFor({ state: 'detached' });

        await page.locator('[data-worker="H1"]').click({ button: 'right' });
        await page.locator('[data-menu-session="W1"]').waitFor();
        assert.equal(await page.locator('[data-menu-session]').count(), 1);
        assert.deepEqual(await order(), ['H2', 'H3', 'H1']);
        assert.equal(await page.evaluate(() => window.saves || 0), savesAfterDrag);
        assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('orders'))['lmc:hubs']), ['H2', 'H3', 'H1']);
        console.log('PASS worker contextmenu opens only worker menu and preserves group order');
        await page.getByRole('button', { name: 'Close session menu', exact: true }).click();
        await page.reload();
        await page.locator('[data-group]').first().waitFor();
        assert.deepEqual(await order(), ['H2', 'H3', 'H1']);
        console.log('PASS unequal-height whole-group drag, no navigation, persisted lmc:hubs reload order');

        const reset = async () => {
            await page.evaluate(() => localStorage.clear());
            await page.reload();
            await page.locator('[data-group]').first().waitFor();
        };
        await reset();
        await drag('H1', 'H3', true, '[data-worker="H1"]');
        assert.deepEqual(await order(), ['H1', 'H2', 'H3']);
        assert.equal(await page.evaluate(() => window.saves || 0), 0);
        console.log('PASS worker pointer does not arm group');

        await reset();
        const menu = await page.getByRole('button', { name: 'Menu H1', exact: true }).boundingBox();
        await page.mouse.move(menu.x + 4, menu.y + 4);
        await page.mouse.down();
        await delay(420);
        await page.mouse.move(menu.x + 4, menu.y + 400, { steps: 10 });
        await page.mouse.up();
        await delay(250);
        assert.deepEqual(await order(), ['H1', 'H2', 'H3']);
        console.log('PASS nested menu control does not arm group');

        await reset();
        await drag('H1', 'H3', false);
        assert.deepEqual(await order(), ['H1', 'H2', 'H3']);
        console.log('PASS swipe before hold does not reorder');

        await reset();
        const box = await page.locator('[data-session-sort-id="H1"]').boundingBox();
        await page.mouse.move(box.x + Math.min(30, box.width / 2), box.y + 8);
        await page.mouse.down();
        await delay(420);
        await page.mouse.move(box.x + Math.min(30, box.width / 2), box.y + 430, { steps: 10 });
        await page.locator('#outside-sorter').focus();
        await page.keyboard.press('Escape');
        await page.mouse.up();
        await delay(250);
        assert.deepEqual(await order(), ['H1', 'H2', 'H3']);
        assert.equal(await page.evaluate(() => window.saves || 0), 0);
        console.log('PASS Escape cancels drag with focus outside sorter');

        await open('H1', 'add');
        await page.screenshot({ path: path.join(dir, 'after.png') });
        await page.keyboard.press('Escape');
        assert.deepEqual(errors, []);
        console.log(`All browser checks passed. Artifacts: ${dir}`);
    } finally {
        if (browser) await browser.close();
        if (server.listening) await new Promise(resolve => server.close(resolve));
    }
}

verify().catch(error => { console.error(error); process.exitCode = 1; });
