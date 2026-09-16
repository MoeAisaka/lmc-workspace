import { expect, it } from 'vitest';
import { orderSessions, moveSession } from './sessionOrder';
it('keeps saved order despite activity changes and appends new sessions', () => {
    expect(orderSessions([{id:'c'}, {id:'a'}, {id:'b'}], ['b','a','deleted']).map(x=>x.id)).toEqual(['b','a','c']);
});
it('moves only existing members, without duplication or cross-project injection', () => {
    expect(moveSession(['a','b','c'], 'a', 'c', true)).toEqual(['b','c','a']);
    expect(moveSession(['a','b','c'], 'c', 'a', false)).toEqual(['c','a','b']);
    expect(moveSession(['a','b'], 'outside', 'b', true)).toEqual(['a','b']);
});
