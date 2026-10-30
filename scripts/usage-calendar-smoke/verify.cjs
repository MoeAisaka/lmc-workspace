// Actual Metro export, synthetic records, isolated browser; no production API.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.LMC_PLAYWRIGHT_MODULE||'playwright-core');
const root=path.resolve(process.argv[2]),out=path.resolve(process.argv[3]);fs.mkdirSync(out,{recursive:true});
const original=fs.readFileSync(path.join(root,'index.html'),'utf8');
const scripts=[...original.matchAll(/<script src="([^"]+)"/g)].map(m=>m[1]),main=scripts.at(-1);
const capture=`window.modules=new Map();const define=window.__d;window.__d=(f,id,deps)=>{modules.set(id,{factory:f,deps});define(f,id,deps)};
window.moduleExport=name=>{for(const[id,m]of modules)if(m.factory.toString().includes(name)){const e=__r(id);if(e[name])return e}throw Error('Missing export '+name)};`;
const fixture=`
const init=modules.get(0);__r(init.deps[0]);__r(init.deps[1]);
const React=moduleExport('useState'),h=React.createElement,{createRoot}=moduleExport('createRoot');
const {UsageDashboard}=moduleExport('UsageDashboard'),{AccountQuotaCards}=moduleExport('AccountQuotaCards');
const {UnistylesRuntime}=moduleExport('UnistylesRuntime');
const now=new Date(2026,9,18,13,30).getTime(),records=[];
for(const month of [8,9])for(let day=1;day<=(month===9?18:30);day++)for(const engine of ['claude','codex'])records.push({
 key:'u2:'+engine+':'+month+':'+day,sessionId:engine,machineId:engine==='claude'?'mini':'book',engine,model:engine+'-'+(month+1)+'-'+day,
 occurredAt:new Date(2026,month,day,12,10).getTime(),tokens:{input:day*1000,output:day*200,cacheRead:day*4000,cacheWrite:day*100}});
records.push({key:'early',sessionId:'codex',machineId:'book',engine:'codex',model:'early-model',occurredAt:new Date(2026,9,18,9,15).getTime(),tokens:{input:900,output:100,cacheRead:300,cacheWrite:0}});
const quota={providers:['codex','claude'].map((engine,i)=>({engine,plan:'pro',capturedAt:now-60000,refreshFailed:false,stale:false,resetCredits:null,
 windows:[{id:'five_hour',remaining:70,resetsAt:now+(i?1:2)*3600000,durationMins:300,pending:false},{id:'seven_day',remaining:60,resetsAt:now+3*86400000,durationMins:10080,pending:false}]}))};
window.setTheme=theme=>{UnistylesRuntime.setAdaptiveThemes(false);UnistylesRuntime.setTheme(theme);document.body.style.background=theme==='dark'?'#141414':'#fff'};
function App(){const[period,setPeriod]=React.useState('month'),[month,setMonth]=React.useState(0),[stale,setStale]=React.useState(false);
 window.fixtureStale=()=>setStale(true);window.fixtureRecords=records;window.fixtureNow=now;
 const snapshot={providers:quota.providers.map(p=>({...p,stale}))};
 return h('div',{style:{height:'100dvh',width:'100%'}},h(UsageDashboard,{records,now,loading:false,error:null,collectedSince:new Date(2026,8,1).getTime(),updatedAt:now,
 period,onPeriod:setPeriod,monthOffset:month,onMonth:setMonth,quotaSnapshot:snapshot,onRefresh:()=>{},
 sessionNames:{claude:'Claude 方案与文案复审',codex:'Codex 功能开发与验证'},machineNames:{mini:'MacMini',book:'MacBook'},onSession:()=>{},
 aiTraffic:[],quota:h(AccountQuotaCards,{snapshot,now,loading:false,failed:false,available:true,onRefresh:()=>{}})}));}
createRoot(document.getElementById('root')).render(h(App));`;
const css=[...original.matchAll(/<link[^>]+href="([^" ]+\.css)"[^>]*>/g)].map(m=>`<link rel="stylesheet" href="${m[1]}">`).join('');
const fonts=fs.readdirSync(path.join(root,'assets/sources/assets/fonts')).filter(f=>f.startsWith('IBMPlexSans-')||f.startsWith('IBMPlexMono-')).map(f=>`@font-face{font-family:'${f.split('.')[0]}';src:url('/assets/sources/assets/fonts/${f}')}`).join('');
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${css}<style>${fonts}html,body,#root{margin:0;width:100%;height:100%;font-family:system-ui}*{box-sizing:border-box}</style><div id="root"></div>${scripts.map((s,i)=>`<script src="${s}"></script>${i===0?'<script src="/capture.js"></script>':''}`).join('')}<script src="/fixture.js"></script>`;
const server=http.createServer((req,res)=>{
 let data,type='text/javascript';const url=new URL(req.url,'http://127.0.0.1');
 if(url.pathname==='/'){data=html;type='text/html'}else if(url.pathname==='/capture.js')data=capture;else if(url.pathname==='/fixture.js')data=fixture;
 else{const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return}
 data=fs.readFileSync(file);if(url.pathname===main)data=data.toString().replace(/__r\(0\);\s*$/,'');
 if(file.endsWith('.css'))type='text/css';if(file.endsWith('.ttf'))type='font/ttf';if(file.endsWith('.png'))type='image/png';}
 res.setHeader('Content-Type',type);res.setHeader('Content-Security-Policy',"connect-src 'self'; img-src 'self' data: blob:; frame-src 'self'");res.end(data);
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,executablePath:process.env.LMC_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const errors=[],geometry=[];
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);await page.getByTestId('usage-calendar').waitFor();
  await page.getByTestId('usage-day-5').click();
  await page.waitForFunction(()=>document.querySelector('[data-testid=usage-model-card]').textContent.includes('claude-10-5'));
  assert.ok((await page.getByTestId('usage-model-card').innerText()).includes('codex-10-5'));
  assert.equal(await page.getByTestId('usage-records-card').getByText('显示 2 / 2 条',{exact:true}).count(),1);
  await page.getByRole('button',{name:'返回整月',exact:true}).click();
  assert.equal(await page.getByTestId('usage-detail-scope').count(),0);
  await page.getByRole('button',{name:'上个月',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-testid=usage-calendar-month]').textContent.includes('9 月'));
  assert.equal(await page.getByTestId('usage-live-card').count(),0);
  await page.getByTestId('usage-day-5').click();
  assert.ok((await page.getByTestId('usage-model-card').innerText()).includes('claude-9-5'));
  await page.getByRole('button',{name:'下个月',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-testid=usage-calendar-month]').textContent.includes('10 月'));
  assert.equal(await page.getByRole('button',{name:'下个月',exact:true}).isDisabled(),true);
  assert.equal(await page.getByTestId('usage-day-19').isDisabled(),true);
  for(const theme of ['light','dark'])for(const width of [320,390,768,1440]){
   await page.setViewportSize({width,height:1000});await page.evaluate(t=>setTheme(t),theme);
   await page.getByTestId('usage-calendar').scrollIntoViewIfNeeded();
   await page.waitForFunction(()=>document.querySelector('[data-testid=usage-calendar]').getBoundingClientRect().width>0);
   const g=await page.evaluate(()=>{
    const cal=document.querySelector('[data-testid=usage-calendar]'),b=cal.getBoundingClientRect();
    const days=[...cal.querySelectorAll('[data-testid^=usage-day-]')].map(n=>{const r=n.getBoundingClientRect();return {x:r.x,right:r.right,width:r.width,height:r.height}});
    return {viewport:innerWidth,calendar:{x:b.x,right:b.right,width:b.width},days,horizontalOverflow:document.documentElement.scrollWidth>innerWidth};
   });
   assert.equal(g.days.length,31);assert.equal(g.horizontalOverflow,false);
   assert.ok(g.days.every(d=>d.x>=g.calendar.x-.5&&d.right<=g.calendar.right+.5&&d.height>=44),'calendar touch cells stay inside');
   geometry.push({theme,width,...g});
   const ticks=await page.getByTestId('usage-trend-card').locator('svg text').evaluateAll(nodes=>nodes.filter(n=>Number(n.getAttribute('y'))===235).map(n=>{const r=n.getBoundingClientRect();return {x:r.x,right:r.right}}));
   assert.ok(ticks.length>1,'trend date labels are present');
   for(let i=1;i<ticks.length;i++)assert.ok(ticks[i].x>=ticks[i-1].right-.5,'trend date labels must not overlap');
   if(width===390||width===1440)await page.screenshot({path:path.join(out,`calendar-${theme}-${width}.png`)});
  }
  await page.getByRole('button',{name:'5 小时',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-testid=usage-window]')?.textContent.includes('滚动统计'));
  assert.equal(await page.getByTestId('usage-traffic-card').count(),0);
  const rolling=await page.getByTestId('usage-total').innerText();
  await page.getByRole('button',{name:'Codex',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-testid=usage-window]')?.textContent.includes('Codex 官方'));
  assert.notEqual(await page.getByTestId('usage-total').innerText(),rolling);
  assert.equal((await page.getByTestId('usage-records-card').innerText()).includes('early-model'),false);
  await page.evaluate(()=>fixtureStale());
  await page.waitForFunction(()=>document.querySelector('[data-testid=usage-window]')?.textContent.includes('暂无有效官方窗口'));
  assert.ok((await page.getByTestId('usage-records-card').innerText()).includes('early-model'));
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'browser-verification.json'),JSON.stringify({at:new Date().toISOString(),checks:['month day drilldown: both engines','previous month and clear selection','future month/day disabled','8 viewport/theme calendar layouts','rolling to official Codex window','stale official window falls back','daily traffic not mislabeled as five-hour','no page errors'],errors,geometry},null,2)+'\n');
  console.log(JSON.stringify({result:'passed',layouts:geometry.length,errors,artifacts:out}));
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);server.close();process.exitCode=1});
