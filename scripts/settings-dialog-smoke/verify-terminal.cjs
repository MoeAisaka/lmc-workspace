// Real exported LMC components; synthetic sessions; same-origin localhost only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium, webkit } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.LMC_SETTINGS_FIXTURE_URL || 'http://127.0.0.1:4198/app';
if (!['127.0.0.1','localhost'].includes(new URL(base).hostname)) throw Error('Local fixture required');
const out = fs.mkdtempSync('/tmp/lmc-terminal-qa-');
console.log('Artifacts: ' + out);
(async () => {
 const results = [];
 for (const engine of ['chromium', 'webkit']) {
  const browser = await (engine === 'chromium' ? chromium : webkit).launch({headless:true,
   ...(engine === 'chromium' ? {executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'} : {})});
  try {
   for (const theme of ['light','dark']) {
    const context = await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN',colorScheme:theme});
    await context.route('**/*', r => new URL(r.request().url()).origin === new URL(base).origin ? r.continue() : r.abort());
    const page = await context.newPage(); const errors = []; page.on('pageerror', e=>errors.push(e.message));
    const read = ()=>page.evaluate(()=>moduleExport('storage').storage.getState().localSettings);
    const palette = ()=>page.evaluate(()=>moduleExport('UnistylesRuntime').UnistylesRuntime.getTheme().colors);
    await page.goto(base+'?theme='+theme+'&lang=zh-Hans&personalization=1');
    const dialog=page.getByTestId('lmc-settings-dialog'); await dialog.waitFor();
    const original = await palette();
    await page.evaluate(()=>{window.originalMessages=[...document.querySelectorAll('[data-engine]')];
     moduleExport('storage').storage.getState().applyLocalSettings({zenMode:true});});
    await page.getByRole('button',{name:'终端 TUI',exact:true}).click();
    await page.waitForFunction(()=>document.documentElement.dataset.lmcChrome==='terminal');
    assert.equal((await read()).personalization.uiFont,'sarasa');
    assert.equal((await read()).personalization.codeFont,'sarasa');
    assert.equal((await read()).personalization.motion,'off');
    assert.equal((await read()).zenMode,true,'Unrelated preference preserved');
    assert.ok(await page.evaluate(()=>originalMessages.every(n=>n.isConnected)),'No message remount');
    const terminal = await palette();
    for(const key of ['status','permission','permissionButton','diff']) assert.deepEqual(terminal[key],original[key]);
    const providerFonts = await page.locator('[data-engine]').evaluateAll(nodes=>nodes.map(n=>{
     const leaf=[...n.querySelectorAll('*')].find(x=>x.children.length===0&&x.textContent===n.dataset.engine+' agent sample');
     return {engine:n.dataset.engine,font:getComputedStyle(leaf).fontFamily};
    }));
    assert.deepEqual(providerFonts.map(x=>x.engine),['claude','codex']);
    assert.ok(providerFonts.every(x=>x.font.includes('LMC Sarasa Mono')));
    await page.evaluate(()=>document.fonts.ready);
    const sizes=[];
    for(const [width,height] of [[390,844],[844,390],[1440,900]]) {
     await page.setViewportSize({width,height});
     await page.waitForFunction(()=>{const b=document.querySelector('[data-testid="lmc-settings-dialog"]').getBoundingClientRect();return Math.abs(b.width-Math.min(820,innerWidth-24))<1&&b.top>=0&&b.bottom<=innerHeight;});
     const bounds=await dialog.evaluate(n=>{const b=n.getBoundingClientRect(),s=getComputedStyle(n);return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,radius:s.borderRadius,shadow:s.boxShadow,border:s.borderTopWidth};});
     assert.ok(bounds.left>=0&&bounds.right<=width&&bounds.top>=0&&bounds.bottom<=height,JSON.stringify(bounds));
     assert.equal(bounds.radius,'2px');assert.equal(bounds.shadow,'none');assert.equal(bounds.border,'1px');
     const pane = page.getByTestId('settings-pane');
     const overflow = await pane.evaluate(p=>{const b=p.getBoundingClientRect();return [...p.querySelectorAll('*')].filter(n=>{const r=n.getBoundingClientRect();return getComputedStyle(n).display!=='none'&&r.width>0&&(r.x<b.x-1||r.right>b.right+1)}).map(n=>n.textContent.slice(0,50));});
     assert.deepEqual(overflow,[],'Control overflow at '+width);
     await page.getByRole('button',{name:'终端 TUI',exact:true}).scrollIntoViewIfNeeded();
     await page.screenshot({path:path.join(out,`${engine}-${theme}-${width}.png`)});
     sizes.push({width,height,bounds});
    }
    await page.reload();await dialog.waitFor();
    await page.waitForFunction(()=>document.documentElement.dataset.lmcChrome==='terminal');
    assert.equal((await read()).personalization.chrome,'terminal');
    await page.getByRole('button',{name:'经典',exact:true}).click();
    await page.waitForFunction(()=>document.documentElement.dataset.lmcChrome==='standard');
    assert.deepEqual(await palette(),original,'Classic restores full original palette');
    await page.getByRole('button',{name:'终端 TUI',exact:true}).click();
    await page.getByRole('button',{name:/^恢复外观默认值/}).click();
    assert.equal((await read()).personalization.chrome,'standard');
    assert.equal((await read()).personalization.uiFont,'plex');
    await page.getByRole('textbox',{name:'搜索设置'}).fill('终端');
    await page.getByTestId('settings-pane').getByRole('button',{name:/常规/}).waitFor();
    assert.deepEqual(errors,[]);
    results.push({engine,version:browser.version(),theme,sizes,providerFonts,persistence:true,restore:true,semanticColors:true,errors});
    await context.close();
   }
  } finally {await browser.close();}
 }
 const build=process.env.LMC_TERMINAL_BUILD || '/tmp/lmc-terminal-theme-v273';
 const html=fs.readFileSync(path.join(build,'index.html'),'utf8');
 const artifacts=[...html.matchAll(/<script src="([^"]+)"/g)].map(m=>({file:m[1],sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(build,m[1]))).digest('hex')}));
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({results,artifacts},null,2));
 console.log('PASS: 2 browsers × 2 themes × portrait/landscape/desktop, both providers, persistence, restore, bounds.');
})().catch(e=>{console.error(e);process.exitCode=1;});
