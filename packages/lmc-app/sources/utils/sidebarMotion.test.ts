import {it,expect,vi} from 'vitest';
import {runSidebarTransition} from './sidebarMotion.web';
it('changes layout exactly once without browser transition support',()=>{const change=vi.fn();runSidebarTransition(change);expect(change).toHaveBeenCalledTimes(1);});
it('respects reduced motion',()=>{const change=vi.fn(),start=vi.fn();vi.stubGlobal('window',{matchMedia:()=>({matches:true})});vi.stubGlobal('document',{startViewTransition:start});runSidebarTransition(change);expect(change).toHaveBeenCalledTimes(1);expect(start).not.toHaveBeenCalled();vi.unstubAllGlobals();});
