// Exercise the actual exported Metro modules, styles and icons with synthetic
// messages. No app bootstrap, authentication, browser profile or production API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(process.argv[2] || '/tmp/lmc-timeline-web');
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-timeline-check-'));
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
const init = modules.get(0); __r(init.deps[0]); __r(init.deps[1]);
const React = moduleExport('useState'), h=React.createElement;
const {createRoot}=moduleExport('createRoot');
const {AgentWorkGroupView}=moduleExport('AgentWorkGroupView');
const {AgentInputUsageRow}=moduleExport('AgentInputUsageRow');
const {resolveTurnElapsed}=moduleExport('resolveTurnElapsed');
const {resolveSessionLifecycle}=moduleExport('resolveSessionLifecycle');
const {ToolFullView}=moduleExport('ToolFullView');
const {useToolOverlay}=moduleExport('useToolOverlay');
const {UnistylesRuntime}=moduleExport('UnistylesRuntime');
const {useUnistyles}=moduleExport('useUnistyles');
const {groupMessagesForDisplay}=moduleExport('groupMessagesForDisplay');
const base=Date.now()-134000;
const make=(id,start,end,name,description,state='completed')=>({kind:'tool-call',id,localId:null,createdAt:base+start,children:[],tool:{name,state,input:{command:'pnpm test'},description,createdAt:base+start,startedAt:base+start,completedAt:end===null?null:base+end,result:'All checks passed'}});
const calls=[make('read',2000,10000,'Read','读取相关文件'),make('pdf',10000,32000,'Bash','检查 PDF 正文提取'),make('docx',10000,24000,'exec_command','检查 DOCX 正文提取'),make('edit',32000,44000,'Edit','修改资源搜索'),make('test',44000,124000,'Bash','运行回归检查')];
const user={kind:'user-text',id:'user',createdAt:base,localId:null,text:'给会话资源加正文搜索，支持 PDF 和 DOCX。'};
const answer={kind:'agent-text',id:'final',createdAt:base+134000,localId:null,text:'已加入正文搜索，支持 PDF 和 DOCX。'};
function App(){
 const [mode,setMode]=React.useState('complete'), [expanded,setExpanded]=React.useState(true), [selected,setSelected]=React.useState(null);
 const {theme}=useUnistyles();
 window.setScenario=setMode;window.setPreviewTheme=name=>{UnistylesRuntime.setAdaptiveThemes(false);UnistylesRuntime.setTheme(name)};
 const messages=React.useMemo(()=>{
  const list=JSON.parse(JSON.stringify(calls));
  if(mode==='running'){const last=list.at(-1);last.tool.startedAt=Date.now()-5000;last.tool.completedAt=null;last.tool.state='running';}
  if(mode==='waiting'){const last=list.at(-1);last.tool.startedAt=null;last.tool.completedAt=null;last.tool.state='running';last.tool.permission={id:'p',status:'pending'};}
  if(mode==='error'){list.at(-1).tool.state='error';list.at(-1).tool.result='Build failed';}
  if(mode==='history'){list.at(-1).tool.startedAt=null;list.at(-1).tool.completedAt=null;list.at(-1).tool.state='running';}
  return [...(['complete','history','error'].includes(mode)?[answer]:[]),...list.reverse(),user];
 },[mode]);
 const group=groupMessagesForDisplay(messages,true,{timelineCurrentTurn:true,collapseCurrentTurn:!['running','waiting'].includes(mode)}).find(x=>x.type==='agent-work-group');
 React.useEffect(()=>{useToolOverlay.getState().setOpener(setSelected);return()=>useToolOverlay.getState().setOpener(null)},[]);
 const selectedTool=messages.find(m=>m.id===selected)?.tool;
 const active=['running','waiting'].includes(mode);
 const lifecycle=React.useMemo(()=>{
  const start=resolveSessionLifecycle(undefined,{role:'session',content:{turn:'A',time:base,ev:{t:'turn-start'}}},1);
  if(active)return start;
  if(mode==='history')return undefined;
  return resolveSessionLifecycle(start,{role:'session',content:{turn:'A',time:base+134000,ev:{t:'turn-end',status:mode==='error'?'failed':'completed'}}},10);
 },[mode,active]);
 const timing=React.useMemo(()=>resolveTurnElapsed(messages,lifecycle,active),[messages,lifecycle,active]);
 return h('div',{style:{minHeight:'100vh',background:theme.colors.surface,color:theme.colors.text,padding:'20px 0'}},
  h('div',{style:{maxWidth:760,margin:'auto'}},h('p',{style:{padding:'0 16px'}},user.text),
   h(AgentWorkGroupView,{group,metadata:null,sessionId:'fixture',expanded,onToggle:()=>setExpanded(x=>!x)}),
   group.completedAt!==null&&h('p',{'data-testid':'final',style:{padding:'0 16px'}},answer.text),
   h('div',{'data-testid':'composer',style:{border:'1px solid '+theme.colors.divider,borderRadius:18,margin:'24px 16px 0',padding:16}},'输入消息…'),
   h(AgentInputUsageRow,{turnElapsed:timing,contextStatus:{percent:52,detailText:'52k / 100k',color:theme.colors.textSecondary},weekPercent:74,usageMenuOptions:[]})),
  selectedTool&&h('div',{'data-testid':'detail',style:{position:'fixed',background:theme.colors.surface,inset:'10% 8%',border:'1px solid '+theme.colors.divider,borderRadius:16,display:'flex',flexDirection:'column',overflow:'auto'}},
   h('button',{onClick:()=>setSelected(null)},'Close detail'),h(ToolFullView,{tool:selectedTool,active:group.completedAt===null})));
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
  await page.goto('http://127.0.0.1:'+server.address().port);await page.getByTestId('turn-timeline').waitFor();
  assert.equal(await page.getByTestId('timeline-parallel').count(),1);
  assert.doesNotMatch(await page.getByTestId('timeline-parallel').innerText(),/22s|\+\d+:/);
  assert.match(await page.getByTestId('turn-elapsed').innerText(),/2m14s/);
  assert.equal(await page.locator('[data-testid^="timeline-step-"]').count(),5);
  const rowHeights=()=>page.locator('[data-testid^="timeline-step-"]').evaluateAll(rows=>rows.map(row=>row.getBoundingClientRect().height));
  assert.deepEqual(await rowHeights(),[22.5,22.5,22.5,22.5,22.5]);
  const readIcon=await page.getByTestId('timeline-type-read').innerText();
  const commandIcon=await page.getByTestId('timeline-type-test').innerText();
  assert.notEqual(readIcon,commandIcon);
  assert.notEqual(await page.getByTestId('timeline-type-edit').innerText(),commandIcon);
  assert.equal(await page.getByTestId('timeline-type-pdf').innerText(),await page.getByTestId('timeline-type-docx').innerText());
  assert.doesNotMatch(await page.getByTestId('timeline-step-test').innerText(),/pnpm test/);
  assert.equal(await page.getByTestId('timeline-step-test').evaluate(row=>{
   const status=row.querySelector('[data-testid^="timeline-status-"]'),type=row.querySelector('[data-testid^="timeline-type-"]');
   return status.getBoundingClientRect().x<type.getBoundingClientRect().x;
  }),true);
  assert.doesNotMatch(await page.getByTestId('timeline-step-test').innerText(),/1m20s|\+\d+:/);
  const frozen=await page.getByTestId('turn-elapsed').innerText();await page.waitForTimeout(1100);assert.equal(await page.getByTestId('turn-elapsed').innerText(),frozen);
  assert.equal(await page.getByTestId('turn-elapsed').evaluate(n=>n.getBoundingClientRect().top>document.querySelector('[data-testid="composer"]').getBoundingClientRect().bottom),true);
  await page.screenshot({path:path.join(out,'desktop-light.png'),fullPage:true});
  await page.getByTestId('timeline-step-test').click();await page.getByTestId('tool-timeline-timing').waitFor();
  assert.match(await page.getByTestId('tool-timeline-timing').innerText(),/1m20s/);await page.getByText('Close detail',{exact:true}).click();
  const header=page.getByRole('button',{name:/Steps/});await header.click();await page.getByTestId('turn-timeline').waitFor({state:'detached'});assert.equal(await page.getByTestId('turn-timeline').count(),0);assert.equal(await page.getByTestId('final').count(),1);await header.click();
  await page.evaluate(()=>setScenario('running'));await page.waitForTimeout(1100);
  assert.equal(await page.getByTestId('timeline-type-test').innerText(),commandIcon);
  assert.match(await page.getByTestId('turn-elapsed').innerText(),/Running/);
  const before=await page.getByTestId('turn-elapsed').innerText();await page.waitForTimeout(1100);assert.notEqual(await page.getByTestId('turn-elapsed').innerText(),before);
  await page.evaluate(()=>setScenario('history'));await page.waitForTimeout(100);assert.match(await page.getByTestId('timeline-step-test').innerText(),/Completion not recorded/);
  await page.evaluate(()=>setScenario('error'));await page.waitForTimeout(100);assert.match(await page.getByTestId('timeline-step-test').innerText(),/Failed/);
  assert.match(await page.getByTestId('timeline-step-test').innerText(),/pnpm test/);
  await page.evaluate(()=>setScenario('waiting'));await page.waitForTimeout(200);assert.match(await page.getByTestId('timeline-step-test').innerText(),/Waiting for approval/);
  await page.screenshot({path:path.join(out,'waiting.png'),fullPage:true});
  await page.evaluate(()=>setScenario('complete'));await page.setViewportSize({width:390,height:844});await page.evaluate(()=>setPreviewTheme('dark'));await page.waitForTimeout(200);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(await rowHeights(),[24.75,24.75,24.75,24.75,24.75]);
  await page.screenshot({path:path.join(out,'mobile-dark.png'),fullPage:true});
  await page.setViewportSize({width:320,height:740});await page.evaluate(()=>setScenario('running'));await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await page.getByTestId('timeline-step-test').evaluate(row=>row.getBoundingClientRect().height),24.75);
  await page.screenshot({path:path.join(out,'mobile-running-narrow.png'),fullPage:true});
  await page.evaluate(()=>setPreviewTheme('light'));await page.waitForTimeout(100);
  assert.equal(await page.getByTestId('timeline-parallel').evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(240, 240, 240)');
  assert.deepEqual(errors,[]);
  console.log('PASS exported Web: D22 left status, 25% smaller rows, no per-step times, detail timing, fold/unfold, final text, live/frozen footer, stale/error states, mobile width, dark/light theme; no browser errors');
  console.log('Artifacts: '+out);
 } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1});
