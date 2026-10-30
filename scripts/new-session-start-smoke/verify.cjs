// Exercise the actual exported Metro modules, styles and icons with synthetic
// messages. No app bootstrap, authentication, browser profile or production API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(process.argv[2] || '/tmp/lmc-create-v324-20261013');
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-new-session-check-'));
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
window.calls=[];window.errors=[];window.navigation=[];
window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
function override(name,value) {
 const re=new RegExp('\\\\.'+name+'\\\\s*=');let count=0;
 for(const [id,m] of modules) if(re.test(m.factory.toString())){
  const e=__r(id),desc=Object.getOwnPropertyDescriptor(e,name);
  if(desc&&desc.writable){e[name]=value;count++}
 }
 if(!count) throw new Error('Cannot stub '+name);
}
const router={back:()=>navigation.push('back'),push:id=>navigation.push(id),replace:id=>navigation.push(id),canGoBack:()=>true};
override('useRouter',()=>router);override('useLocalSearchParams',()=>({}));override('useNavigation',()=>({setOptions(){}}));override('usePathname',()=>'/new');
const {storage}=moduleExport('storage');
storage.setState(state=>({localSettings:{...state.localSettings,onboardingStep:null}}));
const baseMachine={id:'fixture-machine',seq:1,createdAt:1,updatedAt:1,active:true,activeAt:Date.now(),metadata:{host:'Fixture Windows',displayName:'Fixture Windows',platform:'win32',homeDir:'C:/Users/fixture',happyCliVersion:'1.2.110',cliAvailability:{codex:true,claude:true,detectedAt:Date.now()}}};
storage.setState({isDataReady:true,machines:{[baseMachine.id]:baseMachine},sessionsData:[],sessions:{}});
window.activity=()=>storage.setState(s=>({machines:{[baseMachine.id]:{...baseMachine,activeAt:Date.now()}},sessionsData:[...s.sessionsData]}));
const draft=moduleExport('useNewSessionDraft').useNewSessionDraft;
draft.setState({input:'Creation regression probe',attachments:[],selectedMachineId:baseMachine.id,selectedPath:'D:/project',agentType:'codex',modelMode:'gpt-6-astra',permissionMode:'yolo',effortLevel:'xhigh',sessionType:'simple',worktreeKey:null});
window.setEngine=agent=>draft.setState({agentType:agent,modelMode:agent==='codex'?'gpt-6-astra':'opus',effortLevel:agent==='codex'?'xhigh':'high',permissionMode:agent==='codex'?'yolo':'bypassPermissions'});
const {apiSocket}=moduleExport('apiSocket');
apiSocket.machineRPC=async(machine,method,params)=>{
 calls.push({machine,method,params});
 if(method==='bash') return {success:false,exitCode:128,stdout:'',stderr:'not a git repository'};
 if(method==='spawn-happy-session') return {error:'Session webhook timeout for PID 23800'};
 throw new Error('Unexpected fixture RPC '+method);
};
const {ModalProvider}=moduleExport('ModalProvider'),{SafeAreaProvider}=moduleExport('SafeAreaProvider');
const moduleId=[...modules].find(([id,m])=>m.factory.toString().includes('.useNewSessionWorktrees')&&m.factory.toString().includes('newSession.prompt'))?.[0];
if(moduleId===undefined)throw new Error('NewSessionScreen module missing');
const Screen=__r(moduleId).default;
createRoot(document.getElementById('root')).render(h(SafeAreaProvider,{initialMetrics:{frame:{x:0,y:0,width:innerWidth,height:innerHeight},insets:{top:0,bottom:0,left:0,right:0}}},h(ModalProvider,null,h(Screen))));
`;
const fonts=fs.readdirSync(path.join(root,'assets/sources/assets/fonts')).filter(f=>f.startsWith('IBMPlexSans-')).map(f=>`@font-face{font-family:'${f.split('.')[0]}';src:url('/assets/sources/assets/fonts/${f}')}`).join('');
const styles=[...originalHtml.matchAll(/<style[^>]*>[\s\S]*?<\/style>|<link[^>]+rel="stylesheet"[^>]*>/g)].map(m=>m[0]).join('');
const html = `<!doctype html>${styles}<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fonts}body{margin:0;font-family:IBMPlexSans-Regular,Arial,sans-serif}</style><div id="root"></div>${scripts.map((s,i)=>`<script src="${s}"></script>${i===0?'<script src="/capture.js"></script>':''}`).join('')}<script src="/fixture.js"></script>`;
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
 const browser=await chromium.launch({headless:true,executablePath:process.env.LMC_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disk-cache-size=0','--renderer-process-limit=4','--disable-extensions']});
 const errors=[];
 try{
  const origin='http://127.0.0.1:'+server.address().port;
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.route('**/*',route=>route.request().url().startsWith(origin)||route.request().url().startsWith('data:')?route.continue():route.abort());
  const page=await context.newPage();page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});
  await page.goto(origin);
  await page.getByRole('button',{name:'Send',exact:true}).waitFor({timeout:10000});
  await page.waitForFunction(()=>calls.some(c=>c.method==='bash'));
  for(let tick=0;tick<100;tick++) await page.evaluate(()=>new Promise(resolve=>{activity();requestAnimationFrame(()=>resolve())}));
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.method==='bash').length),1);
  const results=[];
  for(const engine of ['codex','claude']){
   await page.evaluate(engine=>setEngine(engine),engine);
   const button=page.getByRole('button',{name:'Send',exact:true});
   await button.click();
   await page.getByText('Session webhook timeout for PID 23800',{exact:true}).waitFor({timeout:10000});
   await page.waitForTimeout(350); // Allow the modal's entrance opacity animation to finish.
   await page.screenshot({path:path.join(out,engine+'-timeout.png')});
   assert.equal(await page.locator('textarea').inputValue(),'Creation regression probe');
   assert.deepEqual(await page.evaluate(()=>navigation),[]);
   results.push({engine,errorVisible:true,draftPreserved:true,navigation:[]});
   const close=page.getByRole('button',{name:/^(OK|确定)$/});
   if(await close.count()) await close.click(); else await page.getByText(/^(OK|确定)$/,{exact:true}).click();
   await button.waitFor();assert.equal(await button.isEnabled(),true);
  }
  const final=await page.evaluate(()=>({calls,errors}));
  assert.deepEqual(errors,[]);assert.deepEqual(final.errors,[]);
  assert.equal(final.calls.filter(c=>c.method==='spawn-happy-session').length,2);
  assert.equal(final.calls.filter(c=>c.method==='bash').length,1);
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,results,...final},null,2));
  console.log(JSON.stringify({passed:true,results,out}));
 }catch(error){console.error(JSON.stringify({errors}));throw error}
 finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1});
