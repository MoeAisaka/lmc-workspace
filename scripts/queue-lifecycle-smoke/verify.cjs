// Exercise the actual exported Metro modules, styles and icons with synthetic
// messages. No app bootstrap, authentication, browser profile or production API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(process.argv[2] || '/tmp/lmc-queue-lifecycle-web');
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-queue-lifecycle-check-'));
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
const {ChatList}=moduleExport('ChatList'),{QueueStrip}=moduleExport('QueueStrip');
const {DeviceEngineSessionList}=moduleExport('DeviceEngineSessionList');
const {pendingQueuePrompts}=moduleExport('pendingQueuePrompts'),{storage}=moduleExport('storage');
const {UnistylesRuntime}=moduleExport('UnistylesRuntime'),{SafeAreaProvider}=moduleExport('SafeAreaProvider');
const {GestureHandlerRootView}=moduleExport('GestureHandlerRootView');
window.setTheme=theme=>{UnistylesRuntime.setAdaptiveThemes(false);UnistylesRuntime.setTheme(theme);document.body.style.background=theme==='dark'?'#202020':'#fff'};
const base=Date.now()-30000;
const messages=[{kind:'agent-text',id:'reply',localId:null,createdAt:base+2000,text:'Current reply is still running.'},{kind:'user-text',id:'pending',localId:'key',createdAt:base+1000,text:'Pending unique prompt',meta:{intent:'queue',queueKey:'key'}},{kind:'user-text',id:'original',localId:'original',createdAt:base,text:'Original question'}];
const common={active:true,presence:'online',thinking:false,createdAt:base,updatedAt:base,metadata:{path:'/fixture',host:'Fixture',flavor:'codex'}};
const hub={...common,id:'hub',metadata:{...common.metadata,name:'Fixture Hub',summary:{text:'Fixture Hub'},orchestration:{role:'hub',workers:[{sessionId:'worker'}],board:[]}}};
const worker={...common,id:'worker',metadata:{...common.metadata,name:'Fixture Worker',summary:{text:'Fixture Worker'},orchestration:{role:'worker',hub:{sessionId:'hub'}}}};
window.actionCount=0;const action=()=>window.actionCount++;
function App(){
 const [phase,setPhase]=React.useState('sending'),[engine,setEngine]=React.useState('codex'),[listKey,remount]=React.useState(0);
 window.setPhase=setPhase;window.setEngine=setEngine;window.remount=()=>remount(n=>n+1);
 const queue=phase==='queued'||phase==='restored'||phase==='released-stale'?[{key:'key',preview:'Pending unique prompt',createdAt:base+1000}]:[];
 const receipt=phase.startsWith('released')?{type:'queue-released',keys:['key']}:phase==='withdrawn'?{type:'queue-withdrawn',key:'key'}:null;
 const liveMessages=receipt?[{kind:'agent-event',id:'receipt',createdAt:base+4000,event:receipt},...messages]:messages;
 const session={...common,id:'fixture',thinking:true,metadata:{...common.metadata,flavor:engine,sessionCapabilities:{turnQueue:true,turnQueueLifecycle:true}},agentState:{queue}};
 storage.setState({isDataReady:true,sessions:{hub,worker,fixture:session},sessionMessages:{fixture:{messages:liveMessages,isLoaded:true,hasMoreOlder:false,isLoadingOlder:false,messagesMap:Object.fromEntries(liveMessages.map(m=>[m.id,m]))}}});
 return h(SafeAreaProvider,{initialMetrics:{frame:{x:0,y:0,width:390,height:900},insets:{top:0,bottom:0,left:0,right:0}}},h(GestureHandlerRootView,{},
 h('section',{id:'list',style:{width:'min(360px,100%)',height:300,display:'flex'}},h(DeviceEngineSessionList,{key:listKey,hideSearch:true,hideAccount:true})),
 h('section',{id:'chat',style:{height:300,width:'100%'}},h(ChatList,{session,topContentInset:0,bottomContentInset:0})),
 h('section',{id:'strip',style:{padding:8}},h(QueueStrip,{items:pendingQueuePrompts(liveMessages,queue),mode:'batch',steerState:engine==='codex'?'ready':'disabled',onSteer:action,onPromote:action,onWithdraw:action,onModeChange:action}))));
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
  const context=await browser.newContext({viewport:{width:390,height:1000},locale:'zh-CN'});
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));

  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.getByText('Current reply is still running.',{exact:true}).waitFor();
  const labels=await page.evaluate(()=>{const {t}=moduleExport('getCurrentLanguage');return {expand:t('lmc.list.expand'),collapse:t('lmc.list.collapse'),promote:t('lmc.queue.promote')}});
  const toggle=page.locator('#list [aria-expanded]').first();
  assert.equal(await toggle.getAttribute('aria-expanded'),'false');
  const group=page.getByText('Fixture Worker',{exact:true});
  const hidden=()=>group.evaluate(n=>{const target=n;while(n&&!n.hasAttribute('aria-hidden'))n=n.parentElement;return {hidden:n?.getAttribute('aria-hidden'),height:(n??target).getBoundingClientRect().height}});
  let box=await hidden();assert.equal(box.hidden,'true');assert.equal(box.height,0,'collapsed list reserves no worker height');
  await toggle.click();await page.waitForTimeout(350);
  assert.equal(await toggle.getAttribute('aria-expanded'),'true');box=await hidden();assert.ok(box.height>0);
  await page.evaluate(()=>remount());await page.waitForTimeout(100);assert.equal(await toggle.getAttribute('aria-expanded'),'true','manual expansion survives remount');
  await toggle.click();await page.waitForTimeout(300);await page.evaluate(()=>remount());await page.waitForTimeout(100);assert.equal(await toggle.getAttribute('aria-expanded'),'false');
  for(const engine of ['claude','codex']){
   await page.evaluate(engine=>setEngine(engine),engine);
   for(const phase of ['sending','queued','taken','restored']){
    await page.evaluate(phase=>setPhase(phase),phase);await page.waitForTimeout(80);
    assert.equal(await page.locator('#chat').getByText('Pending unique prompt',{exact:true}).count(),0,engine+' '+phase+' must not show a bubble');
    assert.equal(await page.locator('#strip').getByText('Pending unique prompt',{exact:true}).count(),1);
    assert.equal(await page.locator('#strip').getByRole('button',{name:labels.promote,exact:true}).isDisabled(),['sending','taken'].includes(phase));
   }
   for(const phase of ['released-stale','released']){
    await page.evaluate(phase=>setPhase(phase),phase);await page.waitForTimeout(80);
    assert.equal(await page.locator('#chat').getByText('Pending unique prompt',{exact:true}).count(),1);
    assert.equal(await page.locator('[data-lmc-queue-strip]').count(),0);
   }
   await page.evaluate(()=>setPhase('withdrawn'));await page.waitForTimeout(80);
   assert.equal(await page.getByText('Pending unique prompt',{exact:true}).count(),0);
  }
  await page.evaluate(()=>setPhase('queued'));
  for(const theme of ['light','dark']){
   await page.evaluate(theme=>setTheme(theme),theme);
   for(const width of [320,390,1100]){
    await page.setViewportSize({width,height:1000});await page.waitForTimeout(80);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:path.join(out,theme+'-'+width+'.png'),fullPage:true});
   }
  }
  assert.deepEqual(errors,[]);
  console.log('PASS actual hub list default collapse, zero reserved height, manual state retained; ChatList/QueueStrip: optimistic queue, delayed snapshot, take/restore, release/withdrawal, Claude and Codex; light/dark at 320/390/1100');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exit(1)});
