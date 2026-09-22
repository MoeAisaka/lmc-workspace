// Exercise the actual exported Metro modules, styles and icons with synthetic
// messages. No app bootstrap, authentication, browser profile or production API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(process.argv[2] || '/tmp/lmc-d21-web');
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-d21-check-'));
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
const init=modules.get(0);__r(init.deps[0]);__r(init.deps[1]);
const React=moduleExport('useState'),h=React.createElement,{createRoot}=moduleExport('createRoot');
const {EngineLoginPanel}=moduleExport('EngineLoginPanel');
const {UnistylesRuntime}=moduleExport('UnistylesRuntime'),{useUnistyles}=moduleExport('useUnistyles');
const base={id:'fixture',sourceSessionId:'session',engine:'claude',method:'authorizationCode',state:'waiting',expiresAt:Date.now()+600000,authorizationUrl:'https://claude.com/oauth/authorize?state=synthetic-only',sessions:[]};
function App(){
 const [flow,setFlow]=React.useState(base),[online,setOnline]=React.useState(true),[error,setError]=React.useState(undefined);
 const {theme}=useUnistyles();
 window.setScenario=(next)=>{setFlow({...base,...next});setError(undefined);setOnline(true)};
 window.setOnline=setOnline;window.setError=setError;
 window.setPreviewTheme=name=>{UnistylesRuntime.setAdaptiveThemes(false);UnistylesRuntime.setTheme(name)};
 window.actionEvents??=[];
 const action=(action,extra)=>{window.actionEvents.push({action,extra});if(action==='submit')setFlow({...flow,state:'submitting'});if(action==='cancel')setFlow({...flow,state:'cancelled',error:'cancelled',authorizationUrl:undefined});};
 return h('div',{style:{height:'100vh',display:'flex',background:theme.dark?'#191919':'#F3F4F6'}},h(EngineLoginPanel,{engine:flow.engine,host:'MacMini',flow,error,online,onAction:action,onClose:()=>window.closed=true}));
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
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);await page.getByTestId('engine-login-panel').waitFor();
  await page.getByTestId('engine-login-qr').waitFor();
  assert.equal(await page.getByTestId('engine-login-has-code').count(),1);
  await page.screenshot({path:path.join(out,'desktop-light.png'),fullPage:true});
  await page.getByTestId('engine-login-has-code').click();
  await page.getByTestId('engine-login-code').fill('synthetic_code#state');
  await page.getByTestId('engine-login-submit').click();
  assert.equal(await page.getByTestId('engine-login-code').inputValue(),'');
  assert.deepEqual(await page.evaluate(()=>actionEvents.at(-1)),{action:'submit',extra:{id:'fixture',code:'synthetic_code#state'}});
  await page.evaluate(()=>setScenario({id:'codex',engine:'codex',method:'deviceCode',authorizationUrl:'https://auth.openai.com/codex/device',userCode:'DEMO-12345'}));
  await page.getByTestId('engine-login-device-code').waitFor();
  assert.equal(await page.getByTestId('engine-login-code').count(),0);
  assert.equal(await page.getByTestId('engine-login-has-code').count(),0);
  await page.screenshot({path:path.join(out,'desktop-codex.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{setScenario({id:'phone'});setPreviewTheme('dark')});
  await page.waitForTimeout(200);
  assert.equal(await page.getByTestId('engine-login-qr').count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(out,'mobile-dark.png'),fullPage:true});
  await page.getByTestId('engine-login-has-code').click();
  await page.screenshot({path:path.join(out,'mobile-code.png'),fullPage:true});
  await page.setViewportSize({width:320,height:640});await page.evaluate(()=>{setPreviewTheme('light');setScenario({id:'recover',state:'recovering',authorizationUrl:undefined,sessions:[{sessionId:'a',state:'restored',requestedAt:0},{sessionId:'b',state:'waiting',requestedAt:0},{sessionId:'c',state:'failed',requestedAt:0}]})});
  await page.getByTestId('engine-login-restored').waitFor();
  assert.equal(await page.getByTestId('engine-login-waiting').count(),1);
  assert.equal(await page.getByTestId('engine-login-failed').count(),1);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(out,'narrow-recovery.png'),fullPage:true});
  for(const error of ['expired','cancelled','invalidCode','unknown','upgrade','unsupported']){
    await page.evaluate(error=>setScenario({id:error,state:['expired','cancelled'].includes(error)?error:'failed',error,authorizationUrl:undefined}),error);
    await page.getByTestId('engine-login-error').waitFor();
    assert.equal(await page.getByTestId('engine-login-open').count(),0);
  }
  await page.evaluate(()=>{setScenario({id:'offline'});setOnline(false)});await page.waitForTimeout(100);
  assert.match(await page.getByTestId('engine-login-error').innerText(),/unavailable/);
  assert.equal(await page.getByTestId('engine-login-open').count(),0);
  await page.evaluate(()=>setScenario({id:'evil',authorizationUrl:'https://claude.com.evil.test/oauth/authorize'}));await page.waitForTimeout(100);
  assert.equal(await page.getByTestId('engine-login-qr').count(),0);
  assert.equal(await page.getByTestId('engine-login-open').count(),0);
  assert.deepEqual(errors,[]);
  console.log('PASS D21 exported Web: desktop QR, phone layout, dark/light, code clearing, engine capabilities, recovery states, offline/timeout/legacy errors, URL allowlist; no browser errors');
  console.log('Artifacts: '+out);
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1});
