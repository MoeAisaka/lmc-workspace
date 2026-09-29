// Expanded hub group: archive two of four workers and check the next group
// moves up with them. Synthetic sessions on the exported Metro modules;
// external requests are blocked. Usage: see README.md.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(process.argv[2] || '/tmp/lmc-drawer-alignment-web');
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-hub-archive-gap-'));
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
const {AccountMenuLayer}=moduleExport('AccountMenuLayer');
const {useSessionDrawer}=moduleExport('useSessionDrawer'),{storage,useSession}=moduleExport('storage');
const {sync}=moduleExport('sync'),{gitStatusSync}=moduleExport('gitStatusSync');
const {NavigationContext}=moduleExport('NavigationContext'),{AuthProvider}=moduleExport('AuthProvider');
const {SafeAreaProvider,SafeAreaInsetsContext}=moduleExport('SafeAreaProvider'),{GestureHandlerRootView}=moduleExport('GestureHandlerRootView');
sync.onSessionVisible=()=>{};gitStatusSync.getSync=()=>({invalidate(){}});
const navigation={isFocused:()=>true,addListener:()=>()=>{}};
const base=Date.now()-600000;
const mk=(id,name,i,extra)=>({id,seq:1,createdAt:base+i*1000,updatedAt:base+i*1000,active:true,activeAt:base,presence:'online',thinking:false,thinkingAt:0,metadataVersion:1,agentStateVersion:1,
 metadata:{version:'1.2.60',path:'/fixture',host:'Fixture',machineId:'m1',flavor:'claude',summary:{text:name},name,...extra},agentState:{}});
const workers=['w1','w2','w3','w4'];
const sessions={
 fixture:mk('fixture','Fixture chat',0,{}),
 hub:mk('hub','Hub group',1,{orchestration:{role:'hub',workers:workers.map(id=>({sessionId:id}))}}),
 ...Object.fromEntries(workers.map((id,i)=>[id,mk(id,'Worker '+(i+1),2+i,{orchestration:{role:'worker',hub:{sessionId:'hub'}}})])),
 other:mk('other','Other hub',9,{orchestration:{role:'hub',workers:[]}}),
};
const empty={messages:[],messagesMap:{},isLoaded:true,hasMoreOlder:false,isLoadingOlder:false};
storage.setState({isDataReady:true,profile:{id:'fixture',firstName:'Demo'},sessions,sessionMessages:{fixture:empty}});
window.archive=ids=>{const cur=storage.getState().sessions;const next={...cur};for(const id of ids)next[id]={...cur[id],active:false,metadata:{...cur[id].metadata,lifecycleState:'archived'}};storage.setState({sessions:next});};
useSessionDrawer.getState().setOpen(true);
function Chat(){const session=useSession('fixture');return h(SessionViewLoaded,{sessionId:'fixture',session})}
function App(){return h(SafeAreaProvider,{initialMetrics:{frame:{x:0,y:0,width:innerWidth,height:innerHeight},insets:{top:0,bottom:0,left:0,right:0}}},h(SafeAreaInsetsContext.Provider,{value:{top:0,bottom:0,left:0,right:0}},h(AuthProvider,{initialCredentials:null},h(NavigationContext.Provider,{value:navigation},h(GestureHandlerRootView,{style:{width:innerWidth,height:innerHeight}},h(Chat,{}),h(FloatingSessionDrawer,{}),h(AccountMenuLayer,{}))))));}
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
  const context=await browser.newContext({viewport:{width:390,height:900},locale:'zh-CN'});
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>console.error('pageerror',e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.getByText('Hub group',{exact:true}).first().waitFor();
  const gap=()=>page.evaluate(()=>{const top=n=>[...document.querySelectorAll('div')].find(d=>d.textContent===n&&!d.children.length)?.getBoundingClientRect();
   const last=[...document.querySelectorAll('div')].filter(d=>/^Worker \d$/.test(d.textContent)&&!d.children.length).map(d=>d.getBoundingClientRect().bottom);
   return {hubTop:top('Hub group')?.top, lastWorkerBottom:last.length?Math.max(...last):null, otherTop:top('Other hub')?.top, workers:last.length};});
  const hub=page.getByRole('button',{name:/Hub group/}).first();
  await hub.hover();
  const expand=await page.evaluate(()=>moduleExport('getCurrentLanguage').t('lmc.list.expand'));
  await page.getByRole('button',{name:expand}).first().click();await page.waitForTimeout(600);
  const before=await gap();
  await page.evaluate(()=>archive(['w3','w4']));await page.waitForTimeout(600);
  const after=await gap();
  await page.screenshot({path:out+'/after.png'});
  const slack=r=>Math.round(r.otherTop-r.lastWorkerBottom);
  console.log(JSON.stringify({before,after,slackBefore:slack(before),slackAfter:slack(after)}));
  assert.equal(after.workers,2,'two workers left');
  assert.ok(Math.abs(slack(after)-slack(before))<2,'the next group follows the archived workers up');
  console.log('PASS archiving workers leaves no gap under an expanded hub');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1});
