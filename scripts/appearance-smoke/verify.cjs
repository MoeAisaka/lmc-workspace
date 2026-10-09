const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const{chromium}=require(process.env.LMC_PLAYWRIGHT_MODULE||'playwright-core');
const base=process.env.LMC_STYLE_URL||'http://127.0.0.1:4201/app';
const font=process.env.LMC_STYLE_FONT||'songti',code=process.env.LMC_STYLE_CODE||'plex',engine=process.env.LMC_STYLE_ENGINE||'codex';
const fontMarker={songti:'LMC Songti',magazine:'LMC Magazine',claude:'LMC Claude Serif'}[font];
const codeMarker=code==='inherit'?fontMarker:'IBMPlexMono';
const out=fs.mkdtempSync('/tmp/lmc-style-qa-');console.log('Artifacts: '+out);
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});const results=[];try{
 for(const width of [320,390,1100])for(const theme of ['light','dark']){
  const ctx=await browser.newContext({viewport:{width,height:850}});await ctx.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():r.abort());
  const page=await ctx.newPage();page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack)});
  for(const screen of (process.env.LMC_STYLE_SCREENS?.split(',')||['session','machine','general','account','devices','agents','files','about','changelog','cards','alert','prompt'])){
   await page.goto(base+'?screen='+screen+'&font='+font+'&code='+code+'&engine='+engine+'&theme='+theme);
   await page.locator('#surface').waitFor();await page.waitForFunction(()=>['ready','fallback','original'].includes(document.documentElement.dataset.lmcFontStatus));await page.evaluate(()=>document.fonts.ready);
   assert.deepEqual(errors,[],screen);
   assert.ok((await page.locator('body').innerText()).length>15,screen+' must render content');
   assert.ok(!(await page.locator('body').innerText()).includes('lmc.orchestration.state.'),'fixture must use valid production envelope statuses');
   if(screen==='session'||screen==='machine'){const summary=page.getByTestId('detail-summary');await summary.waitFor();assert.ok((await summary.boundingBox()).height<140);}
   const defaultFonts=await page.locator('#surface').evaluate((n,{fontMarker,codeMarker})=>[...n.querySelectorAll('*')].filter(e=>!e.children.length&&/[\u4e00-\u9fff]/.test(e.textContent)&&getComputedStyle(e).display!=='none').map(e=>({text:e.textContent.slice(0,30),family:getComputedStyle(e).fontFamily})).filter(x=>!x.family.includes(fontMarker)&&!x.family.includes(codeMarker)&&!/ionicons|octicons|FontAwesome/.test(x.family)),{fontMarker,codeMarker});
   assert.deepEqual(defaultFonts,[],screen+' contains unthemed Chinese text');
   if(screen==='cards'){
    for(const engine of ['claude','codex']){
     const section=page.locator('[data-engine='+engine+']');const report=section.getByText('已完成页面整理，保留清晰的阅读层次。',{exact:true});assert.ok((await report.evaluate(n=>getComputedStyle(n).fontFamily)).includes(fontMarker));
     await section.getByRole('button',{name:'展开证据'}).click();await section.getByText('pnpm test — 检查完成',{exact:true}).waitFor();
     assert.ok((await section.getByText('pnpm test — 检查完成',{exact:true}).evaluate(n=>getComputedStyle(n).fontFamily)).includes(codeMarker));
    }
    assert.ok((await page.getByTestId('nested-code-child').evaluate(n=>getComputedStyle(n).fontFamily)).includes(codeMarker),'nested code must inherit code face');
   }
   if(screen==='alert'||screen==='prompt'){
    const action=page.getByRole('button',{name:screen==='alert'?'取消':'保存',exact:true});const box=await action.boundingBox();assert.ok(box.height>=44&&box.x>=0&&box.x+box.width<=width,'dialog action must fit and remain touchable: '+JSON.stringify(box));
   }
   if(screen==='prompt'){
    const input=page.getByRole('textbox');await input.fill('新的会话名称');await page.getByRole('button',{name:'保存',exact:true}).click();assert.ok(await page.evaluate(()=>fixtureActions.includes('新的会话名称')));
   }
   if(screen==='alert'){await page.getByRole('button',{name:'取消',exact:true}).click();assert.ok(await page.evaluate(()=>fixtureActions.includes(false)));}
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),screen+' page overflow');
   await page.screenshot({path:path.join(out,`${screen}-${theme}-${width}.png`)});
   results.push({screen,width,theme,uiFont:font,codeFont:code,engine,pageErrors:[...errors]});console.log('PASS '+screen+' '+theme+' '+width);
  }
  await ctx.close();
 }
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));console.log('PASS '+results.length+' screen/theme/viewport cases');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
