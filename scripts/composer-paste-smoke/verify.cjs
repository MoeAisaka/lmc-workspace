// Exercise the actual exported Metro modules, styles and icons with synthetic
// messages. No app bootstrap, authentication, browser profile or production API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(process.argv[2] || '/tmp/lmc-steer-paste-web');
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-paste-check-'));
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
const {SafeAreaProvider}=moduleExport('SafeAreaProvider'),{GestureHandlerRootView}=moduleExport('GestureHandlerRootView');
window.added=[];window.pasteEvents=[];
document.addEventListener('paste',event=>{const sample={trusted:event.isTrusted,sync:event.clipboardData.files.length};window.pasteEvents.push(sample);setTimeout(()=>sample.after=event.clipboardData.files.length,0)},true);
function App(){
 const [files,setFiles]=React.useState([]),[engine,setEngine]=React.useState('codex');
 window.reset=next=>{window.added=[];window.pasteEvents=[];setFiles([]);setEngine(next||'codex')};
 const add=React.useCallback(next=>{window.added.push(...next);setFiles(current=>[...current,...next])},[]);
 return h(SafeAreaProvider,{initialMetrics:{frame:{x:0,y:0,width:innerWidth,height:innerHeight},insets:{top:0,bottom:0,left:0,right:0}}},
 h(GestureHandlerRootView,{style:{flex:1}},h('main',{id:'composer',style:{maxWidth:850,margin:'40px auto'}},
 h(AgentInput,{initialValue:'',placeholder:'Message',metadata:{flavor:engine},onSend:()=>{},selectedImages:files,onAddImages:add,onRemoveImage:()=>setFiles([]),showStatusDetails:false}))));
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
 const browser=await chromium.launch({headless:true,executablePath:process.env.LMC_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disk-cache-size=0','--renderer-process-limit=4','--disable-extensions']});
 try {
  const origin='http://127.0.0.1:'+server.address().port;
  const context=await browser.newContext({viewport:{width:1100,height:900},permissions:['clipboard-read','clipboard-write']});
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin);const input=page.getByPlaceholder('Message',{exact:true});await input.waitFor();
  const cdp=await context.newCDPSession(page);
  const paste=async()=>{await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'v',code:'KeyV',windowsVirtualKeyCode:86,modifiers:2,commands:['Paste']});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'v',code:'KeyV',windowsVirtualKeyCode:86,modifiers:2})};
  const putImage=()=>page.evaluate(async()=>{const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;const ctx=canvas.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,16,16);const blob=await new Promise(resolve=>canvas.toBlob(resolve));await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);});
  const results=[];
  for(const engine of ['codex','claude']) {
   await page.evaluate(engine=>reset(engine),engine);await input.fill('caption');
   await putImage();await input.focus();await paste();
   try{await page.waitForFunction(()=>added.length===1,{},{timeout:3000})}catch{
    console.log('Native paste diagnostics:',await page.evaluate(()=>({added:added.length,pasteEvents})));
    throw new Error('Keyboard paste did not produce an image attachment');
   }
   assert.equal(await input.inputValue(),'caption');
   const image=await page.evaluate(()=>({name:added[0].name,type:added[0].mimeType,width:added[0].width,height:added[0].height,events:pasteEvents}));
   assert.equal(image.type,'image/png');assert.equal(image.width,16);assert.equal(image.height,16);assert.equal(image.events[0].trusted,true);
   results.push({engine,image});
   await page.evaluate(()=>reset());await input.fill('');await page.evaluate(()=>navigator.clipboard.writeText('plain pasted text'));await input.focus();await paste();
   await page.waitForFunction(()=>document.querySelector('textarea').value==='plain pasted text');assert.equal(await page.evaluate(()=>added.length),0);
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({results,errors},null,2));
  await page.screenshot({path:path.join(out,'composer.png')});
  console.log('PASS actual composer: trusted keyboard paste adds one image; plain text paste remains native for both engines');
 }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exit(1)});
