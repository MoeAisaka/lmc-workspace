// Exercise the actual exported Metro modules, styles and icons with synthetic
// messages. No app bootstrap, authentication, browser profile or production API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(process.argv[2] || '/tmp/lmc-attachments-web');
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-attachments-check-'));
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
const {MMKV}=moduleExport('MMKV');new MMKV().set('settings',JSON.stringify({settings:{preferredLanguage:'en',agentInputEnterToSend:true},version:1}));
const {AgentInput}=moduleExport('AgentInput');
const {sync}=moduleExport('sync'),{storage}=moduleExport('storage');
const {SafeAreaProvider}=moduleExport('SafeAreaProvider'),{GestureHandlerRootView}=moduleExport('GestureHandlerRootView');
const {UnistylesRuntime}=moduleExport('UnistylesRuntime');
window.setTheme=theme=>{UnistylesRuntime.setAdaptiveThemes(false);UnistylesRuntime.setTheme(theme);document.body.style.background=theme==='dark'?'#202020':'#fff'};
window.wire=[];window.uploaded=[];window.micCalls=0;window.abortCalls=0;window.sendCalls=0;
// Only transport boundaries are replaced. sendMessage itself is the real app path.
sync.encryption={getSessionEncryption:()=>({encryptRawRecord:async record=>{window.wire.push(record);return 'fixture-'+window.wire.length}})};
sync.uploadAttachmentsForSession=async (id,list)=>{window.uploaded.push(...list);return {uploaded:list.map(file=>({...file,ref:'fixture/'+file.name})),failed:0}};
sync.enqueueMessages=()=>{};
sync.getSendSync=()=>({invalidate:()=>{},invalidateAndAwait:async()=>{}});
sync.maybeStartBackgroundSendWatchdog=()=>{};
const files={
 image:{id:'image',name:'sample.png',uri:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',mimeType:'image/png',width:1,height:1,size:70},
 pdf:{id:'pdf',name:'sample.pdf',uri:'data:application/pdf;base64,JVBERi0xLjcK',mimeType:'application/pdf',width:0,height:0,size:9},
 docx:{id:'docx',name:'sample.docx',uri:'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,UEsDBA==',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',width:0,height:0,size:4},
};
function App(){
 const [cfg,setCfg]=React.useState({engine:'codex',kind:'image',busy:false}),input=React.useRef(null);
 window.setScenario=next=>{window.wire=[];window.uploaded=[];window.micCalls=0;window.abortCalls=0;window.sendCalls=0;window.delivery=null;setCfg(next);const text=next.text??'';input.current?.setTextAndSelection(text,{start:text.length,end:text.length})};
 const attachments=files[cfg.kind]?[files[cfg.kind]]:[];
 const metadata={flavor:cfg.engine,version:'1.2.54',sessionCapabilities:{fileInbox:true,turnQueue:true,turnQueueLifecycle:true}};
 storage.setState({sessions:{'attachment-fixture':{id:'attachment-fixture',createdAt:1000,active:true,thinking:cfg.busy,metadata}},machines:{}});
 const onSend=()=>{window.sendCalls++;window.delivery=sync.sendMessage('attachment-fixture',input.current.getText(),{attachments,intent:cfg.busy?'queue':undefined})};
 return h(SafeAreaProvider,{initialMetrics:{frame:{x:0,y:0,width:innerWidth,height:innerHeight},insets:{top:0,bottom:0,left:0,right:0}}},
  h(GestureHandlerRootView,{style:{flex:1}},h('main',{id:'composer',style:{maxWidth:850,margin:'40px auto'}},
   h(AgentInput,{ref:input,initialValue:'',placeholder:'Message',metadata,onSend,selectedImages:attachments,onRemoveImage:()=>setCfg({...cfg,kind:'none'}),
    onAbort:()=>{window.abortCalls++},showAbortButton:cfg.busy,blockSend:cfg.blocked,isSendDisabled:cfg.disabled,isSending:cfg.sending,
    onMicPress:cfg.voice?()=>{window.micCalls++}:undefined,showStatusDetails:false}))));
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
  const context=await browser.newContext({viewport:{width:1100,height:900},locale:'en-US'});
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  const input=page.getByPlaceholder('Message',{exact:true});await input.waitFor();
  // This fails against v179: Enter checks text only, despite a selected image.
  await input.press('Enter');await page.evaluate(async()=>{await window.delivery});
  assert.equal(await page.evaluate(()=>wire.length),2,'attachment-only Enter must emit a file event and its empty-text submit');
  const send=page.getByRole('button',{name:'Send',exact:true});
  const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const scenario=async cfg=>{await page.evaluate(cfg=>setScenario(cfg),cfg);await settle()};
  const color=()=>send.evaluate(node=>getComputedStyle(node.parentElement).backgroundColor);
  const verifyWire=async (kind,busy,text='')=>{
   await page.evaluate(async()=>{await window.delivery});
   const result=await page.evaluate(()=>({wire,uploaded,sendCalls,micCalls,abortCalls}));
   assert.equal(result.sendCalls,1);assert.equal(result.micCalls,0);assert.equal(result.abortCalls,0);
   assert.equal(result.uploaded.length,1);assert.equal(result.uploaded[0].name,'sample.'+(kind==='image'?'png':kind));
   assert.equal(result.wire.length,2);
   assert.equal(result.wire[0].role,'session');assert.equal(result.wire[0].content.data.ev.t,'file');
   assert.equal(result.wire[1].role,'user');assert.equal(result.wire[1].content.text,text,'no filler caption');
   assert.equal(result.wire[1].meta.intent,busy?'queue':undefined);
   if(busy)assert.equal(result.wire[0].meta.queueKey,result.wire[1].meta.queueKey);
  };
  const cases=[];
  for(const engine of ['codex','claude'])for(const theme of ['light','dark'])for(const width of [390,1100]) {
   await page.setViewportSize({width,height:900});await page.evaluate(theme=>setTheme(theme),theme);
   await scenario({engine,kind:'none'});assert.equal(await send.isDisabled(),true);const inactive=await color();
   await scenario({engine,kind:'none',text:'Hello'});const active=await color();assert.notEqual(active,inactive);
   for(const kind of ['image','pdf','docx'])for(const busy of [false,true]) {
    await scenario({engine,kind,busy});assert.equal(await send.isEnabled(),true);assert.equal(await color(),active);
    await send.click();await verifyWire(kind,busy);
    await scenario({engine,kind,busy});await input.press('Enter');await verifyWire(kind,busy);
    cases.push({engine,theme,width,kind,busy,click:true,enter:true});
   }
   await page.screenshot({path:path.join(out,engine+'-'+theme+'-'+width+'.png'),fullPage:true});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  for(const guard of ['blocked','disabled','sending']) {
   await scenario({engine:'codex',kind:'pdf',[guard]:true});
   await input.press('Enter');await page.evaluate(async()=>{await window.delivery});
   assert.equal(await page.evaluate(()=>sendCalls),0,'send guard '+guard);
  }
  await scenario({engine:'claude',kind:'image',voice:true});
  assert.equal(await send.isEnabled(),true);await send.click();await verifyWire('image',false);
  await scenario({engine:'codex',kind:'docx',text:'  \n '});await send.click();await verifyWire('docx',false,'  \n ');
  await scenario({engine:'codex',kind:'image'});await input.press('Shift+Enter');
  assert.equal(await page.evaluate(()=>sendCalls),0,'Shift+Enter remains newline');
  // Touch browsers keep Enter as a newline and send attachments using the button.
  const phone=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await phone.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const touch=await phone.newPage();touch.on('pageerror',e=>errors.push(e.message));await touch.goto('http://127.0.0.1:'+server.address().port);
  await touch.getByPlaceholder('Message',{exact:true}).press('Enter');
  assert.equal(await touch.evaluate(()=>sendCalls),0);
  await touch.getByRole('button',{name:'Send',exact:true}).tap();await touch.evaluate(async()=>{await window.delivery});
  assert.equal(await touch.evaluate(()=>wire.length),2);assert.equal(await touch.evaluate(()=>wire[1].content.text.trim()),'');
  await phone.close();
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({cases,guards:true,voice:true,whitespace:true,shiftEnter:true,touch:true,errors},null,2));
  console.log('PASS actual AgentInput → sync.sendMessage: 48 engine/theme/width/type/busy cases, click/Enter, blank caption, file ordering and queue linkage; guards, dictation priority, Shift+Enter and touch');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exit(1)});
