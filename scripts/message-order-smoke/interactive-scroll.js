// InteractiveBlock/ChatList browser regression, served from an exported build.
const init = modules.get(0); __r(init.deps[0]); __r(init.deps[1]);
const React = moduleExport('useState'), h = React.createElement;
const { createRoot } = moduleExport('createRoot');
const { ChatList } = moduleExport('ChatList');
const { ModalProvider } = moduleExport('ModalProvider');
const { SafeAreaProvider } = moduleExport('SafeAreaProvider');
const { storage, useSession } = moduleExport('storage');
const id = 'interactive-scroll-fixture';
const html = `<!doctype html><html><head><style>
body{margin:0;padding:24px;background:#10150e;color:#f6f7ed;font:17px/1.8 system-ui}
section{height:360px;border-top:1px solid #aaca22}button,input{font:inherit} .scroll{overflow-x:auto}
</style></head><body><h1>长交互页面</h1><button id="count" onclick="this.textContent=Number(this.textContent)+1">0</button>
<input placeholder="交互输入"><script>window.addEventListener("wheel",e=>{parent.postMessage({fixtureWheel:{dy:e.deltaY,dx:e.deltaX,cancelable:e.cancelable,prevented:e.defaultPrevented,target:e.target.tagName}},"*")},{passive:true})</script><details open><summary>可折叠说明</summary><p>点击、输入和正文滚动应同时可用。</p></details>
<div class="scroll"><table style="width:1800px"><tr><td>横向宽表</td><td>中间列</td><td>最后一列</td></tr></table></div>
${Array.from({length:22},(_,i)=>`<section><h2>段落 ${i+1}</h2><p>长页面第 ${i+1} 段，正文滚动不应变成裁剪容器内部滚动。</p></section>`).join('')}
<button>页面结尾按钮</button></body></html>`;
const session = { id, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, metadata: { host: 'fixture', path: '/fixture', name: '滚动验证', flavor: 'codex' }, metadataVersion: 1, agentState: {}, agentStateVersion: 1, thinking: false, thinkingAt: 1 };
storage.setState(s=>({ sessions: {[id]:session}, sessionMessages:{}, settings:{...s.settings,groupToolCalls:true,interactiveAnswers:'auto'} }));
const user = (id,text,seq)=>({id,localId:null,createdAt:seq,serverSeq:seq,role:'user',content:{type:'text',text},isSidechain:false});
const agent = (id,text,seq)=>({id,localId:null,createdAt:seq,serverSeq:seq,role:'agent',content:[{type:'text',text,uuid:id,parentUUID:null}],isSidechain:false});
storage.getState().applyMessages(id,[
    ...Array.from({length:5},(_,i)=>[user('u'+i,'历史用户消息 '+i,i*2+1),agent('a'+i,'历史正文 '+i+'\n\n'+('用于留下足够滚动空间。'.repeat(35)),i*2+2)]).flat(),
    user('ask','展示一个可交互的长页面',11),
    agent('page','交互页上方正文\n\n```lmc-ui id=scroll-fixture title="长交互页面"\n'+html+'\n```\n\n交互页下方正文',12),
    user('next','后续用户消息',13),agent('latest','后续回复正文\n\n'+('普通正文用于比较滑动方向。'.repeat(30)),14),
]);
function containers(){const clip=document.querySelector('[data-testid="interactive-viewport"]');let chat=clip?.parentElement;while(chat&&getComputedStyle(chat).overflowY!=='auto')chat=chat.parentElement;return {clip,chat,frame:clip?.querySelector('iframe')};}
function App(){
    const current=useSession(id);
    const [audit,setAudit]=React.useState('');
    const trace=React.useRef([]);
    React.useEffect(()=>{const message=e=>{if(e.data?.fixtureWheel)trace.current=trace.current.concat(e.data).slice(-12)};const wheel=e=>{trace.current=trace.current.concat({outerWheel:{dy:e.deltaY,target:e.target.tagName,test:e.target.getAttribute('data-testid'),sh:e.target.scrollHeight,ch:e.target.clientHeight,top:e.target.scrollTop,prevented:e.defaultPrevented}}).slice(-12)};window.addEventListener('message',message);window.addEventListener('wheel',wheel);return()=>{window.removeEventListener('message',message);window.removeEventListener('wheel',wheel)}} ,[]);
    React.useEffect(()=>{const tick=()=>{const {clip,chat,frame}=containers();setAudit(JSON.stringify({clipTop:clip?.scrollTop,clipHeight:clip?.clientHeight,clipOverflow:clip?getComputedStyle(clip).overflowY:null,frameTop:frame?.getBoundingClientRect().top,chatTop:chat?.scrollTop,trace:trace.current}));};const timer=setInterval(tick,150);return()=>clearInterval(timer);},[]);
    const position=()=>{const {clip,chat}=containers();if(clip&&chat){clip.scrollTop=0;chat.scrollTop+=190-clip.getBoundingClientRect().top;}};
    const flavor=()=>storage.setState(s=>({sessions:{[id]:{...s.sessions[id],metadata:{...s.sessions[id].metadata,flavor:current.metadata.flavor==='codex'?'claude':'codex'}}}}));
    return h(ModalProvider,null,h(SafeAreaProvider,{style:{height:'100%',display:'flex',flexDirection:'column'},initialMetrics:{frame:{x:0,y:0,width:1200,height:900},insets:{top:0,bottom:0,left:0,right:0}}},
        h('nav',null, '正式构建交互滚动验收 · '+current.metadata.flavor,
            h('button',{onClick:position},'定位交互页'),h('button',{onClick:flavor},'切换引擎')),
        h('div',{style:{flex:1,display:'flex',minHeight:0,flexDirection:'column'}},h(ChatList,{session:current,topContentInset:0,bottomContentInset:0})),
        h('pre',{'data-scroll-audit':true,style:{height:70,flexShrink:0,overflow:'auto'}},audit),
    ));
}
createRoot(document.getElementById('root')).render(h(App));
