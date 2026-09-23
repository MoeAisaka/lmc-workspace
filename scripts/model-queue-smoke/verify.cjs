// Exercise the actual exported Metro modules, styles and icons with synthetic
// messages. No app bootstrap, authentication, browser profile or production API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(process.argv[2] || '/tmp/lmc-model-queue-web');
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-model-queue-check-'));
console.log('Artifacts: '+out);
const originalHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = [...originalHtml.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
const main = scripts.at(-1);
const capture = `window.modules = new Map(); const define = window.__d;
window.__d = (factory,id,deps) => { window.modules.set(id,{factory,deps}); define(factory,id,deps); };
window.moduleExport = name => {
 const re = new RegExp('\\\\.'+name+'\\\\s*=(?!=)');
 for (const [id,m] of window.modules) if (re.test(m.factory.toString())) { const e=window.__r(id); if(e[name]) return e; }
 throw new Error('Module export not found: '+name);
};`;
const fixture = `
const init=modules.get(0); __r(init.deps[0]);__r(init.deps[1]);
const React=moduleExport('useState'),h=React.createElement,{createRoot}=moduleExport('createRoot');
const {ComposerModelPanel}=moduleExport('ComposerModelPanel');
const {ChatList}=moduleExport('ChatList');
const {storage}=moduleExport('storage');
const {getAvailableModels}=moduleExport('getAvailableModels');
const {UnistylesRuntime}=moduleExport('UnistylesRuntime');
const {SafeAreaProvider}=moduleExport('SafeAreaProvider');
const catalogs={"codex":{"models":[{"id":"gpt-6-astra","name":"GPT-6-Astra","description":"Frontier intelligence for the most demanding work.","aliases":[],"efforts":["low","medium","high","xhigh","max","ultra"],"defaultEffort":"medium","isDefault":true},{"id":"gpt-6-sol","name":"GPT-6-Sol","description":"Workhorse model for coding and everyday work.","aliases":[],"efforts":["low","medium","high","xhigh","max","ultra"],"defaultEffort":"medium","isDefault":false},{"id":"gpt-6-luna","name":"GPT-6-Luna","description":"Fast and affordable model for easier tasks.","aliases":[],"efforts":["low","medium","high","xhigh","max"],"defaultEffort":"medium","isDefault":false},{"id":"gpt-reserve","name":"GPT-Reserve","description":"Fast and affordable agentic coding model.","aliases":[],"efforts":["low","medium","high","xhigh","max"],"defaultEffort":"medium","isDefault":false},{"id":"gpt-5.6-sol","name":"GPT-5.6-Sol","description":"Older coding model for complex work.","aliases":[],"efforts":["low","medium","high","xhigh","max","ultra"],"defaultEffort":"low","isDefault":false},{"id":"gpt-5.6-terra","name":"GPT-5.6-Terra","description":"Older balanced model for straightforward work.","aliases":[],"efforts":["low","medium","high","xhigh","max","ultra"],"defaultEffort":"medium","isDefault":false},{"id":"gpt-5.6-luna","name":"GPT-5.6-Luna","description":"Older fast and efficient model.","aliases":[],"efforts":["low","medium","high","xhigh","max"],"defaultEffort":"medium","isDefault":false},{"id":"gpt-5.5","name":"GPT-5.5","description":"Legacy coding model.","aliases":[],"efforts":["low","medium","high","xhigh"],"defaultEffort":"medium","isDefault":false},{"id":"codex-auto-review","name":"Codex Auto Review","description":"Automatic approval review model for Codex.","aliases":[],"efforts":["low","medium","high","xhigh","max"],"defaultEffort":"medium","isDefault":false}],"runtimeVersion":"0.156.1","capturedAt":1790132864537,"stale":false},"claude":{"models":[{"id":"claude-opus-5-5[1m]","name":"Opus (1M context)","description":"Opus 5.5 with 1M context · Best for everyday, complex tasks","aliases":["default","opus[1m]"],"efforts":["low","medium","high","xhigh","max"]},{"id":"claude-fable-5-1","name":"Fable","description":"Fable 5.1 · Most capable for your hardest and longest-running tasks","aliases":["claude-fable-5-1[1m]"],"efforts":["low","medium","high","xhigh","max"]},{"id":"claude-sonnet-5","name":"Sonnet","description":"Sonnet 5 · Efficient for routine tasks","aliases":["sonnet"],"efforts":["low","medium","high","xhigh","max"]},{"id":"claude-haiku-4-5-20251001","name":"Haiku","description":"Haiku 4.5 · Fastest for quick answers","aliases":["haiku"]}],"runtimeVersion":"0.3.280","capturedAt":1790132865529,"stale":false}};
const base=Date.now()-20000;
const receipt='Codex 已接收补充回复，将在当前工作中处理。';
const warning='补充回复尚未确认送达 Codex；未自动重复发送，请检查连接和后续回应。';
const messages=[...[1,2].map(n=>({kind:'agent-event',id:'receipt-'+n,createdAt:base+3000+n,event:{type:'message',message:receipt}})),{kind:'agent-event',id:'warning',createdAt:base+3000,event:{type:'message',message:warning}},{kind:'agent-text',id:'a',localId:null,createdAt:base+2000,text:'Current reply is still running.'},{kind:'user-text',id:'usr-pending',localId:'queued-key',createdAt:base+1000,text:'Pending unique prompt'},{kind:'user-text',id:'u',localId:'original',createdAt:base,text:'Original question'}];
function App(){
 const [queued,setQueued]=React.useState(true),[engine,setEngine]=React.useState('codex'),[withdrawn,setWithdrawn]=React.useState(false);
 window.setWithdrawn=setWithdrawn; window.setQueued=setQueued;window.setEngine=setEngine;window.setTheme=name=>{UnistylesRuntime.setAdaptiveThemes(false);UnistylesRuntime.setTheme(name)};
 const meta={path:'/fixture',host:'test',flavor:engine,modelCatalogs:catalogs,sessionCapabilities:{turnQueue:true,modelDiscovery:true}};
 const session={id:'fixture',active:true,thinking:true,metadata:meta,agentState:{queue:queued?[{key:'queued-key',preview:'Pending unique prompt',createdAt:base+1000}]:[]}};
 const liveMessages=withdrawn?[{kind:'agent-event',id:'withdrawn',createdAt:base+4000,event:{type:'queue-withdrawn',key:'queued-key'}},...messages]:messages;
 storage.setState({sessions:{fixture:session},sessionMessages:{fixture:{messages:liveMessages,isLoaded:true,hasMoreOlder:false,isLoadingOlder:false,messagesMap:Object.fromEntries(liveMessages.map(m=>[m.id,m]))}}});
 const models=getAvailableModels(engine,meta,k=>k);
 return h(SafeAreaProvider,{initialMetrics:{frame:{x:0,y:0,width:390,height:900},insets:{top:0,bottom:0,left:0,right:0}}},
 h('div',{id:'menu',style:{width:'min(360px,100vw)'}},h(ComposerModelPanel,{flavor:engine,metadata:meta,modelMode:models[0],availableModels:models,onModelModeChange:()=>{},onEngineSwitch:()=>{},onClose:()=>{},effortLevel:null,availableEffortLevels:[],permissionMode:null,availableModes:[]})),
 h('div',{id:'chat',style:{height:400,width:'100%'}},h(ChatList,{session,topContentInset:0,bottomContentInset:0})));
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
  const context=await browser.newContext({viewport:{width:1100,height:1000}});
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});

  await page.setViewportSize({width:390,height:900});
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.getByText('Current reply is still running.',{exact:true}).waitFor();
  assert.equal(await page.getByText('Pending unique prompt',{exact:true}).count(),0);
  await page.getByText('GPT-6-Astra',{exact:true}).click();
  await page.getByText('GPT-6-Sol',{exact:true}).waitFor();
  await page.getByText('Opus 5.5 [1M]',{exact:true}).waitFor();
  assert.equal(await page.getByText('Frontier intelligence for the most demanding work.',{exact:true}).count(),0);
  for(const theme of ['light','dark']){
   await page.evaluate(theme=>setTheme(theme),theme);
   for(const width of [320,390,1100]){
    await page.setViewportSize({width,height:1000});
    const rect=await page.getByText('GPT-6-Sol',{exact:true}).evaluate(n=>({client:n.clientWidth,scroll:n.scrollWidth}));
    assert.ok(rect.client>=rect.scroll);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:path.join(out,'model-menu-'+theme+'-'+width+'.png'),fullPage:true});
   }
  }
  for(const engine of ['claude','codex']){
   await page.evaluate(engine=>{setEngine(engine);setQueued(true);setWithdrawn(false)},engine);
   await page.waitForTimeout(100);
   assert.equal(await page.getByText('Pending unique prompt',{exact:true}).count(),0);
   await page.evaluate(()=>setQueued(false));
   await page.getByText('Pending unique prompt',{exact:true}).waitFor();
   assert.equal(await page.getByText('Pending unique prompt',{exact:true}).count(),1);
   await page.evaluate(()=>setWithdrawn(true));
   await page.waitForTimeout(100);
   assert.equal(await page.getByText('Pending unique prompt',{exact:true}).count(),0);
   assert.equal(await page.getByText('Original question',{exact:true}).count(),1);
   assert.equal(await page.getByText('Codex 已接收补充回复，将在当前工作中处理。',{exact:true}).count(),0);
   assert.equal(await page.getByText('补充回复尚未确认送达 Codex；未自动重复发送，请检查连接和后续回应。',{exact:true}).count(),1);
  }
  assert.deepEqual(errors,[]);
  console.log('PASS model menu names without descriptions at 320/390/1100 light/dark; actual ChatList hides queued prompt and restores once for both engines; repeated steer receipts hidden and delivery warnings preserved; no page errors');
  console.log('Artifacts: '+out);
 } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1});
