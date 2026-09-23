// Exercise the actual exported Metro modules, styles and icons with synthetic
// messages. No app bootstrap, authentication, browser profile or production API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(process.argv[2] || '/tmp/lmc-session-order-web');
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-session-order-check-'));
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
const {AuthProvider}=moduleExport('AuthProvider'),{FloatingSessionDrawer}=moduleExport('FloatingSessionDrawer');
const {useSessionDrawer}=moduleExport('useSessionDrawer'),{SidebarView}=moduleExport('SidebarView');
const {GestureHandlerRootView}=moduleExport('GestureHandlerRootView'),{SafeAreaProvider}=moduleExport('SafeAreaProvider');
const {storage}=moduleExport('storage'),{apiSocket}=moduleExport('apiSocket'),{sync}=moduleExport('sync');
// Only settings use transport. All data, credentials and encryption here are
// synthetic; fetch is restricted to this localhost account-settings stub.
const localFetch=window.fetch.bind(window);
window.fetch=(url,options)=>{
 if(!String(url).endsWith('/v1/account/settings'))throw Error('Unexpected fixture fetch: '+url);
 return localFetch('/v1/account/settings',options);
};
sync.credentials={token:'isolated-fixture'};
sync.encryption={encryptRaw:async value=>JSON.stringify(value),decryptRaw:async value=>JSON.parse(value)};
for(const key of ['sessionsSync','machinesSync','projectsSync','profileSync','purchasesSync','pushTokenSync','nativeUpdateSync','artifactsSync','friendsSync','friendRequestsSync','feedSync'])sync[key]={invalidate(){}};
apiSocket.onReconnected=callback=>{window.reconnect=callback;return()=>{}};
apiSocket.onMessage=(name,callback)=>{if(name==='update')window.receiveUpdate=callback;return()=>{}};
sync.subscribeToUpdates();
window.setOrder=(key,ids)=>sync.applySettings({sessionProjectOrder:{[key]:ids}});
window.awaitSettings=()=>sync.settingsSync.awaitQueue();
window.readSettings=()=>({settings:storage.getState().settings,version:storage.getState().settingsVersion,pending:sync.pendingSettings});
window.reloadSettings=()=>sync.settingsSync.invalidateAndAwait();
const common={active:true,presence:'online',thinking:false,createdAt:10,updatedAt:10,metadata:{path:'/fixture',host:'Fixture',machineId:'machine',flavor:'codex'}};
const session=(id,createdAt,extra={})=>({...common,id,createdAt,metadata:{...common.metadata,summary:{text:id},...extra}});
const rows=[...['H1','H2','H3'].map((id,i)=>session(id,i+1,{orchestration:{role:'hub',workers:id==='H1'?[{sessionId:'W1'},{sessionId:'W2'}]:[],board:[]}})),
 ...['W1','W2'].map((id,i)=>session(id,i+4,{orchestration:{role:'worker',hub:{sessionId:'H1'}}})),
 session('C1',7,{flavor:'claude'}),session('C2',8,{flavor:'claude'}),session('X1',9),session('X2',10)];
storage.setState({isDataReady:true,settingsVersion:0,profile:{id:'fixture',firstName:'Fixture'},sessions:Object.fromEntries(rows.map(s=>[s.id,s])),machines:{machine:{id:'machine',active:true,createdAt:1,metadata:{displayName:'Fixture device',host:'Fixture'}}}});
useSessionDrawer.getState().setOpen(true);
const content=innerWidth>=768?h('div',{style:{display:'flex',width:360,height:innerHeight}},h(SidebarView,{})):h(GestureHandlerRootView,{style:{flex:1}},h(FloatingSessionDrawer,{}));
createRoot(document.getElementById('root')).render(h(SafeAreaProvider,{initialMetrics:{frame:{x:0,y:0,width:innerWidth,height:innerHeight},insets:{top:0,bottom:0,left:0,right:0}}},h(AuthProvider,{initialCredentials:null},content)));
`;
const fonts=fs.readdirSync(path.join(root,'assets/sources/assets/fonts')).filter(f=>f.startsWith('IBMPlexSans-')).map(f=>`@font-face{font-family:'${f.split('.')[0]}';src:url('/assets/sources/assets/fonts/${f}')}`).join('');
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fonts}body{margin:0;font-family:IBMPlexSans-Regular,Arial,sans-serif}</style><div id="root"></div>${scripts.map((s,i)=>`<script src="${s}"></script>${i===0?'<script src="/capture.js"></script>':''}`).join('')}<script src="/fixture.js"></script>`;
let account={settings:null,settingsVersion:0},conflicts=0;
const clients=[];
const update=()=>({id:'fixture-update',seq:account.settingsVersion,createdAt:Date.now(),body:{t:'update-account',id:'fixture',settings:{value:account.settings,version:account.settingsVersion}}});
const server=http.createServer(async(req,res)=>{
 let content,type='text/javascript';
 if(req.url==='/v1/account/settings'){
  type='application/json';
  if(req.method==='POST'){
   const parts=[];for await(const chunk of req)parts.push(chunk);
   const body=JSON.parse(Buffer.concat(parts));
   if(body.expectedVersion!==account.settingsVersion){conflicts++;content=JSON.stringify({success:false,error:'version-mismatch',currentVersion:account.settingsVersion,currentSettings:account.settings});}
   else{
    account={settings:body.settings,settingsVersion:account.settingsVersion+1};content=JSON.stringify({success:true});
    const message=update();
    for(const client of clients)if(client.online)await client.page.evaluate(message=>receiveUpdate(message),message);
   }
  }else content=JSON.stringify(account);
 }else if(req.url==='/'){content=html;type='text/html';}
 else if(req.url==='/capture.js')content=capture;
 else if(req.url==='/fixture.js')content=fixture;
 else{
  const pathname=decodeURIComponent(req.url.split('?')[0]),file=path.resolve(root,'.'+pathname);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  content=fs.readFileSync(file);
  if(pathname===main)content=content.toString().replace(/__r\(0\);\s*$/,'');
  if(pathname.endsWith('.ttf'))type='font/ttf';
  if(pathname.endsWith('.png'))type='image/png';
  if(pathname.endsWith('.css'))type='text/css';
 }
 res.setHeader('Content-Type',type);res.end(content);
});
async function expectOrder(page,prefix,expected){
 await page.waitForFunction(({prefix,expected})=>{
  const ids=[...new Set([...document.querySelectorAll('[data-session-sort-id]')].map(n=>n.dataset.sessionSortId))].filter(id=>id.startsWith(prefix));
  return JSON.stringify(ids)===JSON.stringify(expected);
 },{prefix,expected});
}
async function drag(page,id,target){
 const from=page.locator('[data-hub-sort-id="'+id+'"]').first(),to=page.locator('[data-hub-sort-id="'+target+'"]').first();
 await from.scrollIntoViewIfNeeded();const a=await from.boundingBox(),b=await to.boundingBox();
 await page.mouse.move(a.x+a.width/2,a.y+20);await page.mouse.down();await page.waitForTimeout(400);
 await page.mouse.move(a.x+a.width/2,b.y+b.height-5,{steps:8});await page.mouse.up();
}
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,executablePath:process.env.LMC_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const errors=[];
 try{
  for(const width of [1100,390]){
   const context=await browser.newContext({viewport:{width,height:1000},locale:width===390?'zh-CN':'en-US'});
   await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
   const page=await context.newPage();page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));
   await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('[data-hub-sort-id="H1"]').first().waitFor();
   clients.push({page,online:true});
  }
  const [desktop,phone]=clients.map(c=>c.page);
  for(const page of [desktop,phone])await expectOrder(page,'H',['H1','H2','H3']);
  // Real desktop drag -> settings POST -> live update on the phone.
  await drag(desktop,'H1','H3');
  await expectOrder(phone,'H',['H2','H3','H1']);await desktop.evaluate(()=>awaitSettings());
  console.log('PASS desktop drag synchronizes to phone');
  // Phone misses a realtime update while disconnected. Reconnect must fetch
  // the canonical account order without a manual page reload.
  clients[1].online=false;
  await desktop.evaluate(()=>setOrder('lmc:hubs',['H3','H1','H2']));await desktop.evaluate(()=>awaitSettings());
  await expectOrder(phone,'H',['H2','H3','H1']);
  clients[1].online=true;await phone.evaluate(()=>reconnect());
  await expectOrder(phone,'H',['H3','H1','H2']);
  console.log('PASS reconnect catches missed ordering');
  // Phone changes worker order using a stale settings version while desktop
  // reorders Claude/Codex rows: version reconciliation must keep both groups.
  clients[1].online=false;
  await desktop.evaluate(()=>{setOrder('lmc:machine:claude',['C2','C1']);setOrder('lmc:machine:codex',['X2','X1'])});
  await desktop.evaluate(()=>awaitSettings());
  clients[1].online=true;
  await phone.evaluate(()=>setOrder('lmc:hub:H1',['W2','W1']));await phone.evaluate(()=>awaitSettings());
  for(const page of [desktop,phone]){
   await expectOrder(page,'C',['C2','C1']);await expectOrder(page,'X',['X2','X1']);await expectOrder(page,'W',['W2','W1']);
  }
  assert.ok(conflicts>0,'exercise real version-mismatch reconciliation');
  console.log('PASS phone edit reaches desktop; independent group orders survive conflict');
  // Resume a suspended browser tab without changing its socket. RN Web
  // AppState listens to visibilitychange; this runs the production listener.
  clients[1].online=false;
  await phone.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'))});
  await desktop.evaluate(()=>setOrder('lmc:hubs',['H1','H2','H3']));await desktop.evaluate(()=>awaitSettings());
  clients[1].online=true;
  await phone.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'))});
  await expectOrder(phone,'H',['H1','H2','H3']);
  console.log('PASS foreground resume catches missed ordering');
  // An older delayed update must not overwrite the final order.
  const stale={id:'stale',seq:1,createdAt:1,body:{t:'update-account',id:'fixture',settings:{value:JSON.stringify({sessionProjectOrder:{'lmc:hubs':['H3','H2','H1']}}),version:1}}};
  for(const page of [desktop,phone]){
   await page.evaluate(message=>receiveUpdate(message),stale);await expectOrder(page,'H',['H1','H2','H3']);
   await page.reload();await page.evaluate(()=>reloadSettings());await expectOrder(page,'H',['H1','H2','H3']);
   await expectOrder(page,'C',['C2','C1']);await expectOrder(page,'W',['W2','W1']);
  }
  assert.deepEqual(errors,[]);
  for(let i=0;i<clients.length;i++)await clients[i].page.screenshot({path:path.join(out,(i?'phone':'desktop')+'.png'),fullPage:true});
  console.log('PASS persisted order after reload, stale updates ignored; '+account.settingsVersion+' versions, '+conflicts+' conflicts; no page errors');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1});
