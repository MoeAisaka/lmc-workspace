// Exercise the actual exported Metro modules, styles and icons with synthetic
// messages. No app bootstrap, authentication, browser profile or production API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(process.argv[2] || '/tmp/lmc-d26-web');
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-account-quota-check-'));
console.log('Artifacts: '+out);
const originalHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = [...originalHtml.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
const main = scripts.at(-1);
const capture = `window.modules = new Map(); const define = window.__d;
window.__d = (factory,id,deps) => { window.modules.set(id,{factory,deps}); define(factory,id,deps); };
window.moduleExport = name => {
 const re = new RegExp('\\\\.'+name+'\\\\s*=(?!=)');
 for (const [id,m] of window.modules) if (re.test(m.factory.toString()) || m.factory.toString().includes(JSON.stringify(name))) { const e=window.__r(id); if(e[name]) return e; }
 throw new Error('Module export not found: '+name);
};`;
const fixture = `
const init=modules.get(0); __r(init.deps[0]);__r(init.deps[1]);
const React=moduleExport('useState'),h=React.createElement,{createRoot}=moduleExport('createRoot');
const {AccountMenuLayer,useAccountMenu}=moduleExport('AccountMenuLayer'),{AuthProvider}=moduleExport('AuthProvider');
const {FloatingSessionDrawer}=moduleExport('FloatingSessionDrawer');
const {useSessionDrawer}=moduleExport('useSessionDrawer');
const {GestureHandlerRootView}=moduleExport('GestureHandlerRootView');
useSessionDrawer.getState().setOpen(true);
window.isSessionDrawerOpen=()=>useSessionDrawer.getState().open;
const {SidebarView}=moduleExport('SidebarView');
window.closeQuotaMenu=()=>useAccountMenu.getState().close();
const {storage}=moduleExport('storage'),{apiSocket}=moduleExport('apiSocket');
const {UnistylesRuntime}=moduleExport('UnistylesRuntime');
const {SafeAreaProvider}=moduleExport('SafeAreaProvider');
window.calls=0;window.replyMode='success';
const now=Date.now();
const w=(id,left)=>({id,remaining:left,resetsAt:now+4*86400000,durationMins:id==='five_hour'?300:10080,pending:false});
const snapshot={providers:[
 {engine:'codex',plan:'pro',capturedAt:now-120000,refreshFailed:false,stale:false,windows:[w('five_hour',null),w('seven_day',72)],resetCredits:{count:1,expiresAt:now+86400000}},
 {engine:'claude',plan:'max',capturedAt:now-300000,refreshFailed:false,stale:false,windows:[w('five_hour',98),w('seven_day',21),w('fable_week',60)],resetCredits:null}]};
apiSocket.machineRPC=async(id,method)=>{if(id!=='quota-fixture'||method!=='account-quota')throw Error('Unexpected RPC');window.calls++;if(replyMode==='failed')throw Error('synthetic');const result=structuredClone(snapshot);const fable=result.providers[1].windows[2];if(replyMode==='zero')fable.remaining=0;if(replyMode==='unmatched')fable.resetsAt+=86400000;if(replyMode==='pending')fable.pending=true;return {snapshot:replyMode==='missing'?{providers:[]}:result};};
storage.setState({isDataReady:true,profile:{id:'demo',firstName:'LMC',lastName:'Demo'},machines:{'quota-fixture':{id:'quota-fixture',active:true,createdAt:1,metadata:{host:'Demo',accountQuota:true,happyCliVersion:'1.2.53'}}}});
window.setTheme=theme=>{UnistylesRuntime.setAdaptiveThemes(false);UnistylesRuntime.setTheme(theme);document.body.style.background=theme==='dark'?'#141414':'#efeff2'};
function App(){const [size,setSize]=React.useState({w:innerWidth,h:innerHeight});React.useEffect(()=>{const f=()=>setSize({w:innerWidth,h:innerHeight});addEventListener('resize',f);return()=>removeEventListener('resize',f)},[]);
return h(SafeAreaProvider,{initialMetrics:{frame:{x:0,y:0,width:size.w,height:size.h},insets:{top:0,bottom:0,left:0,right:0}}},h(AuthProvider,{initialCredentials:null},h('div',{style:{width:size.w,height:size.h}},size.w>=768?h('div',{style:{display:'flex',height:size.h,width:360}},h(SidebarView,{})):h(GestureHandlerRootView,{style:{flex:1}},h(FloatingSessionDrawer,{})),h(AccountMenuLayer,{}))));}
createRoot(document.getElementById('root')).render(h(App));
`;
const fonts=fs.readdirSync(path.join(root,'assets/sources/assets/fonts')).filter(f=>f.startsWith('IBMPlexSans-')).map(f=>`@font-face{font-family:'${f.split('.')[0]}';src:url('/assets/sources/assets/fonts/${f}')}`).join('');
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fonts}body{margin:0;font-family:IBMPlexSans-Regular,Arial,sans-serif}</style><div id="root"></div>${scripts.map((s,i)=>`<script src="${s}"></script>${i===0?'<script src="/capture.js"></script>':''}`).join('')}<script src="/fixture.js"></script>`;
const server=http.createServer((req,res)=>{
 let content, type='text/javascript';
 if(req.url==='/'){content=html;type='text/html';}
 else if(req.url==='/capture.js')content=capture;
 else if(req.url==='/fixture.js')content=fixture;
 else {
  const pathname=decodeURIComponent(req.url.split('?')[0]);
  const file=path.resolve(root,'.'+pathname);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  content=fs.readFileSync(file);
  if(pathname===main)content=content.toString().replace(/__r\(0\);\s*$/,'');
  if(pathname.endsWith('.ttf'))type='font/ttf';
  if(pathname.endsWith('.png'))type='image/png';
  if(pathname.endsWith('.css'))type='text/css';
 }
 res.setHeader('Content-Type',type);res.end(content);
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,executablePath:process.env.LMC_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try{
  const language=process.env.LMC_UI_LANGUAGE || 'en';
  const context=await browser.newContext({viewport:{width:390,height:740},locale:language==='zh-Hans'?'zh-CN':'en-US'});
  await context.addInitScript(language=>localStorage.setItem(['mmkv.default','settings'].join(String.fromCharCode(92)),JSON.stringify({settings:{preferredLanguage:language},version:1})),language);
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});
  await page.goto('http://127.0.0.1:'+server.address().port);
  const labels=await page.evaluate(()=>{const {t}=moduleExport('getCurrentLanguage');return {
   account:t('lmc.list.accountAndSettings'),signOut:t('lmc.menu.signOut'),usage:t('localFeatures.quotaTitle'),refresh:t('localFeatures.quotaRefresh'),
   gap:t('localFeatures.quotaFableGap',{points:'9'}),pending:t('localFeatures.quotaFableSyncPending'),retry:t('localFeatures.quotaRetryHint')
  }});
  await page.getByRole('button',{name:labels.account,exact:true}).click();
  await page.getByText('72%',{exact:true}).waitFor();
  assert.equal(await page.getByTestId('quota-fable-legend').count(),1);
  assert.equal(await page.getByRole('progressbar').count(),4,'Fable shares the weekly bar, without a separate progress bar');
  assert.equal(await page.evaluate(()=>isSessionDrawerOpen()),true,'opening quota bubble must preserve its parent entry');
  assert.equal(await page.getByText(labels.gap,{exact:false}).count(),1);
  for(const theme of ['light','dark']){
   await page.evaluate(theme=>setTheme(theme),theme);
   for(const width of [320,390,1000]){
    await page.setViewportSize({width,height:width===1000?1100:740});
    await page.evaluate(()=>closeQuotaMenu());
    await page.waitForTimeout(180);
    await page.getByRole('button',{name:labels.account,exact:true}).click();
    await page.getByText('72%',{exact:true}).waitFor();
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const card=await page.getByTestId('account-quota-cards').boundingBox();assert.ok(card.x>=0 && card.x+card.width<=width);
    await page.getByText(labels.signOut,{exact:true}).scrollIntoViewIfNeeded();
    await page.getByText(labels.usage,{exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(out,theme+'-'+width+'.png')});
    const originalEntry=await page.getByRole('button',{name:labels.account,exact:true}).boundingBox();
    const menuBottom=await page.getByTestId('account-quota-cards').evaluate(n=>{while(n && !(getComputedStyle(n).position==='absolute' && parseFloat(getComputedStyle(n).borderRadius)>0))n=n.parentElement;return n.getBoundingClientRect().bottom;});
    assert.ok(menuBottom<=originalEntry.y-7,'bubble must remain above the original entry');
    {
     const geometry=await page.evaluate(account=>{
      let menu=document.querySelector('[data-testid=account-quota-cards]');
      while(menu && !(getComputedStyle(menu).position==='absolute' && parseFloat(getComputedStyle(menu).borderRadius)>0))menu=menu.parentElement;
      let card=document.querySelector('[aria-label='+JSON.stringify(account)+']');
      const desktop=innerWidth>=768;
      while(card && !(getComputedStyle(card).borderRadius===(desktop?'16px':'24px') && getComputedStyle(card).borderTopWidth==='1px'))card=card.parentElement;
      const box=n=>({x:n.getBoundingClientRect().x,width:n.getBoundingClientRect().width,top:n.getBoundingClientRect().top,bottom:n.getBoundingClientRect().bottom,radius:getComputedStyle(n).borderRadius});
      return {menu:box(menu),card:box(card)};
     },labels.account);
     console.log('Surface geometry '+JSON.stringify(geometry));
     assert.ok(Math.abs(geometry.menu.x-geometry.card.x)<0.6,'menu left must align to card outer border');
     assert.ok(Math.abs(geometry.menu.width-geometry.card.width)<0.6,'menu width must match card outer border');
     assert.equal(geometry.menu.radius,geometry.card.radius);
     if(width>=768)assert.ok(geometry.menu.bottom<=geometry.card.top-7,'menu must leave the account card unobscured');
    }
   }
  }
  for(const mode of ['zero','unmatched','pending']){
   await page.evaluate(mode=>{replyMode=mode},mode);
   await page.getByRole('button',{name:labels.refresh,exact:true}).click();
   const legend=page.getByTestId('quota-fable-legend');
   if(mode==='zero')await legend.getByText('Fable 0%',{exact:false}).waitFor();
   else await legend.getByText(labels.pending,{exact:false}).waitFor();
   assert.equal(await legend.getByText(labels.gap,{exact:false}).count(),0);
   assert.equal(await page.getByRole('progressbar').count(),4);
  }
  for(const width of [320,390,1000]){
   await page.setViewportSize({width,height:width===1000?1100:740});
   await page.evaluate(()=>{replyMode='success';closeQuotaMenu()});
   await page.waitForTimeout(180);
   await page.getByRole('button',{name:labels.account,exact:true}).click();
   await page.getByText(labels.gap,{exact:false}).waitFor();
   // Animated parent transforms can introduce sub-pixel floating point noise.
   const sizes=async()=>Promise.all(['quota-codex','quota-claude','account-quota-cards'].map(async id=>Math.round((await page.getByTestId(id).boundingBox()).height*10)/10));
   const before=await sizes();
   await page.evaluate(()=>{replyMode='failed'});
   await page.getByRole('button',{name:labels.refresh,exact:true}).click();
   await page.getByText(labels.retry,{exact:true}).waitFor();
   assert.equal(await page.getByText('72%',{exact:true}).count(),1);
   assert.deepEqual(await sizes(),before,`refresh failure must not stretch quota cards at ${width}px`);
   await page.evaluate(()=>{replyMode='success'});
   await page.getByRole('button',{name:labels.refresh,exact:true}).click();
   await page.getByText(labels.retry,{exact:true}).waitFor({state:'hidden'});
   assert.deepEqual(await sizes(),before,`recovery must not shrink quota cards at ${width}px`);
  }
  await page.evaluate(()=>{replyMode='missing'});
  await page.getByRole('button',{name:labels.refresh,exact:true}).click();
  await page.waitForTimeout(100);
  assert.equal(await page.getByText('0%',{exact:true}).count(),0);
  assert.equal(await page.getByTestId('quota-fable-legend').count(),1);
  assert.equal(await page.getByRole('progressbar').count(),4,'Fable shares the weekly bar, without a separate progress bar');
  assert.ok((await page.getByTestId('quota-fable-legend').innerText()).includes('Fable —'));
  assert.deepEqual(errors,[]);
  console.log('PASS real AccountMenu + quota hook, light/dark 320/390/1000, scrolling, refresh failure preserves data and height, missing is not zero');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exit(1)});
