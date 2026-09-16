import {it,expect} from 'vitest';
import {suppressTouchReleaseClick} from './touchMenuRelease';
const click=()=>Object.assign(new Event('click',{cancelable:true}),{detail:1});
it('consumes the release click once so a long-press menu stays open',()=>{
    const target=new EventTarget();const stop=suppressTouchReleaseClick(target);
    try {expect(target.dispatchEvent(click())).toBe(false);expect(target.dispatchEvent(click())).toBe(true);}finally{stop();}
});
it('allows an intentional new tap and keyboard click',()=>{
    const target=new EventTarget();const stop=suppressTouchReleaseClick(target);
    target.dispatchEvent(new Event('pointerdown'));
    expect(target.dispatchEvent(click())).toBe(true);stop();
    const stopAgain=suppressTouchReleaseClick(target);
    expect(target.dispatchEvent(Object.assign(new Event('click',{cancelable:true}),{detail:0}))).toBe(true);stopAgain();
});
