// Exercise the actual exported Metro modules, styles and icons with synthetic
// messages. No app bootstrap, authentication, browser profile or production API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(process.argv[2] || '/tmp/lmc-native-approval-v256');
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-native-approval-check-'));
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
const fixture = fs.readFileSync(path.join(__dirname, 'fixture.js'), 'utf8');
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

(async () => {
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const browser = await chromium.launch({headless:true, executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args:['--disk-cache-size=0','--renderer-process-limit=4','--disable-extensions']});
 try {
  const origin = 'http://127.0.0.1:' + server.address().port;
  const context = await browser.newContext();
  const external = [], errors = [];
  await context.route('**/*', route => {
   if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
   external.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  const card = page.getByTestId('native-app-approval');
  const button = name => page.getByRole('button', {name, exact:true});
  const inputCount = () => page.evaluate(() => calls.filter(call => call.params.action === 'input').length);
  const open = async (query='') => { await page.goto(origin+'/?'+query); await card.waitFor(); };
  let cases = 0;
  for (const theme of ['light','dark']) for (const size of [{width:320,height:568},{width:667,height:390},{width:1280,height:900}]) {
   await page.setViewportSize(size); await open('theme='+theme);
   assert.equal(await page.getByText(/无进展/).count(), 0, 'The actionable request replaces the misleading no-progress card');
   assert.equal(await page.evaluate(() => calls.some(call => call.params.action !== 'screen')), false, 'Discovery must be read-only');
   assert.equal(await page.getByTestId('native-approval-apps').innerText(), '钉钉');
   const bounds = await card.boundingBox();
   assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x+bounds.width <= size.width+1 && bounds.y+bounds.height <= size.height+1, 'Card fits viewport');
   for (const name of ['允许本次会话','拒绝','查看原生窗口','查看完整申请']) {
    const b = await button(name).boundingBox();
    assert.ok(b.x>=bounds.x && b.x+b.width<=bounds.x+bounds.width+1 && b.y+b.height<=bounds.y+bounds.height+1, name+' remains inside the card');
   }
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'No horizontal overflow');
   await page.screenshot({path:path.join(out,theme+'-'+size.width+'.png')});
   await button('查看完整申请').click(); await page.getByTestId('native-approval-raw').waitFor();
   assert.match(await page.getByTestId('native-approval-raw').innerText(), /2 other apps will be hidden/);
   await button('收起申请').click();
   await page.reload(); await card.waitFor(); assert.equal(await inputCount(),0,'Reload does not choose');
   const deny = size.width === 667;
   await button(deny ? '拒绝' : '允许本次会话').dblclick(); await card.waitFor({state:'detached'});
   assert.equal(await inputCount(),1,'Double tap submits only once');
   const sent = await page.evaluate(() => calls.find(call => call.params.action==='input').params);
   assert.equal(sent.epoch,'fixture_epoch'); assert.equal(sent.revision,7);
   assert.deepEqual(sent.input,{type:'choice',choice:deny?1:2});
   assert.equal(await page.evaluate(() => calls.some(call => ['start','leave'].includes(call.params.action))),false);
   cases++;
  }
  await page.setViewportSize({width:390,height:844}); await open();
  await page.evaluate(() => window.changed=true); await button('允许本次会话').click();
  await page.getByTestId('native-approval-apps').getByText('Calendar',{exact:true}).waitFor();
  assert.equal(await inputCount(),0,'Changed app must never receive the old click'); cases++;

  await page.evaluate(() => setConnected(false)); await page.getByTestId('native-approval-status').getByText(/等待恢复连接/).waitFor();
  assert.equal(await button('允许本次会话').isDisabled(),true);
  await page.evaluate(() => setConnected(true)); await page.waitForFunction(() => !document.body.innerText.includes('等待恢复连接')); cases++;

  await page.evaluate(() => setPrompt('unknown'));
  await page.getByTestId('native-approval-raw').getByText(/Allow clipboard access/).waitFor();
  assert.equal(await button('允许本次会话').count(),0,'Unknown additional scope requires native review');
  await button('查看原生窗口').click(); await page.getByTestId('claude-native-dialog').waitFor();
  await page.getByTestId('native-screen').getByText(/Allow clipboard access/).waitFor();
  await button('关闭').click(); await page.getByTestId('claude-native-dialog').waitFor({state:'detached'});
  assert.equal(await inputCount(),0); assert.equal(await page.evaluate(() => calls.some(call => call.params.action==='leave')),false); cases++;

  await open(); await page.evaluate(() => window.lostReply=true); await button('允许本次会话').click();
  await page.getByTestId('native-approval-status').getByText(/提交结果尚未确认/).waitFor();
  assert.equal(await button('允许本次会话').isDisabled(),true); assert.equal(await inputCount(),1);
  await page.reload(); await card.waitFor(); assert.equal(await button('允许本次会话').isDisabled(),true);
  assert.equal(await inputCount(),0,'Reload must not resend an uncertain choice');
  await page.evaluate(() => setPrompt('done')); await card.waitFor({state:'detached'}); cases++;

  await open(); await page.evaluate(() => setVisible(false)); await card.waitFor({state:'detached'});
  const hiddenCalls = await page.evaluate(() => calls.length);
  await page.waitForTimeout(2300);
  assert.equal(await page.evaluate(() => calls.length),hiddenCalls,'Hidden navigation screens stop polling');
  await page.evaluate(() => setVisible(true)); await card.waitFor(); assert.equal(await inputCount(),0); cases++;

  for (const query of ['engine=codex','legacy=1']) {
   await page.goto(origin+'/?'+query); await page.getByText(/无进展/).waitFor();
   assert.equal(await card.count(),0); assert.equal(await page.evaluate(() => calls.length),0,'Unsupported engine/capability must make no native RPC'); cases++;
  }
  assert.deepEqual(errors,[]); assert.deepEqual(external,[]);
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({cases,errors,external},null,2));
  console.log('PASS '+cases+' cases: responsive themes, explicit scoped allow/deny, read-only discovery, one write, request change, offline, reload/uncertain receipt, native fallback, dual-engine capability gate');
 } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode=1; });
