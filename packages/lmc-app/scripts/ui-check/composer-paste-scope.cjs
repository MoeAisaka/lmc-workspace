#!/usr/bin/env node
// A paste belongs to the composer that has the focus. Session screens opened
// earlier stay mounted behind the current one; their composers must not take it.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {webkit, chromium} = require(process.env.LMC_PLAYWRIGHT_MODULE);
const build = path.resolve(process.argv[2]);
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-paste-scope-'));
const checks = [], errors = [];
const check = (label, passed, details) => checks.push({label, passed: !!passed, details});
const child = spawn(process.execPath, [path.join(__dirname, 'session-header.cjs'), build, '--serve', '--two-sessions'], {stdio: ['ignore', 'pipe', 'inherit']});
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
    await page.goto(url); await page.getByRole('button', {name: '隐藏测试控件', exact: true}).click();
    await page.waitForFunction(() => document.querySelectorAll('textarea[data-lmc-text-input]').length === 2, null, {timeout: 15000});
    const state = () => page.evaluate(() => Object.fromEntries(['front-screen', 'background-screen'].map(id => {
        const screen = document.querySelector(`[data-testid="${id}"]`);
        return [id, {composers: screen.querySelectorAll('[data-lmc-composer]').length, images: screen.querySelectorAll('[data-lmc-composer] [data-testid="agent-input-attachment"]').length,
            focused: screen.contains(document.activeElement)}];
    })));
    const deliver = (screenId, kind) => page.evaluate(async ({screenId, kind}) => {
        const canvas = Object.assign(document.createElement('canvas'), {width: 8, height: 8});
        canvas.getContext('2d').fillRect(0, 0, 8, 8);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const data = new DataTransfer(); data.items.add(new File([blob], `${kind}.png`, {type: 'image/png'}));
        const screen = document.querySelector(`[data-testid="${screenId}"]`);
        if (kind === 'paste') {
            const field = screen.querySelector('textarea[data-lmc-text-input]'); field.focus();
            const event = new ClipboardEvent('paste', {bubbles: true, cancelable: true, clipboardData: data});
            // WebKit hands a synthetic event an empty clipboard of its own.
            Object.defineProperty(event, 'clipboardData', {value: data});
            field.dispatchEvent(event);
        } else {
            const target = screen.querySelector('[data-lmc-session-header]') || screen;
            const event = new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: data});
            Object.defineProperty(event, 'dataTransfer', {value: data});
            target.dispatchEvent(event);
        }
    }, {screenId, kind});
    const settle = async () => { await page.waitForTimeout(700); return state(); };
    const initial = await state();
    check('two session screens are mounted, each with its own composer and no attachments', initial['front-screen'].composers === 1 && initial['background-screen'].composers === 1
        && initial['front-screen'].images === 0 && initial['background-screen'].images === 0, initial);
    await deliver('front-screen', 'paste'); const pasted = await settle();
    check('a paste into the front session is attached there once', pasted['front-screen'].images === 1 && pasted['front-screen'].focused, pasted);
    check('the session mounted behind it does not receive the same paste', pasted['background-screen'].images === 0, pasted);
    await deliver('front-screen', 'drop'); const dropped = await settle();
    check('a file dropped on the front session goes to that session only', dropped['front-screen'].images === 2 && dropped['background-screen'].images === 0, dropped);
    // Going back to the other session: it becomes the visible screen and takes the focus.
    await page.evaluate(() => { document.querySelector('[data-testid="background-screen"]').style.visibility = 'visible'; document.querySelector('[data-testid="front-screen"]').style.visibility = 'hidden'; });
    await deliver('background-screen', 'paste'); const other = await settle();
    check('a paste with the focus in the other session goes to that one only', other['background-screen'].images === 1 && other['background-screen'].focused && other['front-screen'].images === 2, other);
    await page.screenshot({path: path.join(out, 'paste-scope.png')});
    await context.close();
})().catch(error => errors.push(String(error))).finally(async () => {
    await browser?.close(); child.kill('SIGTERM');
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({build, engine: process.env.LMC_WEBKIT ? 'webkit' : 'edge', checks, errors}, null, 2));
    const failed = checks.filter(c => !c.passed).map(c => c.label);
    console.log(JSON.stringify({out, checks: checks.length, failed, errors}, null, 2));
    if (failed.length || errors.length) process.exitCode = 1;
});
