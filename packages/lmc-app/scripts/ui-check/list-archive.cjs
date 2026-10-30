#!/usr/bin/env node
// Explicit archives and disconnected sessions on removed devices are filed
// under archived. Connection age alone never moves a session out of the list.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {webkit, chromium} = require(process.env.LMC_PLAYWRIGHT_MODULE);
const build = path.resolve(process.argv[2]);
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-list-archive-'));
const checks = [], errors = [];
const check = (label, passed, details) => checks.push({label, passed: !!passed, details});
const child = spawn(process.execPath, [path.join(__dirname, 'session-header.cjs'), build, '--serve'], {stdio: ['ignore', 'pipe', 'inherit']});
let browser;
(async () => {
    const url = await new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('Fixture timeout')), 15000);
        child.stdout.on('data', data => { output += data; const match = output.match(/Fixture: (http:\/\/127\.0\.0\.1:\d+)/); if (match) {clearTimeout(timer); resolve(match[1]);} });
        child.once('exit', code => {clearTimeout(timer); reject(new Error(`Fixture exit ${code}`));});
    });
    browser = await (process.env.LMC_WEBKIT ? webkit : chromium).launch({headless: true, ...(!process.env.LMC_WEBKIT ? {executablePath: process.env.LMC_CHROME_PATH} : {})});
    const context = await browser.newContext({viewport: {width: 1280, height: 1000}});
    const tab = await context.newPage();
    tab.on('pageerror', error => errors.push(error.message));
    await tab.goto(url); await tab.getByRole('button', {name: '隐藏测试控件', exact: true}).click();
    await tab.locator('textarea[data-lmc-text-input]').waitFor();
    const min = 60_000, now = Date.now();
    const sessions = [
        {id: 's-live', name: '甲 运行中', machineId: 'up', active: true, activeAt: now},
        {id: 's-gone', name: '乙 进程没了一小时', machineId: 'up', active: false, activeAt: now - 60 * min},
        {id: 's-brief', name: '丙 刚离线两分钟', machineId: 'up', active: false, activeAt: now - 2 * min},
        {id: 's-asleep', name: '丁 机器离线三天', machineId: 'down', active: false, activeAt: now - 3 * 24 * 60 * min},
        {id: 's-orphan', name: '戊 机器已删除', machineId: 'removed', active: false, activeAt: now - 5 * min},
        {id: 's-marked', name: '己 正常归档', machineId: 'up', active: false, activeAt: now - 60 * min, lifecycleState: 'archived'},
    ];
    const machines = [{id: 'up', active: true}, {id: 'down', active: false}];
    await tab.evaluate(f => window.setListFixture(f), {sessions, machines});
    const toggle = tab.getByRole('button', {name: /已归档 \d+ 个会话/});
    await toggle.waitFor();
    const label = await toggle.getAttribute('aria-label');
    const names = sessions.map(s => s.name);
    const visible = async () => { const text = await tab.evaluate(() => document.body.innerText); return names.filter(n => text.includes(n)); };
    const before = await visible();
    check('connection age never archives sessions on paired devices', ['甲 运行中', '乙 进程没了一小时', '丙 刚离线两分钟', '丁 机器离线三天'].every(n => before.includes(n)), before);
    check('explicit archive and removed-device session are hidden', ['戊 机器已删除', '己 正常归档'].every(n => !before.includes(n)), before);
    check('the archive counts the marked and removed-device sessions', /已归档 2 个会话/.test(label || ''), label);
    await toggle.click(); await tab.waitForTimeout(400);
    const after = await visible();
    check('opening it shows them', ['乙 进程没了一小时', '戊 机器已删除', '己 正常归档'].every(n => after.includes(n)), after);
    await tab.screenshot({path: path.join(out, 'archived-open.png')});
    // Reconnection changes presence, not archive membership.
    await tab.evaluate(f => window.setListFixture(f), {sessions: sessions.map(s => s.id === 's-gone' ? {...s, active: true, activeAt: Date.now()} : s), machines});
    await tab.waitForTimeout(300);
    check('reconnection does not change the archive count', /已归档 2 个会话/.test(await tab.getByRole('button', {name: /已归档 \d+ 个会话/}).getAttribute('aria-label') || ''), await tab.getByRole('button', {name: /已归档 \d+ 个会话/}).getAttribute('aria-label'));
    // Before the machines have loaded, nobody is retired for having no machine.
    await tab.evaluate(f => window.setListFixture(f), {sessions, machines: []});
    await tab.waitForTimeout(300);
    check('an unloaded machine list retires nobody but the marked one', /已归档 1 个会话/.test(await tab.getByRole('button', {name: /已归档 \d+ 个会话/}).getAttribute('aria-label') || ''), await tab.getByRole('button', {name: /已归档 \d+ 个会话/}).getAttribute('aria-label'));
    check('No page errors', errors.length === 0, errors);
})().catch(error => check('Run completed', false, String(error.stack || error))).finally(async () => {
    await browser?.close(); child.kill();
    fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify(checks, null, 1));
    for (const c of checks) console.log(`${c.passed ? 'PASS' : 'FAIL'} ${c.label}${c.passed ? '' : ' ' + JSON.stringify(c.details)}`);
    console.log(`Artifacts: ${out}`);
    process.exit(checks.some(c => !c.passed) ? 1 : 0);
});
