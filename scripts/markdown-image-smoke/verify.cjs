// Exercise the actual exported Metro modules, styles and icons with synthetic
// messages. No app bootstrap, authentication, browser profile or production API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(process.argv[2] || '/tmp/lmc-markdown-image-web');
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-markdown-image-check-'));
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
const preview = process.env.LMC_PREVIEW_SAMPLE ? fs.readFileSync(process.env.LMC_PREVIEW_SAMPLE).toString('base64') : 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1sAAAAASUVORK5CYII=';
const fixture = `
const init=modules.get(0); __r(init.deps[0]);__r(init.deps[1]);
const React=moduleExport('useState'),h=React.createElement,{createRoot}=moduleExport('createRoot');
const {MarkdownView}=moduleExport('MarkdownView'),{storage}=moduleExport('storage'),{apiSocket}=moduleExport('apiSocket');
const {UnistylesRuntime}=moduleExport('UnistylesRuntime');
window.setTheme=theme=>{UnistylesRuntime.setAdaptiveThemes(false);UnistylesRuntime.setTheme(theme);document.body.style.background=theme==='dark'?'#202020':'#fff'};
window.calls=[];window.fail=false;
const imageBytes=atob(${JSON.stringify(preview)});
apiSocket.sessionRPC=async(sid,method,params)=>{
 calls.push({sid,method,params});
 if(window.fail)return {success:false,error:'Missing fixture file'};
 const offset=params.offset||0,end=Math.min(offset+32769,imageBytes.length);
 return {success:true,name:'desktop.png',content:btoa(imageBytes.slice(offset,end)),size:imageBytes.length,revision:'fixture',nextOffset:end<imageBytes.length?end:null};
};
const local='/tmp/LMC Preview/desktop.png';
function App(){const [state,set]=React.useState({sid:'codex',url:'<'+local+'>'});window.renderPreview=next=>set(next);
 return h('main',{style:{maxWidth:850,margin:'24px auto',padding:'0 16px'}},h(MarkdownView,{markdown:'![Preview]('+state.url+')',sessionId:state.sid}));}
window.setSupported=(sid,supported)=>storage.setState({sessions:{...storage.getState().sessions,[sid]:{id:sid,metadata:{flavor:sid,sessionCapabilities:{resourceFiles:supported}}}}});
setSupported('codex',true);setSupported('claude',true);
createRoot(document.getElementById('root')).render(h(App));
`;
const fonts=fs.readdirSync(path.join(root,'assets/sources/assets/fonts')).filter(f=>f.startsWith('IBMPlexSans-')).map(f=>`@font-face{font-family:'${f.split('.')[0]}';src:url('/assets/sources/assets/fonts/${f}')}`).join('');
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fonts}body{margin:0;font-family:IBMPlexSans-Regular,Arial,sans-serif}</style><div id="root"></div>${scripts.map((s,i)=>`<script src="${s}"></script>${i===0?'<script src="/capture.js"></script>':''}`).join('')}<script src="/fixture.js"></script>`;
const server=http.createServer((req,res)=>{
 let content, type='text/javascript';
 if(req.url==='/'){content=html;type='text/html';}
 else if(req.url==='/capture.js')content=capture;
 else if(req.url==='/fixture.js')content=fixture;
 else if(req.url==='/pixel.png'){content=Buffer.from(preview,'base64');type='image/png';}
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
 try{
  const origin='http://127.0.0.1:'+server.address().port;
  const context=await browser.newContext({viewport:{width:390,height:1000},locale:'en-US'});
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const page=await context.newPage();page.setDefaultTimeout(5000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const loaded=async()=>page.waitForFunction(()=>[...document.querySelectorAll('main img')].some(img=>img.complete&&img.naturalWidth>0));
  await page.goto(origin);
  await page.getByText('Preview',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  try {await loaded();} catch {
   console.log('Image diagnostic',await page.evaluate(()=>({calls,images:[...document.querySelectorAll('main img')].map(img=>({src:img.src,width:img.naturalWidth}))})));
   throw new Error('Local Markdown image remained blank instead of loading through the session');
  }
  for(const sid of ['codex','claude']){
   await page.evaluate(sid=>renderPreview({sid,url:'</tmp/LMC Preview/'+sid+'.png>'}),sid);
   await page.waitForFunction(sid=>calls.some(c=>c.sid===sid&&c.params.path==='/tmp/LMC Preview/'+sid+'.png'),sid);
   await loaded();
   assert.equal(await page.locator('main img').evaluate(img=>img.src.startsWith('data:image/png;base64,')),true);
  }
  assert.ok((await page.evaluate(()=>calls)).every(c=>c.method==='resource-file'&&!c.params.path.includes('<')));
  const beforeRemote=await page.evaluate(()=>calls.length);
  await page.evaluate(url=>renderPreview({sid:'codex',url}),origin+'/pixel.png');
  await page.waitForFunction(url=>[...document.querySelectorAll('main img')].some(img=>img.src===url&&img.complete&&img.naturalWidth>0),origin+'/pixel.png');
  assert.equal(await page.evaluate(()=>calls.length),beforeRemote,'HTTP images must not be read from an Agent');
  await page.evaluate(()=>{window.fail=true;renderPreview({sid:'codex',url:'<file:///tmp/LMC%20Preview/missing.png>'})});
  const retry=page.getByRole('button',{name:/Retry|重试/});await retry.waitFor();
  await page.evaluate(()=>window.fail=false);await retry.click();await loaded();
  assert.ok((await page.evaluate(()=>calls)).some(c=>c.params.path==='/tmp/LMC Preview/missing.png'));
  for(const theme of ['light','dark']){
   await page.evaluate(theme=>setTheme(theme),theme);
   for(const width of [390,1200]){
    await page.setViewportSize({width,height:850});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:path.join(out,theme+'-'+width+'.png'),fullPage:true});
   }
  }
  const beforeUnsupported=await page.evaluate(()=>calls.length);
  await page.evaluate(()=>{setSupported('legacy',false);renderPreview({sid:'legacy',url:'</tmp/legacy.png>'})});
  await page.getByText(/safe refresh|刷新/).waitFor();assert.equal(await page.evaluate(()=>calls.length),beforeUnsupported);
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({calls:await page.evaluate(()=>calls),errors},null,2));
  console.log('PASS actual MarkdownView: both engines, local path with spaces, chunked image, HTTP, file URI, retry, capability gate, light/dark mobile/desktop');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exit(1)});
