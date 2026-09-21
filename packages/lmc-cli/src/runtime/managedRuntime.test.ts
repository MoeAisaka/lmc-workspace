import { describe,it,expect } from 'vitest';
import { validateRelease, engineCapabilities } from './managedRuntime';
describe('dual engine runtime contract',()=>{
 for(const engine of ['claude','codex'] as const) it(engine+' supports shared lifecycle and isolated release validation',()=>{
  expect(engineCapabilities(engine)).toMatchObject({authentication:true,refresh:true,resume:true,resourceFiles:true,resourceSearch:true,model:true,effort:true});
  expect(()=>validateRelease({engine,version:'1.2.3',directory:'/tmp/release'})).not.toThrow();
  expect(()=>validateRelease({engine,version:'latest;bad',directory:'/tmp/release'})).toThrow();
 });
 it('does not advertise Codex-only settings for Claude',()=>{
  expect(engineCapabilities('claude').context).toBe(false);
  expect(engineCapabilities('codex').context).toBe(true);
 });
});

it('recognizes the existing Codex refresh protocol without enabling legacy Claude', async()=>{
 const {refreshSupported}=await import('./managedRuntime');
 expect(refreshSupported({flavor:'codex',sessionConfiguration:true})).toBe(true);
 expect(refreshSupported({flavor:'claude',sessionConfiguration:true})).toBe(false);
 expect(refreshSupported({flavor:'codex',sessionConfiguration:true,sessionCapabilities:{refresh:false}})).toBe(false);
});
