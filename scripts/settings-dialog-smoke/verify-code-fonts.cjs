const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.LMC_PLAYWRIGHT_MODULE||'playwright-core');
const base=process.env.LMC_SETTINGS_FIXTURE_URL||'http://127.0.0.1:4200/app';
const out=fs.mkdtempSync('/tmp/lmc-code-font-qa-');console.log(out);
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});const results=[];try{
for(const width of [390,1100])for(const theme of ['light','dark']){
 const context=await browser.newContext({viewport:{width,height:900}});await context.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():r.abort());
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'?lang=zh-Hans&personalization=1&codeFonts=1&theme='+theme);await page.getByTestId('lmc-settings-dialog').waitFor();
 const select=async(row,label)=>{await page.getByRole('button',{name:new RegExp('^'+row+':')}).click();await page.getByRole('button',{name:new RegExp('^'+label+'(?:$|\\s)')}).last().click();await page.getByTestId('settings-select-menu').waitFor({state:'hidden'});await page.waitForFunction(()=>document.documentElement.dataset.lmcFontStatus!=='loading'&&document.documentElement.dataset.lmcCodeFontStatus!=='loading');await page.evaluate(()=>document.fonts.ready);};
 const cdp=await context.newCDPSession(page);await cdp.send('DOM.enable');await cdp.send('CSS.enable');
 const inspect=()=>page.locator('[data-engine]').evaluateAll(nodes=>nodes.map(n=>{
  const leaf=text=>[...n.querySelectorAll('*')].find(e=>!e.children.length&&e.textContent.trim()===text);
  const css=e=>{if(!e)throw Error('missing fixture element');const s=getComputedStyle(e);return {font:s.fontFamily,weight:s.fontWeight,size:parseFloat(s.fontSize),style:s.fontStyle,synthesis:s.fontSynthesis,color:s.color};};
  return {engine:n.dataset.engine,inline:css(leaf('代码路径/example.ts')),code:css(leaf('sample')),body:css(leaf('正文示例，')),bold:css(leaf('重点文字')),italic:css(leaf('斜体提示')),heading:css(leaf('阅读标题')),subheading:css(leaf('次级标题')),table:css(leaf('项目')),list:css(leaf('第一项'))};
 }));
 for(const [value,label,expected] of [['songti','宋体','LMC Songti'],['magazine','杂志体','LMC Magazine'],['claude','Claude Desktop','LMC Claude Serif']]){
  await select('代码字体',label);let info=await inspect();for(const e of info){assert.ok(e.inline.font.includes(expected));assert.ok(e.code.font.includes(expected));assert.ok(e.body.font.includes('IBMPlexSans'));}
  const glyphs=await page.locator('[data-engine=claude] span').evaluateAll(nodes=>{nodes.find(n=>n.textContent==='代码路径/example.ts').setAttribute('data-code-glyph-probe','true');return true;});
  const doc=await cdp.send('DOM.getDocument');const node=await cdp.send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'[data-code-glyph-probe]'});const rendered=await cdp.send('CSS.getPlatformFontsForNode',{nodeId:node.nodeId});
  if(value!=='claude')assert.ok(rendered.fonts.some(f=>f.isCustomFont&&f.familyName.startsWith(value==='songti'?'Noto Serif SC':'Zhuque Fangsong')),JSON.stringify(rendered));
  await select('界面字体',label);info=await inspect();for(const e of info){assert.ok(e.body.font.includes(expected));assert.ok(Number(e.bold.weight)>=600);assert.ok(Number(e.heading.weight)>=600);assert.ok(e.heading.size>e.subheading.size);assert.ok(e.subheading.size>e.body.size);assert.ok(e.bold.synthesis.includes('weight'));assert.ok(e.italic.synthesis.includes('style'));assert.equal(e.italic.style,'italic');assert.ok(Number(e.table.weight)>=600);assert.ok(e.list.font.includes(expected));}
  await page.getByRole('button',{name:/^代码字体:/}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,`${width}-${theme}-${value}-settings.png`)});
  // Render actual message without the settings overlay for visual review.
  await page.getByRole('button',{name:'关闭设置'}).click();await page.getByTestId('lmc-settings-dialog').waitFor({state:'hidden'});
  if(value==='magazine'){
   for(const text of ['重点文字','斜体提示']){
    const target=page.getByText(text,{exact:true}).first();const emphasized=await target.screenshot();
    await target.evaluate(n=>{n.style.fontSynthesis='none'});const suppressed=await target.screenshot();
    await target.evaluate(n=>{n.style.removeProperty('font-synthesis')});
    assert.ok(!emphasized.equals(suppressed),text+' must visibly change when synthesis is enabled');
   }
  }
  await page.screenshot({path:path.join(out,`${width}-${theme}-${value}-message.png`)});
  await page.reload();await page.getByTestId('lmc-settings-dialog').waitFor();await page.waitForFunction(()=>document.documentElement.dataset.lmcCodeFontStatus!=='loading');
  assert.equal(await page.evaluate(()=>moduleExport('storage').storage.getState().localSettings.personalization.codeFont),value);
  results.push({width,theme,value,info,rendered:rendered.fonts,status:await page.locator('html').getAttribute('data-lmc-code-font-status')});
  await select('界面字体','IBM Plex');
 }
 await select('代码字体','跟随界面字体');await select('界面字体','宋体');for(const e of await inspect())assert.equal(e.inline.font,e.body.font);
 await select('界面字体','杂志体');for(const e of await inspect()){assert.equal(e.inline.font,e.body.font);assert.equal(e.code.font,e.body.font);}
 assert.deepEqual(errors,[]);await context.close();
}
fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));console.log('PASS '+results.length+' cases: independent code fonts, live inheritance, persistence, both engines and rich text hierarchy.');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
