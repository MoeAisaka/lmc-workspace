// Exercise the actual exported Metro modules, styles and icons with synthetic
// messages. No app bootstrap, authentication, browser profile or production API.
// Usage: LMC_PLAYWRIGHT_MODULE=/isolated/node_modules/playwright-core \
//   [LMC_WEBKIT=1] node session-header.cjs /path/to/web-export
// Browser/UI tool workflow: node session-header.cjs /path/to/web-export --serve
// --serve exposes visible fixture controls and makes no production connections.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const serveOnly = process.argv.includes('--serve');
const scopeQuestion = process.argv.includes('--scope-question');
const followupActions = process.argv.includes('--followup-actions');
// A second session screen left mounted behind the first, as the navigation stack leaves them.
const twoSessions = process.argv.includes('--two-sessions');
// A Windows-hosted session whose reply shows a local image by drive path. The
// session process still refuses drive paths; its daemon serves the file in chunks.
// The page carries a release marker, and /__publish?marker=X makes the server answer with a newer one.
const releaseArg = process.argv.find(arg => arg.startsWith('--release='))?.slice('--release='.length);
let servedRelease = releaseArg;
const windowsImage = process.argv.find(arg => arg.startsWith('--windows-image='))?.slice('--windows-image='.length);
const windowsImageMarkdown = '已补充并保存。\n\n![补充完成截图](<D:/AgentWork/Projects/Demo Project/.lmc-inbox/qwen-section-updated-20261008.png>)';
assert(process.argv[2], 'Pass the release export directory');
const root = path.resolve(process.argv[2]);
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmc-header-check-'));
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
const {PersonalizationRuntime}=moduleExport('PersonalizationRuntime');
let ModuleSwitcher=()=>null;try{ModuleSwitcher=moduleExport('ModuleSwitcher').ModuleSwitcher}catch{/* Older exports have no shared launcher. */}
const {useUnistyles}=moduleExport('useUnistyles'),{useLayoutWindowDimensions}=moduleExport('useLayoutWindowDimensions'),{useWindowDimensions}=moduleExport('useWindowDimensions');
const {SessionView}=moduleExport('SessionView'),{SidebarView}=moduleExport('SidebarView'),{FloatingSessionDrawer}=moduleExport('FloatingSessionDrawer');
const {useIsTablet,getDeviceType}=moduleExport('useIsTablet'),{useSessionDrawer}=moduleExport('useSessionDrawer'),{storage,useSession,useLocalSetting}=moduleExport('storage');
const {sync}=moduleExport('sync'),{gitStatusSync}=moduleExport('gitStatusSync');
const {NavigationContext}=moduleExport('NavigationContext'),{AuthProvider}=moduleExport('AuthProvider');
const {SafeAreaProvider,SafeAreaInsetsContext}=moduleExport('SafeAreaProvider'),{GestureHandlerRootView}=moduleExport('GestureHandlerRootView');
const drawerModule=[...modules.entries()].find(([id,m])=>m.factory.toString().includes('transitionstart')&&m.factory.toString().includes('renderDrawerContent'));
const {Drawer}=__r(drawerModule[0]);
sync.onSessionVisible=()=>{};gitStatusSync.getSync=()=>({invalidate(){}});
moduleExport('sessionReadFile').sessionReadFile=async()=>({success:true,content:btoa('# Fixture\n\nEditable local test document.\n')});
moduleExport('sessionWriteFile').sessionWriteFile=async()=>({success:true});
const navigation={isFocused:()=>true,addListener:()=>()=>{},getState:()=>({routes:[],index:0})};
const base=Date.now()-60000;
const mk=(id,name,flavor)=>({id,seq:1,createdAt:base,updatedAt:base,active:true,activeAt:base,presence:'online',thinking:false,thinkingAt:0,metadataVersion:1,agentStateVersion:1,metadata:{version:'1.2.71',path:'/fixture',host:'Fixture',flavor,summary:{text:name},name,machineId:'fixture-machine',orchestration:{role:'hub',workers:[]},engineAuth:{status:'required',checkedAt:base},sessionConfigState:'error',sessionConfigErrorKind:'auth',sessionConfigError:'Claude Code 尚未登录。在此设备终端执行下面这条命令，登录后重试',sessionConfigRequestedAt:base-300000,sessionConfigUpdatedAt:base,sessionCapabilities:{turnQueue:true,refresh:true,authentication:true,authenticationRecovery:true}},agentState:{}});
const session=mk('fixture','手机布局回归','claude');
const scopePrompt=${JSON.stringify(scopeQuestion ? '首期登录和权限管理，是否只面向本公司钉钉组织内的员工？\n\n- 仅本公司员工（建议先做）\n\n- 同时支持外部协作人员' : null)};
const followupPrompt=${JSON.stringify(followupActions ? '接下来请补充实测资料，保留未确认项。\n\n- :codex-followup[实测资料回填]{prompt="根据我提供的实测尺寸回填，保留未确认项。"}\n\n- :codex-followup[深化轮椅通行]{prompt="根据我提供的轮椅尺寸，核对连续通行空间。"}\n\n- ::codex-followup[统一最终视角]{prompt="在方案确认后，从同一完整场景输出全部视角。"}\n\n也可以直接输入新的要求。' : null)};
if(scopePrompt||followupPrompt){
 const receipt=document.createElement('output');receipt.dataset.testid='option-receipt';receipt.style.cssText='position:fixed;top:80px;left:12px;right:12px;z-index:2000;pointer-events:none';document.body.appendChild(receipt);
 let count=0;sync.sendMessage=async(sessionId,text,meta)=>{receipt.textContent=JSON.stringify({count:++count,sessionId,text,meta});};
}
const windowsImageText=${JSON.stringify(windowsImage ? windowsImageMarkdown : null)};
const messages=[{kind:'agent-text',id:'m1',localId:null,createdAt:base,text:windowsImageText||followupPrompt||scopePrompt||'横竖屏切换后，聊天仍应占满当前可用宽度。\n\n这是一段用于布局回归的合成消息。侧栏在宽屏常驻，竖屏通过菜单打开，并覆盖在聊天之上。\n\n切回浏览器后，输入框和会话内容都应该保持原样。',isThinking:false}];
const data={messages,messagesMap:Object.fromEntries(messages.map(m=>[m.id,m])),isLoaded:true,hasMoreOlder:false,isLoadingOlder:false};
storage.setState({machines:{'fixture-machine':{id:'fixture-machine',active:false,metadata:{engineLogin:{claude:true,codex:true}}}},isDataReady:true,profile:{id:'fixture',firstName:'Demo'},sessions:{fixture:session,codex:mk('codex','第二个合成会话','codex')},sessionMessages:{fixture:data,codex:data}});
storage.getState().applySettingsLocal({preferredLanguage:'zh-Hans',fileDiffsSidebar:true});
window.toggleDrawer=open=>useSessionDrawer.getState().setOpen(open);
window.setDraftAttachments=n=>moduleExport('useNewSessionDraft').useNewSessionDraft.getState().setAttachments(Array.from({length:n},(_,i)=>({id:'draft-'+i,uri:'data:,',width:1,height:1,mimeType:'image/png',size:1,name:'draft.png'})));
window.setMachineResources=resources=>{const cur=storage.getState().machines;storage.setState({machines:{...cur,'fixture-machine':{...cur['fixture-machine'],active:!!resources,metadata:{...cur['fixture-machine'].metadata,host:'MacMini'},daemonState:resources?{status:'running',resources}:null}}})};
if(windowsImageText){
 const cur=storage.getState().sessions;storage.setState({sessions:{...cur,fixture:{...cur.fixture,metadata:{...cur.fixture.metadata,path:'D:\\\\AgentWork\\\\Projects\\\\Demo Project',sessionCapabilities:{...cur.fixture.metadata.sessionCapabilities,resourceFiles:true}}}}});
 const {apiSocket}=moduleExport('apiSocket');window.resourceCalls=[];
 const bytes=fetch('/fixture-image').then(r=>r.arrayBuffer()).then(b=>new Uint8Array(b));
 const b64=u=>{let t='';for(let i=0;i<u.length;i+=0x8000)t+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));return btoa(t)};
 const sessionRPC=apiSocket.sessionRPC.bind(apiSocket),machineRPC=apiSocket.machineRPC.bind(apiSocket);
 apiSocket.sessionRPC=async(id,method,params)=>{if(method!=='resource-file')return sessionRPC(id,method,params);window.resourceCalls.push({via:'session',path:params.path,offset:params.offset});return {success:false,error:'无效的文件路径'}};
 apiSocket.machineRPC=async(id,method,params)=>{if(method!=='resource-file')return machineRPC(id,method,params);window.resourceCalls.push({via:'machine',machine:id,path:params.path,offset:params.offset});const all=await bytes,offset=params.offset||0,part=all.subarray(offset,offset+192*1024);return {success:true,name:'qwen-section-updated-20261008.png',content:b64(part),size:all.length,revision:'1125899908482467:1791455901033.6387:'+all.length,nextOffset:offset+part.length<all.length?offset+part.length:null}};
}
window.setMessages=list=>{const cur=storage.getState().sessionMessages;storage.setState({sessionMessages:{...cur,fixture:{...cur.fixture,messages:list,messagesMap:Object.fromEntries(list.map(m=>[m.id,m]))}}})};
window.setSettings=patch=>{const st=storage.getState();st.applySettings({...st.settings,...patch},(st.settingsVersion||0)+1)};
window.setFlavor=flavor=>{const cur=storage.getState().sessions;storage.setState({sessions:{...cur,fixture:{...cur.fixture,metadata:{...cur.fixture.metadata,flavor}}}})};
window.snapshot=()=>({cssWidth:document.documentElement.clientWidth,innerWidth,vvWidth:visualViewport.width,media:matchMedia('(min-width: 900px)').matches,device:getDeviceType(),mounts:window.chatMounts});
window.poisonDimensions=width=>{Object.defineProperty(visualViewport,'width',{configurable:true,get:()=>width});visualViewport.dispatchEvent(new Event('resize'))};
window.restoreDimensions=()=>{delete visualViewport.width;visualViewport.dispatchEvent(new Event('resize'))};
window.setMeta=patch=>{const cur=storage.getState().sessions;storage.setState({sessions:{...cur,fixture:{...cur.fixture,metadata:{...cur.fixture.metadata,...patch}}}})};
window.setResources=enabled=>storage.getState().applySettingsLocal({fileDiffsSidebar:enabled});
window.chatMounts=0;const {useTauriZoom}=moduleExport('useTauriZoom');
function Chat(){const session=useSession('fixture');React.useEffect(()=>{window.chatMounts++},[]);if(!${JSON.stringify(twoSessions)})return h(SessionView,{id:'fixture'});const screen={position:'absolute',inset:0,display:'flex',flexDirection:'column'};return h('div',{style:{position:'relative',display:'flex',flex:1,minWidth:0}},h('div',{'data-testid':'background-screen',style:{...screen,visibility:'hidden'}},h(SessionView,{id:'codex'})),h('div',{'data-testid':'front-screen',style:screen},h(SessionView,{id:'fixture'})))}
function Shell(){const desktop=useIsTablet(),zen=useLocalSetting('zenMode'),{theme}=useUnistyles(),{width}=useLayoutWindowDimensions(),raw=useWindowDimensions();const drawerWidth=desktop&&!zen?Math.min(theme.personalization.sidebarWidth,Math.max(280,width*.4)):0;return h('div',{'data-testid':'shell','data-layout':desktop?'desktop':'phone','data-layout-width':width,'data-rn-width':raw.width,style:{position:'relative',display:'flex',flex:1,minWidth:0,background:theme.colors.surface}},
 h(Drawer,{drawerType:desktop?'permanent':'front',drawerStyle:drawerWidth?{width:drawerWidth,overflow:'hidden'}:{width:0,display:'none'},open:false,onClose:()=>{},renderDrawerContent:()=>drawerWidth?h('div',{'data-testid':'sidebar',style:{display:'flex',width:drawerWidth,flex:1}},h(SidebarView)):null},
 h('div',{'data-testid':'scene',style:{position:'relative',display:'flex',flex:1,minWidth:0,flexDirection:'column'}},h(Chat))),!desktop&&h(FloatingSessionDrawer))}
function App(){useTauriZoom();return h(SafeAreaProvider,{initialMetrics:{frame:{x:0,y:0,width:innerWidth,height:innerHeight},insets:{top:0,bottom:0,left:0,right:0}}},h(SafeAreaInsetsContext.Provider,{value:{top:0,bottom:0,left:0,right:0}},h(AuthProvider,{initialCredentials:null},h(NavigationContext.Provider,{value:navigation},h(GestureHandlerRootView,{style:{width:'100%',height:'100%'}},h(PersonalizationRuntime),h(ModuleSwitcher),h(Shell))))));}
const {ModalProvider}=moduleExport('ModalProvider');
createRoot(document.getElementById('root')).render(h(ModalProvider,null,h(App)));

window.panScene=offset=>{
 const scene=document.querySelector('[data-testid="scene"]');scene.style.overflow='hidden';
 if(offset&&!document.getElementById('pan-fixture')){const filler=document.createElement('div');filler.id='pan-fixture';Object.assign(filler.style,{position:'absolute',top:'100%',height:'56px',width:'1px'});scene.appendChild(filler)}
 scene.scrollTop=offset;if(!offset)document.getElementById('pan-fixture')?.remove();
};
if(${serveOnly}){
 const controls=document.createElement('div');controls.style.cssText='position:fixed;left:12px;${followupActions ? 'top:48px' : 'bottom:160px'};z-index:2147483646;display:flex;flex-wrap:wrap;max-width:320px;gap:6px;background:#fff;padding:6px;border:1px solid #ccc;border-radius:8px;color:#111';
 const setLocal=patch=>storage.getState().applyLocalSettings(patch);
 const setWidth=sidebarWidth=>setLocal({personalization:{...storage.getState().localSettings.personalization,sidebarWidth}});
 const setTheme=name=>{const r=moduleExport('UnistylesRuntime').UnistylesRuntime;r.setAdaptiveThemes(false);r.setTheme(name)};
 for(const [label,fn] of [
  ['隐藏测试控件',()=>{controls.remove();document.querySelector('[data-testid="option-receipt"]')?.remove()}],
  ['浅色',()=>setTheme('light')],['深色',()=>setTheme('dark')],
  ['外层偏移56px',()=>panScene(56)],['恢复偏移',()=>panScene(0)],
  ['缓存窄视口680px',()=>poisonDimensions(680)],['恢复视口缓存',()=>restoreDimensions()],
  ['Claude',()=>setFlavor('claude')],['Codex',()=>setFlavor('codex')],
  ['状态正常',()=>setMeta({engineAuth:{status:'ready',checkedAt:Date.now()},sessionConfigState:'applied',sessionConfigUpdatedAt:Date.now()-20000})],
  ['刷新失败',()=>setMeta({engineAuth:{status:'ready',checkedAt:Date.now()},sessionConfigState:'error',sessionConfigErrorKind:'relaunch',sessionConfigError:'原生 Claude 里有定时任务或后台工作在运行，退出会停掉它；已保留原会话，没有退出。',sessionConfigRequestedAt:Date.now()-170000,sessionConfigUpdatedAt:Date.now()-10000})],
  ['开始刷新',()=>setMeta({engineAuth:{status:'ready',checkedAt:Date.now()},sessionConfigState:'queued',sessionConfigError:null,sessionConfigRequestedAt:Date.now(),sessionConfigUpdatedAt:Date.now()})],
  ['刷新完成',()=>setMeta({sessionConfigState:'applied',sessionConfigUpdatedAt:Date.now()})],
  ['资源关闭',()=>setResources(false)],['资源启用',()=>setResources(true)],
  ['窄侧栏',()=>setWidth('narrow')],['标准侧栏',()=>setWidth('normal')],['宽侧栏',()=>setWidth('wide')],
  ['专注模式',()=>setLocal({zenMode:true})],['普通模式',()=>setLocal({zenMode:false})],
  ['打开测试文件',()=>moduleExport('openSessionFile').openSessionFile('/fixture/test.md')],
  ['内容缩放80%',()=>document.documentElement.style.setProperty('--lmc-app-zoom','.8')],
  ['内容缩放100%',()=>document.documentElement.style.setProperty('--lmc-app-zoom','1')]
 ]){const b=document.createElement('button');b.textContent=label;b.onclick=fn;controls.appendChild(b)}
 document.body.appendChild(controls);
}
`;
const fonts=fs.readdirSync(path.join(root,'assets/sources/assets/fonts')).filter(f=>f.startsWith('IBMPlexSans-')).map(f=>`@font-face{font-family:'${f.split('.')[0]}';src:url('/assets/sources/assets/fonts/${f}')}`).join('');
const htmlFor = release => `<!doctype html><meta charset="utf-8">${release ? `<meta name="lmc-release" content="${release}" />` : ''}<meta name="viewport" content="width=device-width,initial-scale=1">${[...originalHtml.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)].map(m=>m[0]).join('')}<style>${fonts}html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}body{font-family:IBMPlexSans-Regular,Arial,sans-serif}</style><div id="root"></div>${scripts.map((s,i)=>`<script src="${s}"></script>${i===0?'<script src="/capture.js"></script>':''}`).join('')}<script src="/fixture.js"></script>`;
const server=http.createServer((req,res)=>{
 let content, type='text/javascript';
 if(req.url.startsWith('/__publish?marker=')){servedRelease=decodeURIComponent(req.url.split('=')[1]);content='ok';type='text/plain';}
 else if(req.url==='/'||req.url.startsWith('/?')){content=htmlFor(servedRelease);type='text/html';}
 else if(req.url==='/capture.js')content=capture;
 else if(req.url==='/fixture.js')content=fixture;
 else if(req.url==='/fixture-image'&&windowsImage){content=fs.readFileSync(windowsImage);type='application/octet-stream';}
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
if(serveOnly){server.listen(0,'127.0.0.1',()=>console.log('Fixture: http://127.0.0.1:'+server.address().port));}else (async()=>{
 // Supply an isolated Playwright install; do not use a personal browser profile.
 const { chromium, webkit } = require(process.env.LMC_PLAYWRIGHT_MODULE || 'playwright-core');
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=process.env.LMC_WEBKIT ? await webkit.launch({headless:true}) : await chromium.launch({headless:true,...(process.env.LMC_CHROME_PATH?{executablePath:process.env.LMC_CHROME_PATH}:{})});
 try{
  const context=await browser.newContext({viewport:{width:430,height:880},locale:'zh-CN',isMobile:true,hasTouch:true});
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const page=await context.newPage();page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.locator('textarea').first().waitFor();
  await page.waitForTimeout(800);

  const results=[];
  async function checkHeader(label, resources=true) {
   const checks=await page.evaluate(resources=>{
    const labels=['会话列表','会话菜单',...(resources?['展开会话资源']:[])];
    return labels.map(label=>{
     const e=document.querySelector(`[aria-label="${label}"]`),r=e?.getBoundingClientRect();
     const hit=r&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
     return {label,rect:r?.toJSON(),clickable:!!hit&&(hit===e||e.contains(hit))};
    });
   },resources);
   for(const c of checks){assert(c.rect&&c.rect.width>0&&c.rect.height>0,label+': '+c.label);assert(c.rect.top>=0&&c.rect.bottom<=64,label+': header outside top edge');assert(c.rect.left>=0&&c.rect.right<=page.viewportSize().width,label+': horizontal overflow');assert(c.clickable,label+': control covered');}
   const title=page.getByText('手机布局回归',{exact:true});
   assert(await title.isVisible(),label+': title missing');
   results.push({label,checks});
  }
  for(const flavor of ['claude','codex']){
   await page.evaluate(flavor=>setFlavor(flavor),flavor);await page.waitForTimeout(80);
   await checkHeader(flavor+' login + refresh error');
  }
  await page.evaluate(()=>setFlavor('claude'));
  await page.screenshot({path:path.join(out,'phone-auth-error.png')});

  // Exercise the real menu, drawer and resource controls without choosing any
  // business operation. All network access except fixture assets is blocked.
  await page.getByRole('button',{name:'会话菜单',exact:true}).click();
  await page.getByText('重命名会话',{exact:true}).waitFor();
  await page.mouse.click(4, page.viewportSize().height-4);
  await page.getByText('重命名会话',{exact:true}).waitFor({state:'detached'});
  await checkHeader('menu closed');
  await page.getByRole('button',{name:'会话列表',exact:true}).click();
  await page.getByTestId('floating-session-drawer').waitFor();await page.waitForTimeout(400);
  assert(await page.locator('[aria-label="会话列表"]').evaluate(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return hit!==e&&!e.contains(hit)}),'drawer scrim must remain above fixed header');
  await page.screenshot({path:path.join(out,'drawer.png')});
  await page.mouse.click(page.viewportSize().width-4,30);
  await page.getByTestId('floating-session-drawer').waitFor({state:'detached'});
  await checkHeader('drawer closed');
  await page.getByRole('button',{name:'展开会话资源',exact:true}).click();
  await page.locator('[data-lmc-resource-window="open"]').waitFor();
  await page.locator('[data-lmc-resource-window="open"]').getByRole('button',{name:'收起会话资源',exact:true}).click();
  await checkHeader('resources closed');

  // Controlled scroll restoration: hidden overflow containers can retain a
  // programmatic scroll offset after focus. This recreates that offset, not
  // the owner's unobserved iOS gesture. v259 loses all header controls here.
  await page.evaluate(()=>{
   const scene=document.querySelector('[data-testid="scene"]');scene.style.overflow='hidden';
   const filler=document.createElement('div');filler.id='pan-fixture';
   Object.assign(filler.style,{position:'absolute',top:'100%',height:'56px',width:'1px'});
   scene.appendChild(filler);scene.scrollTop=56;
  });
  assert.equal(await page.locator('[data-testid="scene"]').evaluate(e=>e.scrollTop),56);
  await checkHeader('screen container panned 56px');
  await page.screenshot({path:path.join(out,'panned.png')});
  await page.evaluate(()=>{document.querySelector('[data-testid="scene"]').scrollTop=0;document.getElementById('pan-fixture').remove();});

  await page.locator('textarea').first().fill('未发送的布局测试草稿');
  await page.setViewportSize({width:932,height:430});await page.waitForTimeout(200);
  assert.equal(await page.getByRole('button',{name:'会话列表',exact:true}).count(),0);
  await page.setViewportSize({width:430,height:740});
  await page.evaluate(()=>{dispatchEvent(new Event('pageshow'));dispatchEvent(new Event('focus'))});await page.waitForTimeout(200);
  await checkHeader('rotation + pageshow restore');
  await page.evaluate(()=>poisonDimensions(1440));await page.waitForTimeout(150);
  await checkHeader('stale RN dimensions');
  await page.evaluate(()=>restoreDimensions());
  await page.setViewportSize({width:430,height:410});await page.waitForTimeout(100);
  await checkHeader('short viewport');
  await page.locator('textarea').first().blur();
  await page.setViewportSize({width:390,height:740});await page.waitForTimeout(150);
  await checkHeader('390px viewport restore');
  assert.equal(await page.locator('textarea').first().inputValue(),'未发送的布局测试草稿');
  await page.evaluate(()=>setMeta({engineAuth:{status:'ready',checkedAt:Date.now()},sessionConfigState:'applied',sessionConfigUpdatedAt:Date.now()-20000}));await page.waitForTimeout(100);
  await checkHeader('refresh applied');
  await page.evaluate(()=>setResources(false));await page.waitForTimeout(100);
  await checkHeader('resources disabled',false);
  await page.evaluate(()=>setResources(true));await page.waitForTimeout(100);
  await checkHeader('resources enabled');
  await page.screenshot({path:path.join(out,'phone-restored.png')});

  await page.setViewportSize({width:1280,height:900});await page.waitForTimeout(200);
  assert.equal(await page.getByRole('button',{name:'会话列表',exact:true}).count(),0);
  const desktop=await page.locator('[data-lmc-session-header]').evaluate(e=>({position:getComputedStyle(e).position,box:e.getBoundingClientRect().toJSON()}));
  assert.equal(desktop.position,'fixed');assert.equal(desktop.box.left,360);
  await page.evaluate(()=>panScene(56));
  const controls=await page.locator('[data-lmc-session-header] [role=button]').evaluateAll(nodes=>nodes.map(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {top:r.top,bottom:r.bottom,clickable:!!hit&&(hit===e||e.contains(hit))}}));
  assert.equal(controls.length,2);for(const c of controls){assert(c.top>=0&&c.bottom<=48);assert(c.clickable);}
  results.push({label:'tablet header survives outer scroll',...desktop,controls});
  await page.screenshot({path:path.join(out,'desktop.png')});
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({browser:process.env.LMC_WEBKIT?'webkit':'chromium',results,errors},null,2));
  console.log(JSON.stringify({browser:process.env.LMC_WEBKIT?'webkit':'chromium',passed:results.length,errors:errors.length}));

 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1});
