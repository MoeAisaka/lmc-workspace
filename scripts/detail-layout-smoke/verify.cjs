// Exercise the actual exported Metro modules, styles and icons with synthetic
// messages. No app bootstrap, authentication, browser profile or production API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(process.argv[2] || '/tmp/lmc-detail-v257');
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-detail-check-'));
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
  let cases=0;
  for (const theme of ['light','dark']) for (const size of [{width:320,height:568},{width:390,height:844},{width:667,height:390},{width:1280,height:900}]) for (const engine of ['claude','codex']) {
   await page.setViewportSize(size);
   await page.goto(origin+'/?theme='+theme+'&engine='+engine);
   const receipt=page.getByTestId('receipt'); await receipt.getByText(/review fixture/).waitFor();
   const overflow=await receipt.evaluate(el => [...el.querySelectorAll('*')].filter(n=>n.scrollWidth>n.clientWidth+1).map(n=>({tag:n.tagName,text:n.textContent.slice(0,60)})));
   assert.deepEqual(overflow,[], 'Receipt wraps without hidden clipping');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.evaluate(()=>showTool('short'));
   const card=page.getByTestId('session-tool-overlay'); await card.waitFor(); await page.waitForTimeout(250);
   const short=await card.boundingBox();
   await page.screenshot({path:path.join(out,'short-'+theme+'-'+size.width+'-'+engine+'.png')});
   assert.ok(short.x>=11 && short.x+short.width<=size.width-11,'Horizontal gutters');
   assert.ok(short.height<(size.height-64)*.76,'Compact height limit');
   await page.getByRole('button',{name:'展开或收起步骤时间'}).click();
   await page.getByTestId('tool-timeline-timing').getByText(/开始/).waitFor();
   await page.getByRole('button',{name:'展开或收起步骤时间'}).click();
   await page.evaluate(()=>showTool('long')); await page.waitForTimeout(250);
   const long=await card.boundingBox();
   assert.deepEqual(await card.evaluate(el=>[...el.querySelectorAll('[dir=auto]')].filter(n=>!n.className.includes('r-1udbk01') && n.scrollWidth>n.clientWidth+1 && getComputedStyle(n).textOverflow!=='ellipsis').map(n=>n.textContent.slice(0,40))),[], 'Details text wraps within bounds');
   assert.ok(long.height<=(size.height-64)*.76,'Long details capped');
   const scroll=page.getByTestId('tool-detail-scroll');
   assert.ok(await scroll.evaluate(el=>el.scrollHeight>el.clientHeight),'Long details scroll internally');
   await scroll.evaluate(el=>{el.scrollTop=el.scrollHeight});
   assert.ok(await scroll.evaluate(el=>el.scrollTop>0),'Scroll reaches output');
   await page.screenshot({path:path.join(out,theme+'-'+size.width+'-'+engine+'.png')});
   await page.getByRole('button',{name:'关闭',exact:true}).click(); await card.waitFor({state:'detached'});
   assert.equal(await receipt.getByText(/review fixture/).count(),1,'Transcript survives close'); cases++;
  }
  await page.clock.install();
  await page.goto(origin+'/?recovery=1'); await page.getByText('已处理的排队指令',{exact:true}).waitFor();
  await page.evaluate(()=>window.failRecovery=true); await page.clock.runFor(15001);
  assert.equal(await page.getByText('已处理的排队指令',{exact:true}).count(),1,'Offline retains unconfirmed prompt');
  await page.evaluate(()=>window.failRecovery=false); await page.clock.runFor(30001);
  await page.getByText('排队已确认',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>recoveryCursors()),[128100,128000],'Recovery leaves history cursors intact');
  assert.equal(await page.evaluate(()=>reads.length),2);
  await page.clock.runFor(60000);assert.equal(await page.evaluate(()=>reads.length),2,'Stops after receipt');cases++;
  await page.goto(origin+'/?recovery=1'); await page.getByText('已处理的排队指令',{exact:true}).waitFor();
  await page.evaluate(()=>setRecoveryFocus(false));await page.clock.runFor(60000);
  assert.equal(await page.evaluate(()=>reads.length),0,'Hidden chat does not scan');
  await page.evaluate(()=>setRecoveryFocus(true));await page.clock.runFor(15001);await page.getByText('排队已确认',{exact:true}).waitFor();cases++;
  assert.deepEqual(errors,[]); assert.deepEqual(external,[]);
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({cases,errors,external},null,2));
  console.log('PASS '+cases+' responsive detail/receipt cases');
 } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode=1; });
