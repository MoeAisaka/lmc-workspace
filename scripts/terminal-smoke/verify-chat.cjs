// Exercise the actual exported Metro modules, styles and icons with synthetic
// messages. No app bootstrap, authentication, browser profile or production API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(process.argv[2] || '/tmp/lmc-terminal-theme-v273');
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-terminal-chat-'));
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
const {PersonalizationRuntime}=moduleExport('PersonalizationRuntime'),{SidebarView}=moduleExport('SidebarView');
const {useUnistyles}=moduleExport('useUnistyles');
const {MMKV}=moduleExport('MMKV');new MMKV().set('settings',JSON.stringify({settings:{preferredLanguage:'zh-Hans'},version:1}));
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
const session={id:'fixture',seq:1,createdAt:base,updatedAt:base,active:true,activeAt:base,presence:'online',thinking:false,thinkingAt:0,metadataVersion:1,agentStateVersion:1,metadata:{version:'1.2.54',path:'/fixture',host:'Fixture',flavor:'codex',summary:{text:'终端风格 · 会话预览'},sessionCapabilities:{turnQueue:true,turnQueueLifecycle:true}},agentState:{}};
const empty={messages:[],messagesMap:{},isLoaded:true,hasMoreOlder:false,isLoadingOlder:false};
storage.setState({isDataReady:true,profile:{id:'fixture',firstName:'Demo'},sessions:{fixture:session},sessionMessages:{fixture:empty}});
storage.getState().applySettingsLocal({alwaysShowContextSize:true});
window.showFigures=show=>{const current=storage.getState();storage.setState({sessionMessages:{fixture:{...empty,reducerState:show?{latestUsage:{inputTokens:20000,outputTokens:0,cacheCreation:0,cacheRead:0,contextSize:56000,contextWindow:200000}}:undefined}},sessions:{...current.sessions,fixture:{...current.sessions.fixture,turnLifecycle:show?{thinking:false,timing:{startedAt:base,endedAt:base+13000,status:'completed',approximate:false}}:undefined,agentState:show?{usageLimits:{capturedAt:Date.now(),windows:[{id:'seven_day',utilization:50,resetsAt:Date.now()+3600000}]}}:{}}}})};
useSessionDrawer.getState().setOpen(true);
function Chat(){const session=useSession('fixture');return h(SessionViewLoaded,{sessionId:'fixture',session})}
function App(){const {theme}=useUnistyles();const [bottom,setBottom]=React.useState(0);window.setBottom=setBottom;const [size,setSize]=React.useState({w:innerWidth,h:innerHeight});React.useEffect(()=>{const f=()=>setSize({w:innerWidth,h:innerHeight});addEventListener('resize',f);return()=>removeEventListener('resize',f)},[]);
 return h(SafeAreaProvider,{initialMetrics:{frame:{x:0,y:0,width:size.w,height:size.h},insets:{top:0,bottom:0,left:0,right:0}}},h(SafeAreaInsetsContext.Provider,{value:{top:0,bottom,left:0,right:0}},h(AuthProvider,{initialCredentials:null},h(NavigationContext.Provider,{value:navigation},h(GestureHandlerRootView,{testID:'terminal-fixture-root',style:{width:size.w,height:size.h,flexDirection:'row',backgroundColor:theme.colors.surface}},h(PersonalizationRuntime),size.w>=1000&&h('aside',{style:{width:360,display:'flex',flexDirection:'column'}},h(SidebarView)),h('section',{style:{flex:1,minWidth:0,display:'flex',flexDirection:'column'}},h(Chat,{})),h(FloatingSessionDrawer,{}),h(AccountMenuLayer,{}))))));
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
  if(pathname.endsWith('.woff2'))type='font/woff2';
  if(pathname.endsWith('.ttf'))type='font/ttf';
  if(pathname.endsWith('.png'))type='image/png';
  if(pathname.endsWith('.css'))type='text/css';
 }
 res.setHeader('Content-Type',type);res.end(content);
});

(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const report=[];
 try{
  const context=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN'});
  await context.route('**/*',r=>new URL(r.request().url()).origin==='http://127.0.0.1:'+server.address().port?r.continue():r.abort());
  const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.evaluate(()=>moduleExport('useSessionDrawer').useSessionDrawer.getState().setOpen(false));
  const input=page.locator('textarea').first();await input.fill('未发送的草稿 · TUI theme draft');
  await page.evaluate(()=>{
    window.inputBefore=document.querySelector('textarea');
    storage.getState().applyLocalSettings({personalization:{...moduleExport('PERSONALIZATION_PRESETS').PERSONALIZATION_PRESETS.terminal}});
  });
  await page.waitForFunction(()=>document.documentElement.dataset.lmcChrome==='terminal');
  assert.ok(await page.evaluate(()=>inputBefore===document.querySelector('textarea')));
  const draft='未发送的草稿 · TUI theme draft';
  assert.equal(await input.inputValue(),draft);
  for(const theme of ['light','dark'])for(const flavor of ['claude','codex']){
   await page.emulateMedia({colorScheme:theme});
   await page.evaluate(({theme,flavor})=>{setTheme(theme);const s=storage.getState().sessions.fixture;storage.setState({sessions:{fixture:{...s,metadata:{...s.metadata,flavor}}}});},{theme,flavor});
   for(const [width,height] of [[320,568],[390,844],[844,390],[1440,900]]){
    await page.setViewportSize({width,height});
    await page.waitForFunction(()=>{const r=document.querySelector('[data-testid=terminal-fixture-root]').getBoundingClientRect();return Math.abs(r.width-innerWidth)<1&&Math.abs(r.height-innerHeight)<1;});
    await page.waitForFunction(()=>{const r=document.querySelector('textarea').closest('[data-lmc-surface="panel"]').getBoundingClientRect();return r.width>100&&r.left>=0&&r.right<=innerWidth&&Math.abs(r.bottom-(innerHeight-32))<1; });
    const metrics=await input.evaluate(n=>{const card=n.closest('[data-lmc-surface="panel"]');const b=card.getBoundingClientRect(),s=getComputedStyle(card);return {left:b.left,right:b.right,bottom:b.bottom,width:b.width,radius:s.borderRadius,shadow:s.boxShadow,font:getComputedStyle(n).fontFamily,overflow:document.documentElement.scrollWidth>innerWidth+1};});
    assert.ok(metrics.left>=0&&metrics.right<=width&&metrics.bottom<=height,JSON.stringify(metrics));
    assert.equal(metrics.radius,'2px');assert.equal(metrics.shadow,'none');assert.equal(metrics.overflow,false);
    assert.ok(metrics.font.includes('LMC Sarasa Mono'));
    assert.equal(await input.inputValue(),draft);
    await page.evaluate(()=>document.fonts.ready);
    await page.screenshot({path:path.join(out,`${theme}-${flavor}-${width}.png`)});
    report.push({theme,flavor,width,height,metrics});
   }
  }
  await page.evaluate(()=>storage.getState().applyLocalSettings({personalization:{...moduleExport('PERSONALIZATION_PRESETS').PERSONALIZATION_PRESETS.classic}}));
  await page.waitForFunction(()=>document.documentElement.dataset.lmcChrome==='standard');
  assert.equal(await input.inputValue(),draft);
  assert.equal(await input.evaluate(n=>getComputedStyle(n.closest('[data-lmc-surface="panel"]')).borderRadius),'20px');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({report,errors,draftPreserved:true,classicRestored:true},null,2));
  console.log('PASS full chat: both providers × light/dark × 4 sizes, retained unsent draft and input node, restored Classic.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1});
