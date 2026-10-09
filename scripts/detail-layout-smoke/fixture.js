const init=modules.get(0); __r(init.deps[0]); __r(init.deps[1]);
const React=moduleExport('useState'),h=React.createElement,{createRoot}=moduleExport('createRoot');
const {storage}=moduleExport('storage'),{UnistylesRuntime}=moduleExport('UnistylesRuntime');
const {MMKV}=moduleExport('MMKV'); new MMKV().set('settings',JSON.stringify({settings:{preferredLanguage:'zh-Hans'},version:1}));
storage.getState().applySettingsLocal({preferredLanguage:'zh-Hans'});
const query=new URLSearchParams(location.search);UnistylesRuntime.setAdaptiveThemes(false);UnistylesRuntime.setTheme(query.get('theme')||'light');
const {SessionToolOverlay}=moduleExport('SessionToolOverlay'),{MessageView}=moduleExport('MessageView');
const engine=query.get('engine');
const now=Date.now()-60000;
const receipt={id:'receipt',kind:'agent-event',createdAt:now,event:{type:'message',message:'[review fixture · attempt 1 · accepted]\ndispatch '+ 'abcdef0123456789'.repeat(24)+'\nsummary accepted\nconditions '+ '主控读完报告全文；确认中文与 English 混排可读。'.repeat(12)}};
function update(kind){const tool={id:'tool',kind:'tool-call',createdAt:now,children:[],tool:{name:engine==='claude'?'Bash':'CodexBash',state:'completed',createdAt:now,startedAt:now,completedAt:now,input:{command:kind==='short'?'pwd':Array.from({length:60},(_,i)=>`echo backend/tests/very_long_path_${i}_`+'x'.repeat(70)).join('\n')},result:null}};storage.setState({sessions:{fixture:{id:'fixture',thinking:false,metadata:{flavor:engine}}},sessionMessages:{fixture:{messages:[tool],messagesMap:{tool},isLoaded:true}}});}
update('short');
function App(){const [open,setOpen]=React.useState(false);window.showTool=kind=>{update(kind);setOpen(true)};return h('div',{style:{position:'relative',height:'100dvh',background:query.get('theme')==='dark'?'#181818':'white'}},h('div',{'data-testid':'receipt'},h(MessageView,{message:receipt,sessionId:'fixture',metadata:null})),open&&h(SessionToolOverlay,{sessionId:'fixture',messageId:'tool',top:64,onClose:()=>setOpen(false)}));}
if (!query.has('recovery')) createRoot(document.getElementById('root')).render(h(App));
else {
 const {sync}=moduleExport('sync'),{apiSocket}=moduleExport('apiSocket');
 const {normalizeRawMessage}=moduleExport('normalizeRawMessage');
 const {useQueueReceiptRecovery}=moduleExport('useQueueReceiptRecovery');
 const {useSessionMessages}=moduleExport('useSessionMessages');
 const {QueueStrip}=moduleExport('QueueStrip');
 const {pendingQueuePrompts}=moduleExport('pendingQueuePrompts');
 const {NavigationContext}=moduleExport('NavigationContext');
 const raw=normalizeRawMessage('prompt','q',1,{role:'user',content:{type:'text',text:'已处理的排队指令'},meta:{queueKey:'q'}});
 storage.setState({sessionMessages:{}});
 storage.getState().applyMessages('fixture',[{...raw,serverSeq:128028}]);
 window.reads=[];window.failRecovery=false;window.focused=true;const listeners=new Set();
 const navigation={isFocused:()=>focused,addListener:(name,listener)=>{listeners.add(listener);return()=>listeners.delete(listener)}};
 window.setRecoveryFocus=value=>{focused=value;for(const listener of listeners)listener()};
 sync.encryption={getSessionEncryption:()=>({decryptMessages:async page=>page.map(m=>({id:m.id,localId:null,createdAt:2,content:m.raw}))})};
 sync.sessionLastSeq.set('fixture',128100);sync.sessionOldestSeq.set('fixture',128000);
 apiSocket.request=async url=>{reads.push(url);if(failRecovery)throw Error('offline');return {ok:true,json:async()=>({hasMore:false,messages:[{id:'receipt',seq:128036,raw:{role:'agent',content:{id:'r',type:'event',data:{type:'queue-released',keys:['q']}}}}]})}};
 function Recovery(){const {messages}=useSessionMessages('fixture');useQueueReceiptRecovery('fixture',messages,[]);const items=pendingQueuePrompts(messages,[]);return h('div',{'data-testid':'recovery'},items.length?h(QueueStrip,{items,mode:'batch',steerState:'enabled',onSteer:()=>{throw Error('no resend')},onPromote:()=>{},onWithdraw:()=>{},onModeChange:()=>{}}):h('span',null,'排队已确认'));}
 createRoot(document.getElementById('root')).render(h(NavigationContext.Provider,{value:navigation},h(Recovery)));
 window.recoveryCursors=()=>[sync.sessionLastSeq.get('fixture'),sync.sessionOldestSeq.get('fixture')];
}

