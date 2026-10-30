import {describe,it,expect} from 'vitest';
import {agyUsageRecord} from './usageAnalytics';
import {usageTotal} from 'lmc-wire';
describe('official agy result usage',()=>{
 it('counts cache and thinking once and uses immutable turn identity',()=>{
  const raw={input_tokens:10415,output_tokens:657,thinking_tokens:616,cache_read_tokens:8113,total_tokens:11072};
  const a=agyUsageRecord(raw,{sessionId:'s',machineId:'m'},'turn','gemini-4-argon-high',1000)!;
  expect(usageTotal(a.tokens)).toBe(19185);expect(a.tokens.input).toBe(10415);
  expect(agyUsageRecord(raw,{sessionId:'s',machineId:'m'},'turn','different',2000)!.key).toBe(a.key);
 });
 it('rejects invalid contracts and empty slash-command usage',()=>{
  for(const raw of [{input_tokens:2,output_tokens:3,total_tokens:9}, {input_tokens:-1,output_tokens:3,total_tokens:2},{input_tokens:0,output_tokens:0,total_tokens:0}])expect(agyUsageRecord(raw,{sessionId:'s',machineId:'m'},'t',null,1000)).toBeNull();
 });
});
