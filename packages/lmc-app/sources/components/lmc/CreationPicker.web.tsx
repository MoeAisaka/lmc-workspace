import * as React from 'react';
import { createPortal } from 'react-dom';
import type { CreationPickerProps } from './CreationPicker';
/** Portal keeps the centered composer completely outside the menu's layout. */
export function CreationPicker({anchor,area,onClose,children}:CreationPickerProps){
    const root=React.useRef<HTMLDivElement>(null);
    const [box,setBox]=React.useState<{left:number;top:number;width:number;height:number}|null>(null);
    React.useLayoutEffect(()=>{
        const element=anchor as unknown as HTMLElement|null;
        if(!element?.getBoundingClientRect)return;
        const place=()=>{
            const r=element.getBoundingClientRect(),v=window.visualViewport;
            const vw=v?.width??window.innerWidth,vh=v?.height??window.innerHeight;
            const ox=v?.offsetLeft??0,oy=v?.offsetTop??0;
            const width=Math.min(380,vw-24),height=Math.min(360,vh-24);
            const below=oy+vh-r.bottom-12,above=r.top-oy-12;
            const top=below>=height||below>=above?r.bottom+8:r.top-height-8;
            setBox({left:Math.max(ox+12,Math.min(r.left,ox+vw-width-12)),top:Math.max(oy+12,Math.min(top,oy+vh-height-12)),width,height});
        };
        place();window.addEventListener('resize',place);window.visualViewport?.addEventListener('resize',place);
        const scroll=(e:Event)=>{if(!root.current?.contains(e.target as Node))place();};
        window.addEventListener('scroll',scroll,true);
        const outside=(e:PointerEvent)=>{const n=e.target as Node;if(!root.current?.contains(n)&&!(area.current as unknown as HTMLElement)?.contains(n))onClose();};
        const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();onClose();element.querySelector<HTMLElement>('[role="button"]')?.focus({preventScroll:true});}};
        document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',key);
        return()=>{window.removeEventListener('resize',place);window.visualViewport?.removeEventListener('resize',place);window.removeEventListener('scroll',scroll,true);document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',key);};
    },[anchor,area,onClose]);
    if(!box)return null;
    return createPortal(<div ref={root} data-testid="creation-picker-overlay" role="dialog" aria-label="新会话配置" style={{position:'fixed',...box,zIndex:10000,display:'flex',flexDirection:'column'}}>{children}</div>,document.body);
}
