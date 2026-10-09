// Real Metro-export components, synthetic data, localhost-only network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const base = process.env.LMC_SETTINGS_FIXTURE_URL || 'http://127.0.0.1:4187/app';
const out = fs.mkdtempSync('/tmp/lmc-personalization-qa-');
console.log('Artifacts: ' + out);
(async () => {
 const browser = await chromium.launch({headless:true,executablePath:process.env.LMC_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const results=[];
 try {
  for (const theme of ['light','dark']) for (const width of [320,390,1100]) {
   const context=await browser.newContext({viewport:{width,height:850},locale:'zh-CN',colorScheme:theme});
   await context.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort());
   const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
   const read=()=>page.evaluate(()=>moduleExport('storage').storage.getState().localSettings);
   const choose=async(title,choice)=>{
    await page.getByRole('button',{name:new RegExp('^'+title+':')}).click();
    await page.getByRole('button',{name:new RegExp('^'+choice+'(?:$|\\s)')}).last().click();
    await page.getByTestId('settings-select-menu').waitFor({state:'hidden'});
   };
   const metrics=()=>page.evaluate(()=>{
    const pick=selector=>{const n=document.querySelector(selector);return n?{font:getComputedStyle(n).fontFamily,size:getComputedStyle(n).fontSize,line:getComputedStyle(n).lineHeight,animation:getComputedStyle(n).animationName}:null};
    return {motion:document.documentElement.dataset.lmcMotion,preview:pick('[data-lmc-personalization-preview]'),fonts:document.documentElement.style.getPropertyValue('--lmc-font-regular')};
   });
   await page.goto(base+'?theme='+theme+'&lang=zh-Hans&personalization=1');
   const dialog=page.getByTestId('lmc-settings-dialog'),pane=page.getByTestId('settings-pane');await dialog.waitFor();
   await page.getByRole('button',{name:'柔和',exact:true}).click();
   assert.equal((await read()).personalization.accent,'purple');
   await page.getByRole('button',{name:'专注',exact:true}).click();
   await page.waitForFunction(()=>document.documentElement.dataset.lmcMotion==='off');
   assert.equal((await metrics()).preview.animation,'none');
   await page.getByRole('button',{name:'清晰',exact:true}).click();
   await page.waitForFunction(()=>document.documentElement.dataset.lmcMotion==='gentle');
   const engineSizes=await page.locator('[data-engine]').evaluateAll(nodes=>nodes.map(n=>{
    const leaf=[...n.querySelectorAll('*')].find(x=>x.children.length===0&&x.textContent===n.dataset.engine+' agent sample');
    return {engine:n.dataset.engine,size:getComputedStyle(leaf).fontSize,line:getComputedStyle(leaf).lineHeight,font:getComputedStyle(leaf).fontFamily};
   }));
   assert.deepEqual(engineSizes.map(x=>x.size),['18px','18px']);
   assert.ok(engineSizes.every(x=>x.font.includes('apple-system')));
   await choose('界面字体','衬线字体');
   await choose('代码字体','系统字体');
   await choose('会话字号','小');
   await choose('会话行距','紧凑');
   await choose('强调色','绿色');
   await choose('会话密度','紧凑');
   await choose('电脑侧栏宽度','宽');
   await choose('聊天宽度','宽');
   const custom=await read();
   assert.equal(custom.chatWideMode,true);
   assert.deepEqual(custom.personalization,{motion:'gentle',uiFont:'serif',codeFont:'system',textSize:'small',lineHeight:'compact',accent:'green',density:'compact',sidebarWidth:'wide',contentWidth:'reading'});
   await page.reload();await dialog.waitFor();
   assert.deepEqual((await read()).personalization,custom.personalization);
   assert.equal((await read()).chatWideMode,true);
   assert.ok((await metrics()).fonts.includes('Georgia'));
   // Safety colors must remain unchanged when an accent is changed.
   const palette=await page.evaluate(()=>{
    const {UnistylesRuntime}=moduleExport('UnistylesRuntime');
    const t=UnistylesRuntime.getTheme();return {link:t.colors.textLink,deny:t.colors.permissionButton.deny.background,error:t.colors.status.error};
   });
   assert.equal(palette.link,theme==='dark'?'#6DD6A4':'#167047');
   assert.equal(palette.error,theme==='dark'?'#FF453A':'#FF3B30');
   await choose('动效','完整');
   await page.emulateMedia({reducedMotion:'reduce'});
   await page.waitForFunction(()=>document.documentElement.dataset.lmcMotion==='off');
   assert.equal((await read()).personalization.motion,'full');
   assert.equal((await metrics()).preview.animation,'none');
   await page.emulateMedia({reducedMotion:'no-preference'});
   await page.waitForFunction(()=>document.documentElement.dataset.lmcMotion==='full');
   // Check bounds after all menu types have been used; no offscreen control labels.
   const overflow=await pane.evaluate(p=>{const b=p.getBoundingClientRect();return [...p.querySelectorAll('*')].filter(n=>{const s=getComputedStyle(n),r=n.getBoundingClientRect();return s.display!=='none'&&r.width>0&&(r.x<b.x-1||r.right>b.right+1)}).map(n=>n.textContent.slice(0,60));});
   assert.deepEqual(overflow,[],'overflow at '+width);
   await page.getByRole('button',{name:'清晰',exact:true}).scrollIntoViewIfNeeded();
   await page.screenshot({path:path.join(out,`${theme}-${width}.png`)});
   await page.getByRole('button',{name:/^恢复外观默认值/}).click();
   const reset=await read();assert.equal(reset.themePreference,'adaptive');assert.equal(reset.chatWideMode,false);assert.equal(reset.zenMode,false);assert.equal(reset.personalization.uiFont,'plex');assert.equal(reset.personalization.accent,'blue');
   await page.reload();await dialog.waitFor();assert.deepEqual((await read()).personalization,reset.personalization);
   await page.getByRole('textbox',{name:'搜索设置'}).fill('字体');
   await pane.getByRole('button',{name:/常规/}).waitFor();
   assert.deepEqual(errors,[]);
   results.push({theme,width,presets:true,allControls:true,persistence:true,bothEngines:engineSizes,reducedMotion:true,reset:true,overflow,errors});
   await context.close();
  }
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));
  console.log('PASS '+results.length+' viewport/theme cases: all controls, real Claude/Codex MessageView, persistence, reduced motion, reset, bounds.');
 } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
