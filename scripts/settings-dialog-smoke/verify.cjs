// Run serve.cjs against the candidate export first. All traffic stays on localhost.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.env.LMC_PLAYWRIGHT_MODULE||'playwright-core');
const url=process.env.LMC_SETTINGS_FIXTURE_URL||'http://127.0.0.1:4187/app';
const out=fs.mkdtempSync('/tmp/lmc-settings-qa-');
console.log('Artifacts: '+out);
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.LMC_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const evidence=[];
 try{
  for(const theme of ['light','dark'])for(const size of [{width:390,height:675},{width:320,height:568},{width:430,height:850},{width:667,height:390},{width:1100,height:800}]){
   const context=await browser.newContext({viewport:size,locale:'zh-CN'});
   await context.route('**/*',route=>new URL(route.request().url()).origin===new URL(url).origin?route.continue():route.abort());
   const page=await context.newPage();page.setDefaultTimeout(6000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(url+'?theme='+theme+'&lang=zh-Hans');
   const dialog=page.getByTestId('lmc-settings-dialog'),pane=page.getByTestId('settings-pane');
   await dialog.waitFor();await page.waitForTimeout(240);
   const bounds=await dialog.boundingBox();assert.ok(bounds.x>=11&&bounds.y>=0&&bounds.x+bounds.width<=size.width-11&&bounds.y+bounds.height<=size.height,JSON.stringify(bounds));
   assert.ok((await page.getByRole('button',{name:'关闭设置'}).boundingBox()).height>=44);
   const checkPane=async()=>{
    const overflow=await pane.evaluate(p=>{const box=p.getBoundingClientRect();return [...p.querySelectorAll('*')].filter(n=>{const s=getComputedStyle(n),b=n.getBoundingClientRect();return s.display!=='none'&&b.width>0&&(b.x<box.x-1||b.right>box.right+1)}).map(n=>n.textContent.slice(0,90))});
    assert.deepEqual(overflow,[],'content overflow at '+size.width);
   };
   await checkPane();
   await page.screenshot({path:path.join(out,`${theme}-${size.width}.png`)});
   const search=page.getByRole('textbox',{name:'搜索设置'});
   await search.fill('气泡');await pane.getByRole('button',{name:/常规/}).click();await pane.getByRole('heading',{name:'常规',exact:true}).waitFor();assert.equal(await search.inputValue(),'');
   await search.fill('definitely-no-match');await pane.getByText('没有匹配的会话',{exact:true}).count().then(async count=>{if(!count)assert.match(await pane.innerText(),/无匹配|没有匹配|No matches/)});
   await search.fill('模型');await pane.getByRole('button',{name:/Agent 默认参数/}).click();
   await pane.getByRole('heading',{name:'Agent 默认参数'}).waitFor();
   await checkPane();
   assert.ok((await pane.innerText()).includes('Claude Code')&&(await pane.innerText()).includes('Codex'),'both engine defaults present');
   await page.screenshot({path:path.join(out,`${theme}-${size.width}-agents.png`)});
   await page.getByTestId('settings-tab-devices').click();await pane.getByText('还没有设备',{exact:true}).waitFor();await checkPane();
   await page.getByTestId('settings-tab-account').click();await pane.getByText('Demo',{exact:true}).first().waitFor();await checkPane();
   await page.getByTestId('settings-tab-about').click();await pane.getByText('网页版本',{exact:true}).waitFor();await checkPane();
   await page.getByTestId('settings-tab-general').click();
   // Changing an existing control must reach the same account settings store.
   const before=await page.evaluate(()=>moduleExport('storage').storage.getState().settings.usageLimitShowRemaining);
   await pane.getByRole('switch').first().click();
   const after=await page.evaluate(()=>moduleExport('storage').storage.getState().settings.usageLimitShowRemaining);assert.equal(after,!before);
   // The appearance menu uses the actual anchored SettingsSelect layer.
   await pane.getByRole('button',{name:'自适应',exact:true}).click();
   await pane.getByRole('button',{name:/^深色/}).click();await page.waitForTimeout(200);
   assert.equal(await dialog.evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(33, 33, 33)');
   await page.getByRole('button',{name:'关闭设置'}).click();await dialog.waitFor({state:'hidden'});
   // Phone account menu now opens the same floating dialog without routing away.
   await page.getByRole('button',{name:'账户菜单',exact:true}).click();
   await page.getByTestId('account-quota-cards').waitFor();
   await page.locator('[role="button"]').filter({has:page.getByText('设置',{exact:true})}).click();
   await dialog.waitFor();assert.equal(page.url(),url+'?theme='+theme+'&lang=zh-Hans');
   await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
   assert.deepEqual(errors,[]);
   evidence.push({theme,...size,modal:bounds,search:true,bothEngines:true,allCategories:true,settingMutation:true,themeMutation:true,accountEntry:true,closeAndEscape:true,errors});
   await context.close();
  }
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(evidence,null,2));
  console.log('PASS '+evidence.length+' viewport/theme cases: bounds, search, categories, Codex/Claude defaults, setting/theme changes, account entry, close/Escape, no page errors.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
