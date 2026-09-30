// Exercise the actual exported Metro modules, styles and icons with synthetic
// messages. No app bootstrap, authentication, browser profile or production API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(process.argv[2] || '/tmp/lmc-native-web-v230');
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-native-ui-check-'));
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
const {openClaudeNative}=moduleExport('openClaudeNative'),{ModalProvider}=moduleExport('ModalProvider');
const {storage}=moduleExport('storage'),{apiSocket}=moduleExport('apiSocket'),{UnistylesRuntime}=moduleExport('UnistylesRuntime');
const {MMKV}=moduleExport('MMKV');new MMKV().set('settings',JSON.stringify({settings:{preferredLanguage:'zh-Hans'},version:1}));
storage.getState().applySettingsLocal({preferredLanguage:'zh-Hans'});
UnistylesRuntime.setAdaptiveThemes(false);UnistylesRuntime.setTheme(new URLSearchParams(location.search).get('theme')||'light');
window.calls=[];window.offline=false;window.stale=false;window.native={active:false,epoch:'fixture_epoch',revision:1,ownsInput:false,exited:false,phase:'starting',lines:['Native authorization','1. Allow test application','2. Cancel','A long native line '+'.'.repeat(170)]};
apiSocket.sessionRPC=async(sid,method,params)=>{
 calls.push({sid,method,params});if(offline)throw Error('RPC target disconnected');
 if(params.action==='start'){native.active=true;return{starting:true}}
 if(params.action==='claim'){native.ownsInput=true;return{...native}}
 if(params.action==='release'){native.ownsInput=false;return{ok:true}}
 if(params.action==='screen')return{...native};
 if(params.action==='input'){
  await new Promise(r=>setTimeout(r,150));
  if(stale||params.revision!==native.revision)throw Error('Terminal changed; read latest screen');
  native.revision++;native.lines=['Authorization explicitly confirmed'];return{revision:native.revision};
 }
 if(params.action==='leave'){native.active=false;return{ok:true}}
};
createRoot(document.getElementById('root')).render(h(ModalProvider,null,h('button',{onClick:()=>openClaudeNative('claude-fixture')},'Open native')));
`;
const fonts=fs.readdirSync(path.join(root,'assets/sources/assets/fonts')).filter(f=>f.startsWith('IBMPlexSans-')).map(f=>`@font-face{font-family:'${f.split('.')[0]}';src:url('/assets/sources/assets/fonts/${f}')}`).join('');
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fonts}body{margin:0;font-family:IBMPlexSans-Regular,Arial,sans-serif}</style><div id="root"></div>${scripts.map((s,i)=>`<script src="${s}"></script>${i===0?'<script src="/capture.js"></script>':''}`).join('')}<script src="/fixture.js"></script>`;
const server=http.createServer((req,res)=>{
 let content, type='text/javascript';
 if(req.url.split('?')[0]==='/'){content=html;type='text/html';}
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
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disk-cache-size=0','--renderer-process-limit=4','--disable-extensions']});
 try {
  const origin='http://127.0.0.1:'+server.address().port;
  const context=await browser.newContext();
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const page=await context.newPage();page.setDefaultTimeout(5000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const button=name=>page.getByRole('button',{name,exact:true});
  for(const theme of ['light','dark'])for(const size of [{width:320,height:568},{width:667,height:390},{width:1280,height:900}]) {
   await page.setViewportSize(size);await page.goto(origin+'/?theme='+theme);
   await button('Open native').click();await button('空闲时开启原生模式').click();
   await page.getByTestId('native-screen').getByText('Native authorization',{exact:false}).waitFor();
   assert.equal(await page.evaluate(()=>calls.filter(c=>c.params.action==='input').length),0,'Reading a prompt must not confirm it');
   const bounds=await page.getByTestId('claude-native-dialog').boundingBox();
   assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=size.width+1&&bounds.y+bounds.height<=size.height+1,'Dialog fits viewport');
   for(const name of ['关闭','回车','确认编号','仅粘贴','空闲时退出原生模式']){const b=await button(name).boundingBox();assert.ok(b.x>=0&&b.x+b.width<=size.width+1&&b.y+b.height<=size.height+1,name+' fits viewport');}
   await page.screenshot({path:path.join(out,theme+'-'+size.width+'.png')});
   await page.getByRole('textbox',{name:'原生菜单编号'}).fill('1');
   await button('确认编号').dblclick();await page.getByTestId('native-screen').getByText('Authorization explicitly confirmed').waitFor();
   assert.equal(await page.evaluate(()=>calls.filter(c=>c.params.action==='input').length),1,'Double click must send only one input');
   const sent=await page.evaluate(()=>calls.find(c=>c.params.action==='input').params);assert.equal(sent.epoch,'fixture_epoch');assert.equal(sent.revision,1);assert.deepEqual(sent.input,{type:'choice',choice:1});
   await page.evaluate(()=>window.stale=true);await button('回车').click();await page.getByTestId('native-error').getByText(/Terminal changed/).waitFor();
   await button('关闭').click();await page.getByTestId('claude-native-dialog').waitFor({state:'detached'});
   assert.equal(await page.evaluate(()=>calls.filter(c=>c.params.action==='leave').length),0,'Closing panel must not exit process');
   await button('Open native').click();await page.getByTestId('native-screen').getByText('Authorization explicitly confirmed').waitFor();
   assert.equal(await page.evaluate(()=>calls.filter(c=>c.params.action==='start').length),1,'Reopen must not restart native Claude');
   await page.evaluate(()=>window.offline=true);await page.getByTestId('native-error').getByText(/disconnected/).waitFor();assert.equal(await button('回车').isDisabled(),true);
   await page.evaluate(()=>window.offline=false);await page.waitForFunction(()=>!document.body.innerText.includes('RPC target disconnected'));assert.equal(await button('回车').isEnabled(),true);
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({cases:6,errors}));
  console.log('PASS native controls: responsive light/dark, no autoapproval, one input on double click, versioned input, stale rejection, panel close/reconnect retains process, offline disables input');
 } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1});
