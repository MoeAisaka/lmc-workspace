// Exercise the actual exported Metro modules, styles and icons with synthetic
// messages. No app bootstrap, authentication, browser profile or production API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(process.argv[2] || '/tmp/lmc-drawer-alignment-web');
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-drawer-alignment-check-'));
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
const init=modules.get(0);__r(init.deps[0]);__r(init.deps[1]);
const React=moduleExport('useState'),h=React.createElement,{createRoot}=moduleExport('createRoot');
const {SessionViewLoaded}=moduleExport('SessionViewLoaded'),{FloatingSessionDrawer}=moduleExport('FloatingSessionDrawer');
const {AccountMenuLayer,useAccountMenu}=moduleExport('AccountMenuLayer');
const {useSessionDrawer}=moduleExport('useSessionDrawer'),{storage,useSession}=moduleExport('storage');
const {sync}=moduleExport('sync'),{gitStatusSync}=moduleExport('gitStatusSync');
const {NavigationContext}=moduleExport('NavigationContext'),{AuthProvider}=moduleExport('AuthProvider');
const {SafeAreaProvider,SafeAreaInsetsContext}=moduleExport('SafeAreaProvider'),{GestureHandlerRootView}=moduleExport('GestureHandlerRootView');
const {UnistylesRuntime}=moduleExport('UnistylesRuntime');
sync.onSessionVisible=()=>{};gitStatusSync.getSync=()=>({invalidate(){}});
const listeners={focus:new Set(),blur:new Set()};let focused=true;
const navigation={isFocused:()=>focused,addListener:(name,fn)=>{listeners[name].add(fn);return()=>listeners[name].delete(fn)}};
window.focusChat=next=>{focused=next;for(const fn of listeners[next?'focus':'blur'])fn()};
window.setTheme=name=>{UnistylesRuntime.setAdaptiveThemes(false);UnistylesRuntime.setTheme(name)};
const base=Date.now()-60000;
const session={id:'fixture',seq:1,createdAt:base,updatedAt:base,active:true,activeAt:base,presence:'online',thinking:false,thinkingAt:0,metadataVersion:1,agentStateVersion:1,metadata:{version:'1.2.54',path:'/fixture',host:'Fixture',flavor:'codex',summary:{text:'Fixture chat'},sessionCapabilities:{turnQueue:true,turnQueueLifecycle:true}},agentState:{}};
const empty={messages:[],messagesMap:{},isLoaded:true,hasMoreOlder:false,isLoadingOlder:false};
storage.setState({isDataReady:true,profile:{id:'fixture',firstName:'Demo'},sessions:{fixture:session},sessionMessages:{fixture:empty}});
storage.getState().applySettingsLocal({alwaysShowContextSize:true});
window.showFigures=show=>{const current=storage.getState();storage.setState({sessionMessages:{fixture:{...empty,reducerState:show?{latestUsage:{inputTokens:20000,outputTokens:0,cacheCreation:0,cacheRead:0,contextSize:56000,contextWindow:200000}}:undefined}},sessions:{...current.sessions,fixture:{...current.sessions.fixture,turnLifecycle:show?{thinking:false,timing:{startedAt:base,endedAt:base+13000,status:'completed',approximate:false}}:undefined,agentState:show?{usageLimits:{capturedAt:Date.now(),windows:[{id:'seven_day',utilization:50,resetsAt:Date.now()+3600000}]}}:{}}}})};
useSessionDrawer.getState().setOpen(true);
function Chat(){const session=useSession('fixture');return h(SessionViewLoaded,{sessionId:'fixture',session})}
function App(){const [bottom,setBottom]=React.useState(0);window.setBottom=setBottom;const [size,setSize]=React.useState({w:innerWidth,h:innerHeight});React.useEffect(()=>{const f=()=>setSize({w:innerWidth,h:innerHeight});addEventListener('resize',f);return()=>removeEventListener('resize',f)},[]);
 return h(SafeAreaProvider,{initialMetrics:{frame:{x:0,y:0,width:size.w,height:size.h},insets:{top:0,bottom:0,left:0,right:0}}},h(SafeAreaInsetsContext.Provider,{value:{top:0,bottom,left:0,right:0}},h(AuthProvider,{initialCredentials:null},h(NavigationContext.Provider,{value:navigation},h(GestureHandlerRootView,{style:{width:size.w,height:size.h}},h(Chat,{}),h(FloatingSessionDrawer,{}),h(AccountMenuLayer,{}))))));
}
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
  const context=await browser.newContext({viewport:{width:390,height:740},locale:'zh-CN'});
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const page=await context.newPage();page.setDefaultTimeout(6000);const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.locator('textarea').first().waitFor();
  const bounds=()=>page.evaluate(()=>{
   let card=document.querySelector('textarea');
   while(card && getComputedStyle(card).borderRadius!=='20px')card=card.parentElement;
   if(!card)throw Error('composer card not found');
   const anchor=moduleExport('useSessionDrawer').useSessionDrawer.getState().composer;
   const panel=document.querySelector('[data-testid="floating-session-drawer"]') || [...document.querySelectorAll('div')].find(n=>getComputedStyle(n).borderRadius==='24px' && n.querySelector('[data-hub-sort-id], [data-session-sort-id]'));
   const c=card.getBoundingClientRect(),d=panel.getBoundingClientRect();
   return {composerBottom:c.bottom,drawerBottom:d.bottom,drawerTop:d.top,anchor};
  });
  for(const theme of ['light','dark']){
   await page.evaluate(name=>setTheme(name),theme);
   for(const viewport of [{width:390,height:740},{width:390,height:840},{width:320,height:568},{width:430,height:900},{width:667,height:390}]){
    await page.setViewportSize(viewport);
    for(const inset of [0,34]){
     await page.evaluate(value=>setBottom(value),inset);
     for(const figures of [false,true]){
     await page.evaluate(show=>showFigures(show),figures);await page.waitForTimeout(150);
     if(figures){
      assert.equal(await page.getByTestId('agent-input-usage').count(),1);
      assert.ok((await page.getByTestId('agent-input-usage').innerText()).includes('50%'),'weekly usage is actually rendered');
     }
     const b=await bounds();
     assert.ok(Math.abs(b.composerBottom-b.drawerBottom)<1.5,JSON.stringify({theme,viewport,inset,figures,...b}));
     }
    }
   }
  }
  await page.setViewportSize({width:390,height:740});await page.waitForTimeout(150);
  const aligned=await bounds();
  // Opening the avatar submenu must keep the previous top-alignment fix.
  const label=await page.evaluate(()=>moduleExport('getCurrentLanguage').t('lmc.list.accountAndSettings'));
  await page.getByRole('button',{name:label,exact:true}).click();await page.waitForTimeout(200);
  const menuTop=await page.getByTestId('account-quota-cards').evaluate(n=>{while(n&&getComputedStyle(n).position!=='absolute')n=n.parentElement;return n.getBoundingClientRect().top});
  assert.ok(Math.abs(menuTop-aligned.drawerTop)<1.5,'avatar submenu top remains aligned');
  await page.evaluate(()=>moduleExport('useAccountMenu').useAccountMenu.getState().close());
  // Navigating away clears the composer geometry; returning restores it.
  await page.evaluate(()=>focusChat(false));await page.waitForTimeout(100);
  assert.equal((await bounds()).anchor,null);
  await page.evaluate(()=>focusChat(true));await page.waitForTimeout(100);
  assert.ok((await bounds()).anchor);
  await page.screenshot({path:path.join(out,'phone.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('PASS actual SessionViewLoaded/AgentInput and drawer bottom alignment: usage absent/present, light/dark, 320/390/430/667, safe-area 0/34, viewport height changes; submenu top and focus cleanup');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1});
