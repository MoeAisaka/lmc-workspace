import {describe,it,expect,vi} from 'vitest';
vi.mock('@/sync/persistence', () => ({ loadSettings: () => ({ settings: {} }) }));
import {quotaEfficiency} from './quotaEfficiency';
import type {QuotaObservation,UsageRecord} from 'lmc-wire';
const at=1793000000000;
const sample=(t:number,remaining:number,reset=at+3600_000):QuotaObservation=>({machineId:'m',engine:'agy',capturedAt:at+t,pools:[{id:'gemini',windows:[{id:'five_hour',remaining,resetsAt:reset,durationMins:300,pending:false}]}]});
const record=(model='gemini-4-argon-high',machineId='m'):UsageRecord=>({key:'u2:agy:1',engine:'agy',model,machineId,sessionId:'s',occurredAt:at+200_000,tokens:{input:200,output:100,cacheRead:700,cacheWrite:0}});
const opts={machineId:'m',engine:'agy',pool:'gemini',window:'five_hour'};
describe('quota/token observational efficiency',()=>{
 it('uses disjoint token totals and keeps pool/windows separate',()=>{
  const s=quotaEfficiency([sample(0,90),sample(300_000,88)],[record()],opts);
  expect(s.models[0]).toMatchObject({tokens:1000,matchedTokens:1000,points:2,samples:1});
  expect(s.points).toBe(2);
 });
 it('does not distribute a shared pool between mixed models',()=>{
  const s=quotaEfficiency([sample(0,90),sample(300_000,88)],[record(),record('gemini-3.8-flash-low')],opts);
  expect(s.models.every(m=>m.samples===0)).toBe(true);expect(s.ambiguousPoints).toBe(2);
 });
 it('excludes replenishment, changed reset identity, and sampling gaps',()=>{
  for(const b of [sample(300_000,95),sample(300_000,88,at+4000_000),sample(1200_000,88)]){
   const s=quotaEfficiency([sample(0,90),b],[record()],opts);expect(s.points).toBe(0);expect(s.excluded).toBe(1);
  }
 });
 it('does not claim unchanged quota is free usage or mix sources',()=>{
  const s=quotaEfficiency([sample(0,90),sample(300_000,90)],[record(),record('gemini-4-argon-low','other')],opts);
  expect(s.models).toHaveLength(1);expect(s.models[0].samples).toBe(0);
 });
 it('does not attribute a turn spanning the earlier sample',()=>{
  const s=quotaEfficiency([sample(0,90),sample(300_000,88)],[{...record(),startedAt:at-1}],opts);
  expect(s.ambiguousPoints).toBe(2);expect(s.models[0].samples).toBe(0);
 });
});
