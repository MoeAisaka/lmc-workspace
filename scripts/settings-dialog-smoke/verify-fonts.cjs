const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const{chromium}=require(process.env.LMC_PLAYWRIGHT_MODULE||'playwright-core');
const base=process.env.LMC_SETTINGS_FIXTURE_URL||'http://127.0.0.1:4187/app';
const out=fs.mkdtempSync('/tmp/lmc-font-qa-');console.log('Artifacts: '+out);
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});const evidence=[];try{
 for(const width of [390,1100])for(const theme of ['light','dark']){
  const ctx=await browser.newContext({viewport:{width,height:850}});
  await ctx.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():r.abort());
  const page=await ctx.newPage();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'?lang=zh-Hans&theme='+theme+'&personalization=1');await page.getByTestId('lmc-settings-dialog').waitFor();
  assert.equal(await page.locator('link[href*="/fonts/personalization-v1/"]').count(),0,'fonts should not load before selection');
  const cdp=await ctx.newCDPSession(page);await cdp.send('DOM.enable');await cdp.send('CSS.enable');
  for(const [value,label,fontName] of [['songti','宋体','Noto Serif SC'],['magazine','杂志体','Zhuque Fangsong'],['claude','Claude Desktop',null]]){
   await page.getByRole('button',{name:/^界面字体:/}).click();
   await page.getByRole('button',{name:new RegExp('^'+label+'(?:$|\\s)')}).last().click();
   await page.getByTestId('settings-select-menu').waitFor({state:'hidden'});
   await page.waitForFunction(()=>document.documentElement.dataset.lmcFontStatus!=='loading');
   await page.evaluate(()=>document.fonts.ready);
   assert.equal(await page.evaluate(()=>moduleExport('storage').storage.getState().localSettings.personalization.uiFont),value);
   const doc=await cdp.send('DOM.getDocument');const node=await cdp.send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'[data-lmc-personalization-preview] span'});
   const rendered=await cdp.send('CSS.getPlatformFontsForNode',{nodeId:node.nodeId});
   const status=await page.locator('html').getAttribute('data-lmc-font-status');
   if(fontName){assert.equal(status,'ready');assert.ok(rendered.fonts.some(f=>f.familyName.startsWith(fontName)&&f.isCustomFont),JSON.stringify(rendered));}
   else{
    assert.ok(['original','fallback'].includes(status));
    if(status==='fallback')await page.getByText('未检测到本机 Anthropic Serif，当前为近似风格：Georgia＋宋体。',{exact:true}).waitFor();
   }
   const engineFonts=await page.locator('[data-engine]').evaluateAll(nodes=>nodes.map(n=>{const text=[...n.querySelectorAll('*')].find(e=>!e.children.length&&e.textContent===n.dataset.engine+' agent sample');return getComputedStyle(text).fontFamily}));
   assert.ok(engineFonts.every(f=>f.includes(value==='songti'?'LMC Songti':value==='magazine'?'LMC Magazine':'LMC Claude Serif')));
   await page.getByRole('button',{name:/^界面字体:/}).scrollIntoViewIfNeeded();
   await page.screenshot({path:path.join(out,`${theme}-${width}-${value}.png`)});
   await page.reload();await page.getByTestId('lmc-settings-dialog').waitFor();
   await page.waitForFunction(()=>document.documentElement.dataset.lmcFontStatus!=='loading');
   assert.equal(await page.evaluate(()=>moduleExport('storage').storage.getState().localSettings.personalization.uiFont),value);
   evidence.push({width,theme,font:value,status,rendered:rendered.fonts,engineFonts,persistence:true});
  }
  const pane=page.getByTestId('settings-pane');const overflow=await pane.evaluate(p=>{const b=p.getBoundingClientRect();return [...p.querySelectorAll('*')].filter(n=>{const r=n.getBoundingClientRect();return r.width>0&&(r.x<b.x-1||r.right>b.right+1)}).map(n=>n.textContent.slice(0,60))});
  assert.deepEqual(overflow,[]);assert.deepEqual(errors,[]);await ctx.close();
 }
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(evidence,null,2));console.log('PASS '+evidence.length+' font/viewport/theme cases: real rendered font glyphs, both engines, persistence, fallback, local-only loading.');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
