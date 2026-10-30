// Exercise the actual exported Metro modules, styles and icons with synthetic
// messages. No app bootstrap, authentication, browser profile or production API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(process.argv[2] || '/tmp/lmc-unified-web-20261016');
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-shares-check-'));
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
window.calls=[];window.errors=[];window.navigation=[];window.screenId='11111111-1111-4111-8111-111111111111';
window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
function override(name,value){const re=new RegExp('\\\\.'+name+'\\\\s*=');let count=0;for(const [id,m] of modules)if(re.test(m.factory.toString())){const e=__r(id),desc=Object.getOwnPropertyDescriptor(e,name);if(desc&&desc.writable){e[name]=value;count++}}if(!count)throw new Error('Cannot stub '+name)}
override('useRouter',()=>({push:id=>navigation.push(id),back(){}}));override('useLocalSearchParams',()=>({id:screenId}));override('useNavigation',()=>({setOptions(){},isFocused:()=>true,addListener:()=>()=>{},getState:()=>({index:0,routes:[{key:"fixture",name:"saved-file"}]}),getParent:()=>null}));override('useRoute',()=>({key:'fixture',name:'saved-file',params:{}}));
const {UnistylesRuntime}=moduleExport('UnistylesRuntime');
window.setTheme=theme=>{UnistylesRuntime.setAdaptiveThemes(false);UnistylesRuntime.setTheme(theme);document.body.style.background=theme==='dark'?'#202020':'#fff'};
window.eligible=true;
override('useAllSessions',()=>eligible?[{id:'target',active:false,metadata:{name:'MacBook 文件接收',host:'MacBook',sessionCapabilities:{persistentFiles:true}}}]:[{id:'old',metadata:{name:'旧 Agent',sessionCapabilities:{}}}]);
const file={manifest:{id:screenId,name:'交付说明.txt',mimeType:'text/plain',size:28,parts:[]},key:new Uint8Array(32),createdAt:1792051200000};
let deliveries=[],shares=[];
override('getFileShares',async()=>shares);
override('createFileShare',async(f,hours)=>{calls.push(['share',hours]);const row={id:'22222222-2222-4222-8222-222222222222',assetId:screenId,createdAt:Date.now(),expiresAt:Date.now()+hours*3600000,revokedAt:null};shares=[row];return {...row,url:'https://vault.example.test/artifact/download/lmc/'+row.id+'/'+'a'.repeat(64)}});
override('revokeFileShare',async id=>{calls.push(['revoke',id]);shares=shares.map(r=>({...r,revokedAt:Date.now()}))});
override('getFileAsset',async id=>{if(id==='missing')throw new Error('文件不存在或当前 LMC 中心需要升级');return file});
override('listFileAssets',async()=>({files:[file],next:null}));
override('getFileDeliveries',async()=>deliveries);
override('decryptFileReceipt',async row=>row.state==='received'?{path:'/fixture/.lmc-inbox/report.txt'}:null);
override('deliverFileAsset',async(f,target)=>{calls.push(['deliver',target]);deliveries=[{id:'delivery',sessionId:target,state:'pending',createdAt:1,updatedAt:1}];return deliveries[0]});
override('downloadFileAsset',async(f,progress)=>{calls.push(['download',f.manifest.id]);progress(28)});
override('fileAssetBlob',async()=>new Blob(['FILE PREVIEW END · 文件预览'],{type:'text/plain'}));
const detailId=[...modules].find(([id,m])=>m.factory.toString().includes('.FILE_PREVIEW_LIMIT')&&m.factory.toString().includes('.getFileDeliveries'))?.[0];
const listId=[...modules].find(([id,m])=>m.factory.toString().includes('.listFileAssets)')&&m.factory.toString().includes('.SavedFileCard'))?.[0];
if(detailId===undefined||listId===undefined)throw new Error('Saved file screens missing');
const Detail=__r(detailId).default,List=__r(listId).default;
const envelope=moduleExport('savedFileEnvelope').savedFileEnvelope(file.manifest,'file-published:fixture');
const normalized=moduleExport('normalizeRawMessage').normalizeRawMessage('fixture-message',null,1,{role:'agent',content:{type:'session',data:envelope}});
if(normalized?.role!=='agent'||normalized.content[0]?.input?.assetId!==screenId)throw new Error('Published file card was filtered');
const {FileView}=moduleExport('FileView');const Card=()=>h(FileView,{tool:{input:normalized.content[0].input},metadata:null,messages:[]});
const {ModalProvider}=moduleExport('ModalProvider'),{SafeAreaProvider}=moduleExport('SafeAreaProvider');
const renderRoot=createRoot(document.getElementById('root'));let revision=0;
window.renderScreen=mode=>renderRoot.render(h(SafeAreaProvider,{initialMetrics:{frame:{x:0,y:0,width:innerWidth,height:innerHeight},insets:{top:0,bottom:0,left:0,right:0}}},h(ModalProvider,null,h(mode==='list'?List:mode==='card'?Card:Detail,{key:++revision}))));
window.markReceived=()=>{deliveries=deliveries.map(d=>({...d,state:'received'}));renderScreen('detail')};
renderScreen('detail');
`;
const fonts=fs.readdirSync(path.join(root,'assets/sources/assets/fonts')).filter(f=>f.startsWith('IBMPlexSans-')).map(f=>`@font-face{font-family:'${f.split('.')[0]}';src:url('/assets/sources/assets/fonts/${f}')}`).join('');
const styles=[...originalHtml.matchAll(/<style[^>]*>[\s\S]*?<\/style>|<link[^>]+rel="stylesheet"[^>]*>/g)].map(m=>m[0]).join('');
const html = `<!doctype html>${styles}<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fonts}body{margin:0;font-family:IBMPlexSans-Regular,Arial,sans-serif}</style><div id="root"></div>${scripts.map((s,i)=>`<script src="${s}"></script>${i===0?'<script src="/capture.js"></script>':''}`).join('')}<script src="/fixture.js"></script>`;
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
 const errors=[];
 try{
  const origin='http://127.0.0.1:'+server.address().port;
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.route('**/*',route=>route.request().url().startsWith(origin)||route.request().url().startsWith('data:')?route.continue():route.abort());
  const page=await context.newPage();page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});
  await page.goto(origin);
  const results=[];
  for(const [theme,width] of [['light',390],['dark',390],['light',1280],['dark',1280]]){
   await page.setViewportSize({width,height:1000});await page.evaluate(theme=>setTheme(theme),theme);
   await page.getByRole('button',{name:'下载',exact:true}).waitFor();
   assert.equal(await page.getByRole('button',{name:'发送文件',exact:true}).isEnabled(),false);
   await page.screenshot({path:path.join(out,theme+'-'+width+'.png')});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   results.push({theme,width,noHorizontalOverflow:true});
  }
  assert.equal((await page.evaluate(()=>calls)).length,0);
  await page.getByRole('button',{name:'生成限时外链',exact:true}).click();
  await page.getByRole('button',{name:'复制外链',exact:true}).waitFor();
  await page.setViewportSize({width:390,height:1000});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.getByRole('button',{name:'复制外链',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(out,'created-dark-390.png')});
  await page.getByRole('button',{name:'撤销外链',exact:true}).click();
  await page.getByText('外链已撤销，登录后的原文件仍可下载',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'复制外链',exact:true}).count(),0);
  await page.getByRole('button',{name:'下载',exact:true}).click();
  await page.getByText('文件已交给浏览器保存',{exact:true}).waitFor();
  const final=await page.evaluate(()=>({calls,errors}));
  assert.deepEqual(errors,[]);assert.deepEqual(final.errors,[]);
  assert.equal(final.calls.filter(c=>c[0]==='download').length,1);
  assert.deepEqual(final.calls.filter(c=>c[0]==='share'),[['share',24]]);
  assert.equal(final.calls.filter(c=>c[0]==='revoke').length,1);
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,results,...final},null,2));
  console.log(JSON.stringify({passed:true,results,out}));
 }catch(error){console.error(JSON.stringify({errors}));throw error}
 finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1});
