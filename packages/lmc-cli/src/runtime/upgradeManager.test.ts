import { it,expect } from 'vitest';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpgradeManager } from './upgradeManager';
it('failed staging never activates or refreshes sessions and survives reload',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lmc-upgrade-')); let activated=false;let refreshed=false;
 try {
  const manager=new UpgradeManager(dir,{stage:async()=>{throw new Error('download failed');},activate:async()=>{activated=true;},sessions:async()=>[],refresh:async()=>{refreshed=true;return {};},inspect:async()=>({})});
  await manager.start('codex'); await manager.settled();
  expect((await manager.status()).job?.state).toBe('error'); expect(activated).toBe(false);expect(refreshed).toBe(false);
  const next=new UpgradeManager(dir,{} as any); expect((await next.status()).job?.error).toBe('download failed');
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('deduplicates clicks and keeps incomplete refresh visible',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lmc-upgrade-'));let installs=0;
 try{
  const manager=new UpgradeManager(dir,{stage:async(engine)=>{installs++;return {engine,version:'1.2.3',directory:dir};},activate:async()=>{},sessions:async()=>[{id:'s',state:'pending'}],refresh:async()=>({state:'waiting'}),inspect:async()=>({})});
  const first=await manager.start('claude');const second=await manager.start('claude');
  expect(second.id).toBe(first.id);await manager.settled();expect(installs).toBe(1);
  const job=(await manager.status()).job!;expect(job.state).toBe('refreshing');expect(job.sessions[0].state).toBe('waiting');
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('does not start an engine installation while its Agent is handing off',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lmc-upgrade-'));let installs=0;
 try{const manager=new UpgradeManager(dir,{ready:()=>false,stage:async()=>{installs++;throw Error('unreachable');},activate:async()=>{},sessions:async()=>[],refresh:async()=>({}),inspect:async()=>({})});
 await expect(manager.start('codex')).rejects.toThrow('Agent');expect(installs).toBe(0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('lets a newer release take over from a job that has stopped finishing',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lmc-upgrade-'));const staged:string[]=[];let catalog='1.2.15';
 try{
  const effects={stage:async(engine:any)=>{staged.push(catalog);return {engine,version:catalog,directory:dir};},
   activate:async()=>{},sessions:async()=>[{id:'s',state:'pending' as const}],
   // A session that never answers: the job stays in refreshing, which is what
   // used to hold every later upgrade on this machine behind it.
   refresh:async()=>({state:'waiting' as const}),inspect:async()=>({}),
   supersedes:async(_e:any,inProgress:any)=>catalog!==inProgress.version};
  const manager=new UpgradeManager(dir,effects as any);
  const first=await manager.start('agent');await manager.settled();
  expect((await manager.status()).job?.state).toBe('refreshing');
  // Asking again for the same release is idempotent: same job, nothing staged.
  const again=await manager.start('agent');await manager.settled();
  expect(again.id).toBe(first.id);expect(staged).toEqual(['1.2.15']);
  // A newer one supersedes it rather than waiting for it to give up.
  catalog='1.2.16';
  const next=await manager.start('agent');await manager.settled();
  expect(next.id).not.toBe(first.id);
  expect(staged).toEqual(['1.2.15','1.2.16']);
  expect((await manager.status()).job?.release?.version).toBe('1.2.16');
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('keeps the slot when the engine cannot say what a fresh request would install',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lmc-upgrade-'));let installs=0;
 try{
  const manager=new UpgradeManager(dir,{stage:async(engine:any)=>{installs++;return {engine,version:'1.0.0',directory:dir};},
   activate:async()=>{},sessions:async()=>[{id:'s',state:'pending' as const}],refresh:async()=>({state:'waiting' as const}),inspect:async()=>({})} as any);
  const first=await manager.start('claude');await manager.settled();
  const again=await manager.start('claude');await manager.settled();
  expect(again.id).toBe(first.id);expect(installs).toBe(1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
