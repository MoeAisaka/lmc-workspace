import React from 'react';
import {t} from '@/text';
import type {SessionStatusIndicatorProps} from './SessionStatusIndicator';
const css=`@keyframes happy-working-bar{0%,100%{transform:scaleY(.35)}50%{transform:scaleY(1)}}@keyframes happy-attention{0%,100%{box-shadow:0 0 0 0 #C5790A30}50%{box-shadow:0 0 0 4px #C5790A00}}.happy-working-bar{animation:happy-working-bar 1s ease-in-out infinite;transform-origin:center}.happy-attention-dot{animation:happy-attention 1.8s ease-in-out infinite}@media(prefers-reduced-motion:reduce){.happy-working-bar,.happy-attention-dot{animation:none!important}}`;
export function SessionStatusIndicator({state,showLabel=true,unread=false}:SessionStatusIndicatorProps){
    const active=state==='thinking';const attention=state==='permission_required'||state==='input_required';
    const label=active?t('localFeatures.workingState'):attention?t('localFeatures.attentionState'):state==='waiting'?t('localFeatures.onlineState'):t('localFeatures.offlineState');
    const color=active?'#0060F0':attention?'#C5790A':state==='waiting'?'#24945B':'#888';
    const [hidden,setHidden]=React.useState(typeof document!=='undefined'&&document.hidden);
    React.useEffect(()=>{const update=()=>setHidden(document.hidden);document.addEventListener('visibilitychange',update);return()=>document.removeEventListener('visibilitychange',update);},[]);
    return <span role="status" aria-label={label+(unread?' · '+t('status.unread'):'')} title={label} data-session-state={state}
        style={{display:'inline-flex',alignItems:'center',gap:6,color,fontSize:11,fontWeight:600,whiteSpace:'nowrap',padding:showLabel?'4px 7px':'0',borderRadius:7,background:showLabel?(active?'#0060F010':attention?'#C5790A10':'transparent'):'transparent'}}>
        <style>{css}</style>
        {active?<span aria-hidden="true" style={{display:'inline-flex',gap:2,alignItems:'center',height:14}}>{[0,1,2].map(i=><span key={i} className="happy-working-bar" style={{display:'block',height:12,width:3,borderRadius:2,background:color,animationDelay:`${i*-0.17}s`,animationPlayState:hidden?'paused':'running'}}/>)}</span>
        :<span aria-hidden="true" className={attention?'happy-attention-dot':undefined} style={{width:7,height:7,borderRadius:8,background:color,animationPlayState:hidden?'paused':'running'}}/>}
        {showLabel&&<span>{label}</span>}{unread&&<span aria-hidden="true" style={{height:4,width:4,borderRadius:4,background:'#0060F0'}}/>}
    </span>;
}
