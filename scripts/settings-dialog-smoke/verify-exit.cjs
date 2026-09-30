const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const url = 'http://127.0.0.1:4187/app';
(async () => {
 const browser = await chromium.launch({headless:true, executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const evidence=[];
 try {
  for (const width of [390,1100]) for (const theme of ['light','dark']) {
   const context=await browser.newContext({viewport:{width,height:850}});
   await context.route('**/*',r=>new URL(r.request().url()).origin===new URL(url).origin?r.continue():r.abort());
   const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(url+'?theme='+theme+'&lang=zh-Hans');
   const dialog=page.getByTestId('lmc-settings-dialog');
   for (const method of ['button','escape','backdrop']) {
    await dialog.waitFor();await page.waitForTimeout(260);
    await page.evaluate(()=>{window.exitFrames=[];const start=performance.now();function sample(){const n=document.querySelector('[data-testid="lmc-settings-dialog"]');let opacity=1;for(let p=n;p;p=p.parentElement)opacity*=Number(getComputedStyle(p).opacity);exitFrames.push({ms:performance.now()-start,present:!!n,opacity});if(n&&performance.now()-start<1500)requestAnimationFrame(sample)}requestAnimationFrame(sample)});
    if(method==='button')await page.getByRole('button',{name:'关闭设置'}).click();
    else if(method==='escape')await page.keyboard.press('Escape');
    else await page.mouse.click(3,3);
    await dialog.waitFor({state:'detached'});
    const frames=await page.evaluate(()=>exitFrames);
    assert.ok(frames.some(f=>f.present&&f.opacity>0.05&&f.opacity<0.95),'Missing exit '+method+JSON.stringify(frames));
    evidence.push({width,theme,method,frames});
    if(method!=='backdrop')await page.getByRole('button',{name:'打开设置',exact:true}).click();
   }
   assert.deepEqual(errors,[]);await context.close();
  }
  fs.writeFileSync('/tmp/lmc-settings-exit-v229.json',JSON.stringify(evidence,null,2));
  console.log('PASS settings exit: button, Escape and backdrop; mobile/desktop, light/dark; fade frames precede unmount (12 cases)');
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
