import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { useSetting } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { orderSessions, moveSession } from '@/sync/sessionOrder';
import { holdReleaseIntent, pointerSortIntent, SORT_HOLD_MS, TOUCH_MENU_HOLD_MS } from '@/utils/sessionSortGesture';
import type { SortableSessionRowsProps } from './SortableSessionRows';
import { useDragTarget } from './lmc/dragTargetStore';

type Box = { id: string; top: number; height: number };
type Drag = { id: string; pointer: number; from: number; to: number; dy: number; grab: number; x: number; y: number; phase: 'drag' | 'drop'; boxes: Box[]; target: string | null };

function computeTargetSlot(boxes: Box[], from: number, top: number): number {
    const origin = boxes[from];
    const dy = top - origin.top;
    if (dy > 0) {
        const bottom = top + origin.height;
        let passed = 0;
        for (let i = from + 1; i < boxes.length; i++) {
            if (bottom > boxes[i].top + boxes[i].height / 2) passed++;
        }
        return from + passed;
    }
    if (dy < 0) {
        let passed = 0;
        for (let i = 0; i < from; i++) {
            if (top < boxes[i].top + boxes[i].height / 2) passed++;
        }
        return from - passed;
    }
    return from;
}

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
    const menuTimer=React.useRef<ReturnType<typeof setTimeout>|null>(null);
    const [held,setHeld]=React.useState<string|null>(null);
    const suppressClick=React.useRef(false);
    const clickTimer=React.useRef<ReturnType<typeof setTimeout>|null>(null);
    const timer=React.useRef<ReturnType<typeof setTimeout>|null>(null);
    const pendingCommit=React.useRef<(()=>void)|null>(null);
    const lastHandledEvent=React.useRef<Event|null>(null);
    const detachWindowGesture=React.useRef<(()=>void)|null>(null);

    const clearBlockClick=()=>{suppressClick.current=false;if(clickTimer.current){clearTimeout(clickTimer.current);clickTimer.current=null;}};
    const blockClick=()=>{suppressClick.current=true;if(clickTimer.current)clearTimeout(clickTimer.current);clickTimer.current=setTimeout(()=>{suppressClick.current=false;clickTimer.current=null;},700);};
    const clearMenuTimer=()=>{if(menuTimer.current){clearTimeout(menuTimer.current);menuTimer.current=null;}};
    const stopWindowListenersIfIdle=()=>{
        if(!touch.current&&current.current?.phase!=='drag'&&detachWindowGesture.current){
            detachWindowGesture.current();
            detachWindowGesture.current=null;
        }
    };
    const clearTouch=()=>{if(holdTimer.current){clearTimeout(holdTimer.current);holdTimer.current=null;}clearMenuTimer();touch.current=null;setHeld(null);stopWindowListenersIfIdle();};
    const flushPendingCommit=()=>{const fn=pendingCommit.current;pendingCommit.current=null;fn?.();};
    const openRowMenu=(id:string,target:HTMLElement,x:number,y:number)=>{
        const rowNode=elements.current.get(id);
        const receiver=(target.isConnected&&target.closest('[role="button"]')?target:null)
            ??rowNode?.querySelector<HTMLElement>('[role="button"]')
            ??(target.isConnected?target:rowNode??null);
        receiver?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:x,clientY:y}));
    };
    const update=(next:Drag|null)=>{current.current=next;setDrag(next);if(next?.phase!=='drag')stopWindowListenersIfIdle();};
    const save=(id:string,target:string,after:boolean)=>sync.applySettings({sessionProjectOrder:{[groupId]:moveSession(latestRows.current.map(r=>r.id),id,target,after)}});
    const begin=(id:string,pointer:number,y:number,x:number=Number.NaN)=>{
        if(disabled||current.current||!root.current)return;
        const from=latestRows.current.findIndex(r=>r.id===id);if(from<0)return;
        const rootTop=root.current.getBoundingClientRect().top;
        const boxes=latestRows.current.map(r=>{const b=elements.current.get(r.id)!.getBoundingClientRect();return{id:r.id,top:b.top-rootTop,height:b.height};});
        update({id,pointer,from,to:from,dy:0,grab:y-rootTop-boxes[from].top,x,y,phase:'drag',boxes,target:null});
    };
    // Another group's drop target under the pointer, or null over our own rows.
    const targetAt=(x:number,y:number,draggedId:string,boxesCount:number):string|null=>{
        if(!onDropOn||!Number.isFinite(x)||!Number.isFinite(y))return null;
        if(boxesCount>1&&root.current){
            const rootRect=root.current.getBoundingClientRect();
            if(rootRect.height>0&&y>=rootRect.top-6&&y<=rootRect.bottom+6)return null;
        }
        const draggedNode=elements.current.get(draggedId)??null;
        const stack=typeof document.elementsFromPoint==='function'
            ?document.elementsFromPoint(x,y)
            :[document.elementFromPoint(x,y)];
        for(const candidate of stack){
            if(!candidate)continue;
            if(draggedNode&&(candidate===draggedNode||draggedNode.contains(candidate)))continue;
            const el=typeof candidate.closest==='function'?(candidate.closest('[data-drop-target]') as HTMLElement|null):null;
            if(!el)continue;
            const target=el.getAttribute('data-drop-target');
            return target&&target!==ownDropTarget?target:null;
        }
        return null;
    };
    const move=(y:number,x:number=Number.NaN)=>{
        const d=current.current;if(!d||d.phase!=='drag'||!root.current)return;
        const nextX=Number.isNaN(x)?d.x:x;
        const top=y-d.grab-root.current.getBoundingClientRect().top;
        const to=computeTargetSlot(d.boxes,d.from,top);
        const target=Number.isNaN(nextX)?d.target:targetAt(nextX,y,d.id,d.boxes.length);
        if(target!==d.target)useDragTarget.getState().setTarget(target);
        update({...d,x:nextX,y,to,dy:top-d.boxes[d.from].top,target});
    };
    const finish=(commit:boolean)=>{
        const d=current.current;if(!d||d.phase!=='drag')return;
        useDragTarget.getState().setTarget(null);
        if(timer.current){clearTimeout(timer.current);timer.current=null;}
        if(commit&&d.target&&onDropOn){
            // Released over another group: that group decides what it means.
            // The row snaps home here; the store will move it if the drop takes.
            const dropped=d.target;
            pendingCommit.current=()=>{onDropOn(d.id,dropped);};
            update({...d,to:d.from,phase:'drop',dy:0,target:null});
            timer.current=setTimeout(()=>{
                timer.current=null;
                flushPendingCommit();
                update(null);
            },window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:120);
            return;
        }
        const to=commit?d.to:d.from;
        const target=d.boxes[to];
        const top=to>d.from?target.top+target.height-d.boxes[d.from].height:target.top;
        pendingCommit.current=commit&&to!==d.from?()=>save(d.id,target.id,to>d.from):null;
        update({...d,to,phase:'drop',dy:top-d.boxes[d.from].top,target:null});
        const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        timer.current=setTimeout(()=>{
            timer.current=null;
            flushPendingCommit();
            update(null);
        },reduced?0:180);
    };

    const handlePointerMoveRef=React.useRef<(pointerId:number,clientX:number,clientY:number,captureHost:HTMLElement|null)=>boolean>(()=>false);
    handlePointerMoveRef.current=(pointerId,clientX,clientY,captureHost)=>{
        const p=touch.current;
        if(p&&p.pointer===pointerId&&!current.current){
            const intent=pointerSortIntent(p.pointerType,p.armed,Math.hypot(clientX-p.x,clientY-p.y),false);
            if(intent==='scroll')clearTouch();
            else if(intent==='drag'){
                clearMenuTimer();
                blockClick();
                begin(p.id,p.pointer,p.y,p.x);
                if(captureHost){try{captureHost.setPointerCapture(pointerId);}catch{}}
            }
        }
        if(pointerId===current.current?.pointer){
            move(clientY,clientX);
            return true;
        }
        return false;
    };

    const handlePointerUpRef=React.useRef<(pointerId:number)=>void>(()=>{});
    handlePointerUpRef.current=(pointerId)=>{
        const p=touch.current;
        if(pointerId===current.current?.pointer){
            blockClick();
            finish(true);
            clearTouch();
            return;
        }
        if(p?.pointer===pointerId){
            if(p.armed){
                const intent=holdReleaseIntent(p.pointerType,p.armed);
                blockClick();
                if(intent==='menu'){
                    const id=p.id,target=p.target,x=p.x,y=p.y;
                    // Opened after the original release is consumed.
                    setTimeout(()=>{openRowMenu(id,target,x,y);},0);
                }
            }
            clearTouch();
        }
    };

    const handlePointerCancelRef=React.useRef<(pointerId:number)=>void>(()=>{});
    handlePointerCancelRef.current=(pointerId)=>{
        if(pointerId===current.current?.pointer||pointerId===touch.current?.pointer){
            clearTouch();
            finish(false);
        }
    };

    const ensureWindowGestureListeners=()=>{
        if(detachWindowGesture.current||typeof window==='undefined')return;
        const onWinMove=(ev:PointerEvent)=>{if(lastHandledEvent.current===ev)return;handlePointerMoveRef.current(ev.pointerId,ev.clientX,ev.clientY,root.current);};
        const onWinUp=(ev:PointerEvent)=>{if(lastHandledEvent.current===ev)return;handlePointerUpRef.current(ev.pointerId);};
        const onWinCancel=(ev:PointerEvent)=>{if(lastHandledEvent.current===ev)return;handlePointerCancelRef.current(ev.pointerId);};
        const onWinBlur=()=>{clearTouch();finish(false);};
        window.addEventListener('pointermove',onWinMove);
        window.addEventListener('pointerup',onWinUp);
        window.addEventListener('pointercancel',onWinCancel);
        window.addEventListener('blur',onWinBlur);
        detachWindowGesture.current=()=>{
            window.removeEventListener('pointermove',onWinMove);
            window.removeEventListener('pointerup',onWinUp);
            window.removeEventListener('pointercancel',onWinCancel);
            window.removeEventListener('blur',onWinBlur);
        };
    };

    React.useEffect(()=>()=>{
        if(detachWindowGesture.current){detachWindowGesture.current();detachWindowGesture.current=null;}
        if(timer.current){clearTimeout(timer.current);timer.current=null;}
        flushPendingCommit();
        useDragTarget.getState().setTarget(null);
        if(holdTimer.current)clearTimeout(holdTimer.current);
        if(menuTimer.current)clearTimeout(menuTimer.current);
        if(clickTimer.current)clearTimeout(clickTimer.current);
    },[]);
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
        if(disabled){pendingCommit.current=null;clearTouch();}
        if(d&&(disabled||JSON.stringify(d.boxes.map(b=>b.id))!==rowKey)){
            if(timer.current){clearTimeout(timer.current);timer.current=null;}
            if(!disabled&&d.phase==='drop')flushPendingCommit();
            else pendingCommit.current=null;
            useDragTarget.getState().setTarget(null);
            update(null);
        }
    },[rowKey,groupId,disabled]);
    React.useEffect(()=>{
        if(drag?.phase!=='drag')return;
        const cancelOnEscape=(event:KeyboardEvent)=>{
            if(event.key!=='Escape'||current.current?.phase!=='drag')return;
            event.preventDefault();
            clearTouch();
            finish(false);
        };
        const syncOnScroll=()=>{
            const d=current.current;
            if(d?.phase==='drag')move(d.y,d.x);
        };
        window.addEventListener('keydown',cancelOnEscape);
        window.addEventListener('scroll',syncOnScroll,{capture:true,passive:true});
        let frame=0;
        if(drag.pointer!==-1){
            const tick=()=>{
                const d=current.current;if(!d||d.phase!=='drag')return;
                let scroll:HTMLElement|null=root.current;
                while(scroll&&(scroll.scrollHeight<=scroll.clientHeight||!/(auto|scroll)/.test(getComputedStyle(scroll).overflowY)))scroll=scroll.parentElement;
                if(scroll){
                    const box=scroll.getBoundingClientRect();const before=scroll.scrollTop;
                    if(d.y<box.top+44)scroll.scrollTop-=8;
                    else if(d.y>box.bottom-44)scroll.scrollTop+=8;
                    if(scroll.scrollTop!==before)move(d.y,d.x);
                }
                frame=requestAnimationFrame(tick);
            };
            frame=requestAnimationFrame(tick);
        }
        return()=>{
            window.removeEventListener('keydown',cancelOnEscape);
            window.removeEventListener('scroll',syncOnScroll,true);
            if(frame)cancelAnimationFrame(frame);
        };
    },[drag?.phase]);
    const activeTo=drag?(drag.target?drag.from:drag.to):0;
    return <div ref={root} style={{position:'relative'}}
        onPointerDownCapture={e=>{if(!current.current&&e.isPrimary!==false&&e.button===0&&!e.ctrlKey&&e.currentTarget.contains(e.target as Node))clearBlockClick();}}
        onClickCapture={e=>{if(suppressClick.current&&e.currentTarget.contains(e.target as Node)){clearBlockClick();e.preventDefault();e.stopPropagation();}}}
        onContextMenuCapture={e=>{if(touch.current?.armed||current.current){e.preventDefault();e.stopPropagation();}}}
        onPointerMove={e=>{
            lastHandledEvent.current=e.nativeEvent;
            if(handlePointerMoveRef.current(e.pointerId,e.clientX,e.clientY,e.currentTarget))e.stopPropagation();
        }}
        onPointerUp={e=>{
            lastHandledEvent.current=e.nativeEvent;
            handlePointerUpRef.current(e.pointerId);
        }}
        onPointerCancel={e=>{
            lastHandledEvent.current=e.nativeEvent;
            handlePointerCancelRef.current(e.pointerId);
        }}
        onKeyDown={e=>{if(e.key==='Escape'){clearTouch();if(current.current){e.preventDefault();finish(false);}}}}>
        <style>{`
            @media(prefers-reduced-motion:reduce){.happy-sort-row{transition:none!important}}
        `}</style>
        {drag&&!drag.target&&drag.to!==drag.from&&<div aria-hidden="true" style={{position:'absolute',left:0,right:0,height:2,background:'#0060F0',zIndex:3,pointerEvents:'none',top:drag.to>drag.from?drag.boxes[drag.to].top+drag.boxes[drag.to].height:drag.boxes[drag.to].top}}/>}
        {rows.map((session,index)=>{
            const selected=drag?.id===session.id;
            const shift=drag?(selected?drag.dy:index>drag.from&&index<=activeTo?-drag.boxes[drag.from].height:index<drag.from&&index>=activeTo?drag.boxes[drag.from].height:0):0;
            return <div key={session.id} ref={node=>{if(node)elements.current.set(session.id,node);else elements.current.delete(session.id);}}
                data-session-sort-id={disabled?undefined:session.id} data-sort-active={selected||held===session.id} className="happy-sort-row"
                onPointerDownCapture={e=>{
                    // Mouse and touch share one gesture: press and hold (or drag
                    // with a mouse) on the row itself, so no handle has to be shown.
                    if(disabled||current.current||e.isPrimary===false)return;
                    if(e.button!==0||e.ctrlKey)return;
                    // React portals (e.g. SessionActionsPopover RNModal in document.body) bubble
                    // synthetic pointer events through their owning row; ignore outside-DOM targets.
                    if(!(e.target instanceof Node)||!e.currentTarget.contains(e.target))return;
                    // Expanded task details are readable content, not a handle
                    // for dragging their owning session.
                    if((e.target as HTMLElement).closest('[data-session-sort-ignore]'))return;
                    clearTouch();clearBlockClick();
                    const p={id:session.id,pointer:e.pointerId,x:e.clientX,y:e.clientY,armed:false,target:e.target as HTMLElement,pointerType:e.pointerType};
                    touch.current=p;
                    ensureWindowGestureListeners();
                    holdTimer.current=setTimeout(()=>{if(touch.current===p){p.armed=true;setHeld(p.id);}},SORT_HOLD_MS);
                    if(holdReleaseIntent(e.pointerType,true)==='menu'){
                        menuTimer.current=setTimeout(()=>{
                            if(touch.current!==p||current.current)return;
                            const {id,target,x,y}=p;
                            blockClick();clearTouch();
                            openRowMenu(id,target,x,y);
                        },TOUCH_MENU_HOLD_MS);
                    }
                }}
                data-yulor-reorder="row"
                style={{'--sort-hover':theme.colors.surfaceHighest,display:'flex',alignItems:'stretch',position:'relative',userSelect:'none',WebkitUserSelect:'none',WebkitTouchCallout:'none',pointerEvents:selected&&drag?.phase==='drag'?'none':undefined,zIndex:selected?2:0,transform:`translateY(${shift}px)`,transition:!drag||(selected&&drag.phase==='drag')?'box-shadow 150ms ease':'transform 180ms cubic-bezier(.2,.8,.2,1), box-shadow 180ms ease',} as React.CSSProperties}>
                {/* The lifted-row card is inset to the row's own left edge, so it
                    never reaches back over the group's guide line. */}
                {(selected||held===session.id)&&<div aria-hidden="true" style={{position:'absolute',left:highlightInset,right:0,top:0,bottom:0,borderRadius:12,background:theme.colors.surface,boxShadow:'0 8px 24px #0002, 0 0 0 1px #0060F040',pointerEvents:'none'}}/>}
                <div style={{flex:1,minWidth:0,position:'relative'}}>{renderRow(session,index)}</div>
            </div>;
        })}
    </div>;
}
