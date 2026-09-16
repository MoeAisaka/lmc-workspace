import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { useSetting } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { orderSessions, moveSession } from '@/sync/sessionOrder';
import { t } from '@/text';
import { holdReleaseIntent, SORT_HOLD_MS, touchSortIntent } from '@/utils/sessionSortGesture';
import type { SortableSessionRowsProps } from './SortableSessionRows';
import { useDragTarget } from './lmc/dragTargetStore';

type Drag = {id:string; pointer:number; from:number; to:number; dy:number; grab:number; y:number; phase:'drag'|'drop'; boxes:{id:string;top:number;height:number}[]; target:string|null};
export function SortableSessionRows<T extends {id:string}>({groupId,sessions,renderRow,disabled=false,highlightInset=0,ownDropTarget,onDropOn}:SortableSessionRowsProps<T>) {
    const {theme}=useUnistyles();
    const orders=useSetting('sessionProjectOrder');
    const rows=orderSessions(sessions,orders[groupId]);
    const root=React.useRef<HTMLDivElement>(null);
    const elements=React.useRef(new Map<string,HTMLDivElement>());
    const [drag,setDrag]=React.useState<Drag|null>(null);
    const current=React.useRef<Drag|null>(null);
    const latestRows=React.useRef(rows);latestRows.current=rows;
    const touch=React.useRef<{id:string;pointer:number;x:number;y:number;armed:boolean;target:HTMLElement;pointerType:string}|null>(null);
    const holdTimer=React.useRef<ReturnType<typeof setTimeout>|null>(null);
    const [held,setHeld]=React.useState<string|null>(null);
    const suppressClick=React.useRef(false);
    const clickTimer=React.useRef<ReturnType<typeof setTimeout>|null>(null);
    const blockClick=()=>{suppressClick.current=true;if(clickTimer.current)clearTimeout(clickTimer.current);clickTimer.current=setTimeout(()=>{suppressClick.current=false;},700);};
    const clearTouch=()=>{if(holdTimer.current)clearTimeout(holdTimer.current);touch.current=null;setHeld(null);};
    const timer=React.useRef<ReturnType<typeof setTimeout>|null>(null);
    const update=(next:Drag|null)=>{current.current=next;setDrag(next);};
    const save=(id:string,target:string,after:boolean)=>sync.applySettings({sessionProjectOrder:{[groupId]:moveSession(latestRows.current.map(r=>r.id),id,target,after)}});
    const begin=(id:string,pointer:number,y:number)=>{
        if(disabled||current.current||!root.current)return;
        const from=latestRows.current.findIndex(r=>r.id===id);if(from<0)return;
        const rootTop=root.current.getBoundingClientRect().top;
        const boxes=latestRows.current.map(r=>{const b=elements.current.get(r.id)!.getBoundingClientRect();return{id:r.id,top:b.top-rootTop,height:b.height};});
        update({id,pointer,from,to:from,dy:0,grab:y-rootTop-boxes[from].top,y,phase:'drag',boxes,target:null});
    };
    // Another group's drop target under the pointer, or null over our own rows.
    const targetAt=(x:number,y:number)=>{
        if(!onDropOn)return null;
        const el=document.elementFromPoint(x,y)?.closest('[data-drop-target]') as HTMLElement|null;
        const target=el?.getAttribute('data-drop-target')??null;
        return target&&target!==ownDropTarget?target:null;
    };
    const move=(y:number,x:number=Number.NaN)=>{
        const d=current.current;if(!d||d.phase!=='drag'||!root.current)return;
        const top=y-d.grab-root.current.getBoundingClientRect().top;
        const centre=top+d.boxes[d.from].height/2;
        const to=d.boxes.filter((b,i)=>i!==d.from&&centre>b.top+b.height/2).length;
        const target=Number.isNaN(x)?d.target:targetAt(x,y);
        if(target!==d.target)useDragTarget.getState().setTarget(target);
        update({...d,y,to,dy:top-d.boxes[d.from].top,target});
    };
    const finish=(commit:boolean)=>{
        const d=current.current;if(!d||d.phase!=='drag')return;
        useDragTarget.getState().setTarget(null);
        if(commit&&d.target&&onDropOn){
            // Released over another group: that group decides what it means.
            // The row snaps home here; the store will move it if the drop takes.
            const home=d.boxes[d.from];
            update({...d,to:d.from,phase:'drop',dy:0,target:null});
            const dropped=d.target;
            timer.current=setTimeout(()=>{update(null);timer.current=null;onDropOn(d.id,dropped);},window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:120);
            void home;return;
        }
        const to=commit?d.to:d.from;
        const target=d.boxes[to];
        const top=to>d.from?target.top+target.height-d.boxes[d.from].height:target.top;
        update({...d,to,phase:'drop',dy:top-d.boxes[d.from].top});
        const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        timer.current=setTimeout(()=>{
            if(commit&&to!==d.from)save(d.id,target.id,to>d.from);
            update(null);timer.current=null;
        },reduced?0:180);
    };
    React.useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current);if(holdTimer.current)clearTimeout(holdTimer.current);if(clickTimer.current)clearTimeout(clickTimer.current);},[]);
    // A non-passive touch listener keeps native scrolling available before the
    // hold, and prevents browser panning from cancelling an armed drag.
    React.useEffect(()=>{
        const node=root.current;if(!node)return;
        const prevent=(e:TouchEvent)=>{if(touch.current?.armed||current.current)e.preventDefault();};
        node.addEventListener('touchmove',prevent,{passive:false});
        return()=>node.removeEventListener('touchmove',prevent);
    },[]);
    const rowKey=JSON.stringify(rows.map(r=>r.id));
    React.useEffect(()=>{
        const d=current.current;
        if(disabled)clearTouch();
        if(d&&(disabled||JSON.stringify(d.boxes.map(b=>b.id))!==rowKey)){if(timer.current)clearTimeout(timer.current);update(null);}
    },[rowKey,groupId,disabled]);
    React.useEffect(()=>{
        if(drag?.phase!=='drag'||drag.pointer===-1)return;
        let frame=0;
        const tick=()=>{
            const d=current.current;if(!d||d.phase!=='drag')return;
            let scroll:HTMLElement|null=root.current;
            while(scroll&&(scroll.scrollHeight<=scroll.clientHeight||!/(auto|scroll)/.test(getComputedStyle(scroll).overflowY)))scroll=scroll.parentElement;
            if(scroll){
                const box=scroll.getBoundingClientRect();const before=scroll.scrollTop;
                if(d.y<box.top+40)scroll.scrollTop-=8;
                else if(d.y>box.bottom-40)scroll.scrollTop+=8;
                if(scroll.scrollTop!==before)move(d.y);
            }
            frame=requestAnimationFrame(tick);
        };
        frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);
    },[drag?.phase]);
    return <div ref={root} style={{position:'relative'}}
        onClickCapture={e=>{if(suppressClick.current){e.preventDefault();e.stopPropagation();}}}
        onContextMenuCapture={e=>{if(touch.current?.armed||current.current){e.preventDefault();e.stopPropagation();}}}
        onPointerMove={e=>{
            const p=touch.current;
            if(p&&p.pointer===e.pointerId&&!current.current){
                const intent=touchSortIntent(p.armed,Math.hypot(e.clientX-p.x,e.clientY-p.y),false);
                if(intent==='scroll')clearTouch();
                else if(intent==='drag'){blockClick();begin(p.id,p.pointer,p.y);e.currentTarget.setPointerCapture(e.pointerId);}
            }
            if(e.pointerId===current.current?.pointer)move(e.clientY,e.clientX);
        }}
        onPointerUp={e=>{
            const p=touch.current;
            if(e.pointerId===current.current?.pointer){blockClick();finish(true);}
            else if(p?.pointer===e.pointerId&&p.armed){
                const intent=holdReleaseIntent(p.pointerType,p.armed);
                blockClick();
                if(intent==='menu'){
                    const target=p.target;const x=p.x,y=p.y;
                    // Opened after the original release is consumed.
                    setTimeout(()=>{if(target.isConnected)target.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:x,clientY:y}));},0);
                }
            }
            clearTouch();
        }}
        onPointerCancel={()=>{clearTouch();finish(false);}} onLostPointerCapture={e=>{if(!e.currentTarget.hasPointerCapture(e.pointerId))finish(false);}}
        onKeyDown={e=>{if(e.key==='Escape'){clearTouch();if(current.current){e.preventDefault();finish(false);}}}}>
        <style>{`
            @media(prefers-reduced-motion:reduce){.happy-sort-row{transition:none!important}}
        `}</style>
        {drag&&!drag.target&&drag.to!==drag.from&&<div aria-hidden="true" style={{position:'absolute',left:0,right:0,height:2,background:'#0060F0',zIndex:3,pointerEvents:'none',top:drag.to>drag.from?drag.boxes[drag.to].top+drag.boxes[drag.to].height:drag.boxes[drag.to].top}}/>}
        {rows.map((session,index)=>{
            const selected=drag?.id===session.id;
            const shift=drag?(selected?drag.dy:index>drag.from&&index<=drag.to?-drag.boxes[drag.from].height:index<drag.from&&index>=drag.to?drag.boxes[drag.from].height:0):0;
            return <div key={session.id} ref={node=>{if(node)elements.current.set(session.id,node);else elements.current.delete(session.id);}}
                data-session-sort-id={disabled?undefined:session.id} data-sort-active={selected||held===session.id} className="happy-sort-row"
                onPointerDownCapture={e=>{
                    // Mouse and touch share one gesture: press and hold the row
                    // itself to pick it up, so no handle has to be shown.
                    if(disabled||current.current||e.isPrimary===false)return;
                    if(e.pointerType==='mouse'&&e.button!==0)return;
                    clearTouch();suppressClick.current=false;
                    touch.current={id:session.id,pointer:e.pointerId,x:e.clientX,y:e.clientY,armed:false,target:e.target as HTMLElement,pointerType:e.pointerType};
                    holdTimer.current=setTimeout(()=>{const p=touch.current;if(p){p.armed=true;setHeld(p.id);}},SORT_HOLD_MS);
                }}
                style={{'--sort-hover':theme.colors.surfaceHighest,display:'flex',alignItems:'stretch',position:'relative',zIndex:selected?2:0,transform:`translateY(${shift}px)`,transition:selected&&drag?.phase==='drag'?'box-shadow 150ms ease':'transform 180ms cubic-bezier(.2,.8,.2,1), box-shadow 180ms ease',} as React.CSSProperties}>
                {/* The lifted-row card is inset to the row's own left edge, so it
                    never reaches back over the group's guide line. */}
                {(selected||held===session.id)&&<div aria-hidden="true" style={{position:'absolute',left:highlightInset,right:0,top:0,bottom:0,borderRadius:12,background:theme.colors.surface,boxShadow:'0 8px 24px #0002, 0 0 0 1px #0060F040',pointerEvents:'none'}}/>}
                <div style={{flex:1,minWidth:0,position:'relative'}}>{renderRow(session,index)}</div>
            </div>;
        })}
    </div>;
}
