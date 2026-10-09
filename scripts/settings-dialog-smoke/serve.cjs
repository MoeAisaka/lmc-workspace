// Local-only visual fixture using the exported app's real settings components.
// No app bootstrap, credentials, provider requests or production API access.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(process.argv[2] || '/tmp/lmc-settings-style-web');
const scripts = [...fs.readFileSync(path.join(root, 'index.html'), 'utf8').matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
const main = scripts.at(-1);
const capture = `window.modules=new Map();const define=window.__d;
window.__d=(factory,id,deps)=>{modules.set(id,{factory,deps});define(factory,id,deps)};
window.moduleExport=name=>{const re=new RegExp('\\\\.'+name+'\\\\s*=(?!=)');for(const[id,m]of modules)if(re.test(m.factory.toString())||m.factory.toString().includes(JSON.stringify(name))){const e=__r(id);if(e[name])return e}throw Error('Missing export '+name)};`;
const fixture = `
window.fixtureErrors=[];addEventListener('error',e=>fixtureErrors.push(e.message));
addEventListener('unhandledrejection',e=>fixtureErrors.push(String(e.reason)));
const nativeFetch=window.fetch;window.fetch=(input,options)=>{const url=new URL(typeof input==='string'?input:input.url,location.href);if(url.origin!==location.origin)throw Error('External request blocked');return nativeFetch(input,options)};
const init=modules.get(0);__r(init.deps[0]);__r(init.deps[1]);
const React=moduleExport('useState'),h=React.createElement,{createRoot}=moduleExport('createRoot');
const {MMKV}=moduleExport('MMKV');new MMKV().set('settings',JSON.stringify({settings:{preferredLanguage:new URLSearchParams(location.search).get('lang')||'zh-Hans'},version:1}));
const {storage}=moduleExport('storage'),{sync}=moduleExport('sync');
sync.applySettings=delta=>storage.getState().applySettingsLocal(delta);
const {openLmcSettings}=moduleExport('openLmcSettings');
const {AccountMenuLayer,useAccountMenu}=moduleExport('AccountMenuLayer');
const {ModalProvider}=moduleExport('ModalProvider'),{AuthProvider}=moduleExport('AuthProvider');
const {PersonalizationRuntime}=moduleExport('PersonalizationRuntime');
const {MessageView}=moduleExport('MessageView');
const fixtureMessages=()=>h('div',{id:'engine-fixture'},...['claude','codex'].map(flavor=>h('section',{'data-engine':flavor,key:flavor},h(MessageView,{message:{kind:'user-text',id:flavor+'-user',localId:null,createdAt:1,text:flavor+' user sample'},metadata:{flavor},sessionId:'fixture'}),h(MessageView,{message:{kind:'agent-text',id:flavor+'-agent',localId:null,createdAt:1,text:flavor+' agent sample'+(new URLSearchParams(location.search).has('codeFonts')?String.fromCharCode(10,10,35,32,38405,35835,26631,39064,10,10,27491,25991,31034,20363,65292,42,42,37325,28857,25991,23383,42,42,65292,42,26012,20307,25552,31034,42,12290,10,10,35,35,32,27425,32423,26631,39064,10,10,45,32,31532,19968,39033,10,45,32,31532,20108,39033,10,10,96,20195,30721,36335,24452,47,101,120,97,109,112,108,101,46,116,115,96,10,10,96,96,96,116,115,10,99,111,110,115,116,32,115,97,109,112,108,101,32,61,32,52,50,59,32,47,47,32,20195,30721,31034,20363,10,96,96,96,10,10,124,32,39033,30446,32,124,32,35828,26126,32,124,10,124,32,45,45,45,32,124,32,45,45,45,32,124,10,124,32,23383,20307,32,124,32,20445,30041,23618,27425,32,124):'')},metadata:{flavor},sessionId:'fixture'}))));
const {BrowserNavigationShortcuts}=moduleExport('BrowserNavigationShortcuts');
const {SafeAreaProvider}=moduleExport('SafeAreaProvider'),{GestureHandlerRootView}=moduleExport('GestureHandlerRootView');
const {UnistylesRuntime}=moduleExport('UnistylesRuntime');
const theme=new URLSearchParams(location.search).get('theme')||'light';
UnistylesRuntime.setAdaptiveThemes(false);UnistylesRuntime.setTheme(theme);
storage.setState({isDataReady:true,profile:{id:'fixture',firstName:'Demo'},sessions:{},machines:{}});
storage.getState().applySettingsLocal({preferredLanguage:new URLSearchParams(location.search).get('lang')||'zh-Hans',agentDefaultOverrides:{codex:{modelMode:'gpt-6-astra'},claude:{modelMode:'claude-opus-5-5'}}});
function App(){React.useEffect(()=>{setTimeout(()=>openLmcSettings(),0)},[]);return h(SafeAreaProvider,{initialMetrics:{frame:{x:0,y:0,width:innerWidth,height:innerHeight},insets:{top:0,bottom:0,left:0,right:0}}},h(AuthProvider,{initialCredentials:null},h(ModalProvider,null,h(PersonalizationRuntime,{}),h(BrowserNavigationShortcuts,{}),h(GestureHandlerRootView,{style:{height:innerHeight,backgroundColor:theme==='dark'?'#202020':'#f9f9fb'}},h('div',{style:{padding:24,color:theme==='dark'?'#eee':'#161616'}},h('h2',{},'LMC'),h('p',{},'本轮回复已经完成。'),h('button',{onClick:()=>openLmcSettings()},'打开设置'),h('button',{onClick:()=>useAccountMenu.getState().open({x:12,y:innerHeight-30,width:Math.min(326,innerWidth-24),panelTop:52})},'账户菜单'),h('p',{},'继续当前会话'),new URLSearchParams(location.search).has('personalization')&&fixtureMessages()),h(AccountMenuLayer,{})))))}
createRoot(document.getElementById('root')).render(h(App));
addEventListener('message',event=>{if(event.origin!==location.origin||event.data!=='inspect')return;const box=n=>{if(!n)return null;const b=n.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom}};const dialog=document.querySelector('[data-testid="lmc-settings-dialog"]');const pane=document.querySelector('[data-testid="settings-pane"]');parent.postMessage({fixture:{viewport:[innerWidth,innerHeight],dialog:box(dialog),pane:box(pane),theme:UnistylesRuntime.themeName,selected:document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,errors:fixtureErrors,remaining:storage.getState().settings.usageLimitShowRemaining,bodyWidth:document.body.scrollWidth,paneOverflow:pane?[...pane.querySelectorAll('*')].filter(n=>{const b=n.getBoundingClientRect();return b.width>0&&(b.right>pane.getBoundingClientRect().right+1||b.x<pane.getBoundingClientRect().x-1)}).map(n=>n.textContent.slice(0,70)):[]}},location.origin)});
`;
const fonts = fs.readdirSync(path.join(root,'assets/sources/assets/fonts')).filter(f=>f.startsWith('IBMPlexSans-')||f.startsWith('IBMPlexMono-')).map(f=>`@font-face{font-family:'${f.split('.')[0]}';src:url('/assets/sources/assets/fonts/${f}')}`).join('');
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fonts}body{margin:0;font-family:IBMPlexSans-Regular,Arial,sans-serif}</style>${[...fs.readFileSync(path.join(root, 'index.html'), 'utf8').matchAll(/<link[^>]+href="([^" ]+\.css)"[^>]*>/g)].map(m=>`<link rel="stylesheet" href="${m[1]}">`).join('')}<div id="root"></div>${scripts.map((s,i)=>`<script src="${s}"></script>${i===0?'<script src="/capture.js"></script>':''}`).join('')}<script src="/fixture.js"></script>`;
const showroom = `<!doctype html><meta charset="utf-8"><title>LMC settings QA</title><style>body{margin:0;background:#e5e7eb;font:14px system-ui}nav{padding:8px;display:flex;gap:8px;align-items:center}button{padding:8px}iframe{display:block;border:0;margin:0 16px 16px;background:white}pre{white-space:pre-wrap;margin:12px}label{display:flex;gap:4px}</style><nav><button onclick="resize(390,675)">Phone 390</button><button onclick="resize(320,568)">Phone 320</button><button onclick="resize(430,850)">Phone 430</button><button onclick="resize(667,390)">Landscape</button><button onclick="resize(1100,800)">Desktop</button><button onclick="mode=mode==='light'?'dark':'light';load()">Light / Dark</button><button onclick="lang=lang==='zh-Hans'?'en':'zh-Hans';load()">中文 / English</button><button onclick="frame.contentWindow.postMessage('inspect',location.origin)">Inspect bounds</button></nav><iframe id="frame"></iframe><pre id="result"></pre><script>let w=390,h=675,mode='light',lang='zh-Hans';const frame=document.getElementById('frame');function load(){frame.width=w;frame.height=h;frame.src='/app?theme='+mode+'&lang='+lang+'&nonce='+Date.now()}function resize(width,height){w=width;h=height;load()}load();addEventListener('message',e=>{if(e.origin!==location.origin||!e.data.fixture)return;document.getElementById('result').textContent=JSON.stringify(e.data.fixture,null,2);fetch('/evidence',{method:'POST',body:JSON.stringify(e.data.fixture)})});</script>`;
const server=http.createServer((req,res)=>{
 let content,type='text/javascript';const url=new URL(req.url,'http://127.0.0.1');
 if(url.pathname==='/evidence'){let body='';req.on('data',d=>body+=d);req.on('end',()=>{console.log(body);res.end('ok')});return}
 if(url.pathname==='/'){content=showroom;type='text/html'}
 else if(url.pathname==='/app'){content=html;type='text/html'}
 else if(url.pathname==='/capture.js')content=capture;
 else if(url.pathname==='/fixture.js')content=fixture;
 else if(url.pathname==='/v1/lmc/devices'){content=JSON.stringify({devices:[]});type='application/json'}
 else{const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return}content=fs.readFileSync(file);if(url.pathname===main)content=content.toString().replace(/__r\(0\);\s*$/,'');if(file.endsWith('.ttf'))type='font/ttf';if(file.endsWith('.woff2'))type='font/woff2';if(file.endsWith('.png'))type='image/png';if(file.endsWith('.css'))type='text/css'}
 res.setHeader('Content-Type',type);res.setHeader('Content-Security-Policy',"connect-src 'self'; img-src 'self' data: blob:; frame-src 'self'");res.end(content);
});
const port=Number(process.env.LMC_SETTINGS_FIXTURE_PORT||4187);
server.listen(port,'127.0.0.1',()=>console.log('http://127.0.0.1:'+port));
