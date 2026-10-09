// Offline real-module dashboard fixture. Run with exported web directory.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const serveOnly = true;

assert(process.argv[2], 'Pass the release export directory');
const root = path.resolve(process.argv[2]);
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-usage-check-'));
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

const fixture = String.raw`
const init=modules.get(0);__r(init.deps[0]);__r(init.deps[1]);
const React=moduleExport('useState'),h=React.createElement,{createRoot}=moduleExport('createRoot');
const {UsageDashboard}=moduleExport('UsageDashboard'),{PersonalizationRuntime}=moduleExport('PersonalizationRuntime');
const {AccountQuotaCards}=moduleExport('AccountQuotaCards');
const {View}=moduleExport('View');
const now=new Date(2026,9,5,19,47).getTime(), start=new Date(2026,9,5).getTime();
const sessionNames={s1:'产品中枢',s2:'布局修复',s3:'【接口联调】跨设备的 Claude 与 Codex 用量明细及回归验证',s4:'代码审查',s5:'回归验证',s6:'仅节点有用量的中枢',s7:'接口回归'};
const hub=(id,workers)=>({id,metadata:{orchestration:{role:'hub',workers:workers.map(sessionId=>({sessionId}))}}});
const worker=(id,sessionId)=>({id,metadata:{orchestration:{role:'worker',hub:{sessionId}}}});
const extraIds=Array.from({length:14},(_,i)=>'extra'+i);
extraIds.forEach((id,i)=>{sessionNames[id]='批量验收节点 '+(i+1)});
const sessionRoles=moduleExport('usageSessionRoles').usageSessionRoles([hub('s1',['s2','s3',...extraIds]),worker('s2','s1'),worker('s3','s1'),{id:'s4',metadata:{}},worker('s5','missing'),hub('s6',['s7']),worker('s7','s6'),...extraIds.map(id=>worker(id,'s1'))]);
const machineNames={m1:'Mac mini',m2:'MacBook',m3:'Ubuntu'};
moduleExport('storage').storage.getState().applySettingsLocal({preferredLanguage:'zh-Hans'});
const weekReset=now+2*86400000;
const quotaSnapshot={providers:[
 {engine:'codex',capturedAt:now,plan:'pro',usageCredits:{balance:53480.07,capturedAt:now},windows:[{id:'five_hour',remaining:null},{id:'seven_day',remaining:48,resetsAt:weekReset}]},
 {engine:'claude',capturedAt:now,plan:'max',windows:[{id:'five_hour',remaining:87,resetsAt:now+130*60000},{id:'seven_day',remaining:1,resetsAt:weekReset},{id:'fable_week',remaining:0,resetsAt:weekReset}],resetCredits:{count:1,expiresAt:now+7*86400000}}
]};
for(const provider of quotaSnapshot.providers){
 Object.assign(provider,{refreshFailed:false,stale:false});provider.resetCredits??=null;
 if(provider.usageCredits)Object.assign(provider.usageCredits,{unlimited:false,stale:false});
 for(const window of provider.windows){window.durationMins=window.id==='five_hour'?300:10080;window.pending=false;window.resetsAt??=null;}
}
moduleExport('AccountQuotaSnapshotSchema').AccountQuotaSnapshotSchema.parse(quotaSnapshot);
const records=[];
for(let day=0;day<30;day++)for(let i=0;i<80;i++) {
 const at=start-day*86400000+i*15*60000;if(at>now)continue;
 const factor=Math.max(0,Math.sin(i*.11)*Math.sin(i*.28)+.3), input=Math.round(factor*(1100+i%9*900));
 records.push({key:'u2:fixture:'+day+':'+i,sessionId:'s'+(i%5+1),machineId:'m'+(i%3+1),engine:i%3?'claude':'codex',model:i%3?'claude-fable-5-1':'gpt-6-astra',occurredAt:at,tokens:{input,output:Math.round(input*.17),cacheRead:input*19,cacheWrite:i%3?input:0}});
}
for(let i=0;i<6;i++)records.push({key:'u2:live:'+i,sessionId:'s1',machineId:'m1',engine:i%2?'claude':'codex',model:i%2?'claude-fable-5-1':'gpt-6-astra',occurredAt:now-i*60000,tokens:{input:3421,output:234,cacheRead:55001,cacheWrite:1200}});
records.push({key:'u2:worker-only',sessionId:'s7',machineId:'m2',engine:'codex',model:'gpt-6-astra',occurredAt:now-60000,tokens:{input:10000,output:20000,cacheRead:170000,cacheWrite:0}});
const manyRecords=[...records,...extraIds.map((id,i)=>({key:'u2:'+id,sessionId:id,machineId:'m2',engine:i%2?'claude':'codex',model:'model',occurredAt:now-60000,tokens:{input:1000+i,output:2000,cacheRead:17000,cacheWrite:0}}))];
const GB=1024**3,MB=1024**2,dayKey=i=>{const d=new Date(now-i*86400000);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')};
const trafficDay=(cu,cd,ou,od)=>({claude:{up:cu,down:cd},openai:{up:ou,down:od}});
// m1 has a week behind it; m2 began yesterday, so it has no whole day yet; m3 does not report.
const fixtureTraffic=[
 {id:'m1',name:'Mac mini',traffic:{updatedAt:now,days:Object.fromEntries([[dayKey(0),trafficDay(1.5*GB,60*MB,90*MB,100*MB)],...[1,2,3,4,5,6,7,8].map(i=>[dayKey(i),trafficDay(3*GB,100*MB,400*MB,500*MB)])])}},
 {id:'m2',name:'MacBook',traffic:{updatedAt:now,days:{[dayKey(0)]:trafficDay(2*GB,70*MB,55*MB,65*MB),[dayKey(1)]:trafficDay(200*MB,10*MB,0,0)}}},
 {id:'m3',name:'Ubuntu',traffic:null}];
function App(){
 const [period,onPeriod]=React.useState('today'),[mode,setMode]=React.useState('normal'),[receipt,setReceipt]=React.useState(''),[quotaLoaded,setQuotaLoaded]=React.useState(true);
 const fixtureNow=mode==='midnight'?start:now;
 const controls=h('div',{style:{display:'flex',gap:8,padding:'8px 16px',flexShrink:0,flexWrap:'wrap',alignItems:'center',background:'#F5F5F5',color:'#555',fontSize:12}},
 h('span',null,'离线样例 · 仅用于界面验收'),...['normal','many','empty','midnight','error','loading'].map((m,i)=>h('button',{key:m,onClick:()=>setMode(m)},['正常数据','多节点分页','空数据','午夜空数据','加载失败','加载中'][i])),
 h('button',{onClick:()=>setQuotaLoaded(v=>!v)},quotaLoaded?'额度加载中':'加载完整额度'),
 h('button',{onClick:()=>{const r=moduleExport('UnistylesRuntime').UnistylesRuntime;r.setAdaptiveThemes(false);r.setTheme('dark')}},'深色'),
 h('button',{onClick:()=>{const r=moduleExport('UnistylesRuntime').UnistylesRuntime;r.setAdaptiveThemes(false);r.setTheme('light')}},'浅色'),h('span',{'data-testid':'receipt'},receipt));
 return h(React.Fragment,null,h(PersonalizationRuntime),controls,h(UsageDashboard,{aiTraffic:mode==='empty'?fixtureTraffic.map(m=>({...m,traffic:null})):mode==='midnight'?undefined:fixtureTraffic,records:mode==='normal'?records:mode==='many'?manyRecords:[],period,onPeriod,now:fixtureNow,updatedAt:mode==='loading'||mode==='error'?null:fixtureNow,collectedSince:start-29*86400000,loading:mode==='loading',error:mode==='error'?'用量暂时加载失败，请重试。':null,onRefresh:()=>{setMode('normal');setReceipt('刷新完成')},sessionNames,sessionRoles,machineNames,onSession:id=>setReceipt('打开会话 '+id),quota:h(AccountQuotaCards,{snapshot:quotaLoaded?quotaSnapshot:null,now,loading:!quotaLoaded,failed:false,available:true,onRefresh:()=>setReceipt('刷新额度')})}));
}
createRoot(document.getElementById('root')).render(h(App));
`;
const fonts=fs.readdirSync(path.join(root,'assets/sources/assets/fonts')).filter(f=>f.startsWith('IBMPlexSans-')).map(f=>`@font-face{font-family:'${f.split('.')[0]}';src:url('/assets/sources/assets/fonts/${f}')}`).join('');
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${[...originalHtml.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)].map(m=>m[0]).join('')}<style>${fonts}html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}body{font-family:IBMPlexSans-Regular,Arial,sans-serif}</style><div id="root"></div>${scripts.map((s,i)=>`<script src="${s}"></script>${i===0?'<script src="/capture.js"></script>':''}`).join('')}<script src="/fixture.js"></script>`;
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
 res.setHeader('Content-Type',type);res.setHeader('Content-Security-Policy',"connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:;");res.end(content);
});
server.listen(0,'127.0.0.1',()=>console.log('Fixture: http://127.0.0.1:'+server.address().port));
