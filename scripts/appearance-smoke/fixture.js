// Actual production UI modules; synthetic state and local-only I/O.
window.fixtureErrors=[];window.fixtureActions=[];
addEventListener('error',e=>fixtureErrors.push(e.message));addEventListener('unhandledrejection',e=>fixtureErrors.push(String(e.reason)));
const nativeFetch=window.fetch;window.fetch=(input,options)=>{
 const url=new URL(typeof input==='string'?input:input.url,location.href);
 if(url.pathname==='/v1/lmc/devices')return Promise.resolve(new Response(JSON.stringify({devices:[]})));
 if(url.origin!==location.origin)throw Error('External network blocked: '+url.pathname);
 return nativeFetch(input,options);
};
const init=modules.get(0);__r(init.deps[0]);__r(init.deps[1]);
const React=moduleExport('useState'),h=React.createElement,{createRoot}=moduleExport('createRoot');
const params=new URLSearchParams(location.search),fixtureScreen=params.get('screen')||'session',font=params.get('font')||'plex',theme=params.get('theme')||'light',engine=params.get('engine')||'codex';
const {MMKV}=moduleExport('MMKV');new MMKV().set('settings',JSON.stringify({settings:{preferredLanguage:'zh-Hans'},version:1}));
const {storage}=moduleExport('storage'),{sync}=moduleExport('sync'),{apiSocket}=moduleExport('apiSocket');
sync.applySettings=delta=>storage.getState().applySettingsLocal(delta);sync.refreshMachines=async()=>{};sync.onSessionVisible=()=>{};
apiSocket.machineRPC=async(id,method)=>{fixtureActions.push(method);if(method==='runtime-status')return {runtimes:[],job:null};throw Error('Unexpected fixture RPC '+method)};
apiSocket.sessionRPC=async(id,method)=>{fixtureActions.push(method);if(method==='list-files')return {files:[]};if(method==='git-status')return {stagedFiles:[],unstagedFiles:[],totalStaged:0,totalUnstaged:0};return {success:true,files:[],stdout:'',stderr:'',exitCode:0}};
const now=Date.now(),session={id:'fixture',seq:123,createdAt:now-86400000,updatedAt:now,presence:'online',active:true,activeAt:now,thinking:false,permissionMode:'default',metadataVersion:1,agentStateVersion:1,agentState:{},metadata:{summary:{text:'LMC · 会话详情'},path:'/work/lmc',host:'Mac mini',machineId:'fixture',flavor:engine,version:'1.2.85',...(engine==='codex'?{codexThreadId:'codex-fixture-thread'}:{claudeSessionId:'claude-fixture-session'})}};
const machine={id:'fixture',active:true,activeAt:now,createdAt:now-86400000,updatedAt:now,metadataVersion:1,daemonStateVersion:1,daemonState:{pid:123,httpPort:1234,startedWithCliVersion:'1.2.85'},metadata:{displayName:'Mac mini · 工作设备',host:'Mac mini',platform:'darwin',homeDir:'/Users/demo',happyCliVersion:'1.2.85',managedUpgrades:false,cliAvailability:{claude:true,codex:true,detectedAt:now}}};
storage.setState({isDataReady:true,profile:{id:'fixture',firstName:'LMC',lastName:'Demo',connectedServices:[]},sessions:{fixture:session},sessionsData:[session],machines:{fixture:machine}});
storage.getState().applyLocalSettings({personalization:{...storage.getState().localSettings.personalization,motion:'off',uiFont:font,codeFont:params.get('code')||'plex',...(params.has('reading')?{readingStyle:params.get('reading')}:{})}});
const {UnistylesRuntime}=moduleExport('UnistylesRuntime');UnistylesRuntime.setAdaptiveThemes(false);UnistylesRuntime.setTheme(theme);
const routeCtx=__r([...modules].find(([id,m])=>m.factory.toString().includes('"./(app)/session/[id]/info.tsx"'))[0]);
const route=name=>routeCtx('./(app)/'+name).default;
const {SafeAreaProvider}=moduleExport('SafeAreaProvider'),{AuthProvider}=moduleExport('AuthProvider'),{ModalProvider}=moduleExport('ModalProvider'),{PersonalizationRuntime}=moduleExport('PersonalizationRuntime');
const {NavigationContext}=moduleExport('NavigationContext'),{NavigationRouteContext}=moduleExport('NavigationRouteContext'),{LocalRouteParamsContext}=moduleExport('LocalRouteParamsContext');
const nav={isFocused:()=>true,getState:()=>({type:'stack',index:0,routes:[{key:'fixture',name:'fixture'}],preloadedRoutes:[]}),setOptions:()=>{},getId:()=>'',getParent:()=>undefined,addListener:()=>()=>{},canGoBack:()=>true,goBack:()=>fixtureActions.push('back')};
const {Header}=__r([...modules].find(([id,m])=>m.factory.toString().includes('mobileTitleSurface')&&m.factory.toString().includes('.Header='))[0]),{Text:AppText}=moduleExport('RNText'),{Typography}=moduleExport('Typography');
const loadedNavigation=[...modules].find(([id,m])=>m.factory.toString().includes('useLoadedNavigation')&&m.factory.toString().includes('navigationRef.current'));
Object.defineProperty(__r(loadedNavigation[1].deps[2]).store,'navigationRef',{value:{current:null},configurable:true});
const pathKey=storage.getState().getSessionPathKey('fixture');
if(pathKey)storage.getState().applyGitStatusFiles(pathKey,{branch:'main',stagedFiles:[{fileName:'main.ts',filePath:'src',fullPath:'src/main.ts',status:'modified',isStaged:true,linesAdded:6,linesRemoved:2}],unstagedFiles:[],totalStaged:1,totalUnstaged:0});
const title={session:'会话详情',machine:'设备详情',account:'个人资料',devices:'设备与 Agent 升级',general:'设置',agents:'Agent 默认设置',files:'资源',about:'关于 LMC',changelog:'更新记录',cards:'对话卡片'}[fixtureScreen]||'LMC';
function content(){
 if(fixtureScreen==='reading'){
  const {MessageView}=moduleExport('MessageView'),{EnvelopeCard}=moduleExport('EnvelopeCard'),{MailBlock}=moduleExport('MailBlock');
  const prose='# 让复杂信息，也能从容阅读\n\nReading Aa 2026 — **Clear emphasis** and *careful detail*.\n\n有层次的表达，让**重要的信息**更容易被看见。排版照顾的不只是文字，也包括阅读时的停顿。\n\n## 从结构开始\n\n- 把结论写清楚，再展开关键细节。\n- 让*解释与提醒*有独立的阅读节奏，长内容自然换行。\n\n> 好的排版，让注意力回到内容本身。\n>\n> **先看结论**，再核对证据。\n\n### 核对与复现\n\n1. 检查 `src/reading.ts` 的实现。\n2. 核对两种引擎的输出。\n\n---\n\n```ts\nconst reading = "clear";\n```\n\n| 项目 | 结果 |\n| --- | --- |\n| 排版层级 | 保留 |\n\n<details>\n<summary>补充说明</summary>\n\n嵌套内容也保持**重点**与段落的层次。\n</details>';
  return h('div',{id:'reading-fixture',style:{overflow:'auto',height:'100%',padding:'8px'}},...['claude','codex'].map(flavor=>h('section',{'data-engine':flavor,key:flavor},
   h('div',{'data-reading-reply':flavor},h(MessageView,{message:{kind:'agent-text',id:'reading-'+flavor,localId:null,createdAt:now,text:prose},metadata:{flavor},sessionId:'fixture'})),
   h('div',{'data-reading-user':flavor},h(MessageView,{message:{kind:'user-text',id:'user-'+flavor,localId:null,createdAt:now,text:'# 用户标题\n\n请整理阅读结构。'},metadata:{flavor},sessionId:'fixture'})),
   h(EnvelopeCard,{envelope:{kind:'task',id:'reading-layout-check-'+flavor,attempt:1,fields:{goal:'修复阅读结构，保留**完整内容**与代码格式。',acceptance:'1. 对比手机与电脑的长段落展示，列表每条保持清楚的间隔。\n2. 加粗、斜体、引用和代码均可识别。\n3. 切换排版后仍使用原有字体与字号。',constraints:'- 每个修复都有对应检查，保持既有行为。\n- 不改变任务或会话的执行状态。\n- 很长的路径也应换行：`/workspace/project/docs/verification/reading-layout-and-mail-card-regression-20261002.md`\n\n第二段：补充说明应与列表区分，完整内容可选择复制。',deliver:'本地改动、验证记录和部署回退点。',run:'gpt-6-astra · high'}},direction:'in',counterpartId:'fixture',counterpartLabel:'总控',sessionId:'fixture'}),
   h(EnvelopeCard,{envelope:{kind:'report',id:'reading-report-'+flavor,attempt:1,status:'done',fields:{summary:'**已完成**阅读结构调整。\n\n保留全文与证据，减少长文的视觉拥挤。',verification:'- 类型检查通过。\n- 两种引擎均通过多尺寸检查。',model:flavor+' · high',evidence:'pnpm test\nconst reading = "clear";'}},direction:'in',counterpartId:'fixture',counterpartLabel:'执行单元',sessionId:'fixture'}),
   h(MessageView,{message:{kind:'user-text',id:'mail-'+flavor,localId:null,createdAt:now,text:'[agent mail from · 执行单元]\nsession (fixture)\n\n## 工作进展\n\n普通 mail 也有**重点文字**。\n\n- 保留条目。\n- 保留段落。'},metadata:{flavor},sessionId:'fixture'}),
   h(EnvelopeCard,{envelope:{kind:'review',id:'reading-review-'+flavor,attempt:1,status:'accepted',fields:{summary:'验收通过。',reasons:'1. 内容完整。\n2. 阅读层次清晰。'}},direction:'in',counterpartId:null,sessionId:'fixture'}))));
 }
 if(fixtureScreen==='session')return h(moduleExport('SessionInfoContent').SessionInfoContent,{session});
 const screens={machine:'machine/[id].tsx',account:'settings/account.tsx',devices:'settings/devices.tsx',general:'settings/appearance.tsx',agents:'settings/agents.tsx',files:'session/[id]/files.tsx',about:'settings/about.tsx',changelog:'changelog.tsx'};
 if(screens[fixtureScreen])return h(route(screens[fixtureScreen]));
 if(fixtureScreen==='alert')return h(moduleExport('WebAlertModal').WebAlertModal,{config:{type:'confirm',id:'fixture',title:'归档会话',message:'会话会保留在历史记录中，稍后可以继续查看。',cancelText:'取消',confirmText:'归档',destructive:true},onClose:()=>fixtureActions.push('closed'),onConfirm:v=>fixtureActions.push(v)});
 if(fixtureScreen==='prompt')return h(moduleExport('WebPromptModal').WebPromptModal,{config:{type:'prompt',id:'fixture',title:'重命名会话',message:'用一个容易识别的名称。',defaultValue:'LMC 工作区',cancelText:'取消',confirmText:'保存'},onClose:()=>fixtureActions.push('closed'),onConfirm:v=>fixtureActions.push(v)});
 const {EnvelopeCard}=moduleExport('EnvelopeCard'),{MarkdownView}=moduleExport('MarkdownView'),{ToolView}=moduleExport('ToolView');
 return h('div',{id:'card-fixture',style:{overflow:'auto',padding:'8px',height:'100%'}},
  ...['claude','codex'].map(flavor=>h('section',{'data-engine':flavor,key:flavor},
   h(moduleExport('MessageView').MessageView,{message:{kind:'agent-text',id:flavor,localId:null,createdAt:now,text:'## 阅读标题\n\n正文示例，**重点文字**和*斜体提示*。\n\n`inline_code`\n\n```ts\nconst sample = 42; // 代码示例\n```'},metadata:{flavor},sessionId:'fixture'}),
   h(EnvelopeCard,{envelope:{kind:'report',id:'task-'+flavor,attempt:1,status:'done',fields:{summary:'已完成页面整理，保留清晰的阅读层次。',cost:'57 calls · in 8.2M · out 69k',model:flavor+' · high',evidence:'pnpm test — 检查完成'}},direction:'in',counterpartId:'fixture',counterpartLabel:'执行单元'}),
   h(ToolView,{tool:{name:flavor==='claude'?'Bash':'exec_command',state:'completed',input:{command:'printf "hello"'},result:{stdout:'检查完成',exit_code:0},description:'运行检查',createdAt:now,startedAt:now,completedAt:now+1000},metadata:{flavor},sessionId:'fixture'}))),
  h(AppText,{style:{...Typography.mono(),fontSize:14},testID:'nested-code'},'code_parent ',h(AppText,{testID:'nested-code-child'},'code_child')));
}
function App(){return h(SafeAreaProvider,{initialMetrics:{frame:{x:0,y:0,width:innerWidth,height:innerHeight},insets:{top:0,bottom:0,left:0,right:0}}},h(AuthProvider,{initialCredentials:null},h(ModalProvider,null,h(PersonalizationRuntime),h(NavigationContext.Provider,{value:nav},h(NavigationRouteContext.Provider,{value:{key:'fixture',name:'fixture'}},h(LocalRouteParamsContext.Provider,{value:{id:'fixture'}},h('main',{id:'surface',style:{height:'100vh',display:'flex',flexDirection:'column',background:theme==='dark'?'#181818':'white',color:theme==='dark'?'white':'black'}},h(Header,{title:h(AppText,{style:{...Typography.default('semiBold'),fontSize:17,color:theme==='dark'?'white':'black'}},title),safeAreaEnabled:false}),content())))))));}
createRoot(document.getElementById('root')).render(h(App));
