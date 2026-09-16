import { mkdir,readFile,writeFile,rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Component,Release } from './managedRuntime';
export type UpgradeSession = {id:string;state:'pending'|'waiting'|'complete'|'blocked';error?:string;
 /** How many times the refresh has been asked for. A session that never answers is named rather than waited on. */
 attempts?:number};
export type UpgradeJob = {id:string;engine:Component;state:'installing'|'activating'|'refreshing'|'complete'|'error';updatedAt:number;release?:Release;activated?:boolean;error?:string;sessions:UpgradeSession[]};
export type UpgradeEffects = {
 ready?():boolean;
 stage(engine:Component):Promise<Release>;
 activate(release:Release):Promise<void>;
 sessions(engine:Component):Promise<UpgradeSession[]>;
 /**
  * Whether a fresh request would install something other than what the job in
  * progress is installing. Must be cheap and free of side effects — it runs
  * before anything is staged — so it is offered only where that is possible.
  */
 supersedes?(engine:Component,inProgress:Release):Promise<boolean>;
 refresh(session:UpgradeSession,release:Release):Promise<Partial<UpgradeSession>>;
 inspect():Promise<unknown>;
};
export class UpgradeManager {
 private running?:Promise<void>;
 private starting?:Promise<UpgradeJob>;
 constructor(private directory:string,private effects:UpgradeEffects){}
 private get file(){return join(this.directory,'upgrade-job.json');}
 async status(){
  let job:UpgradeJob|undefined;
  try{job=JSON.parse(await readFile(this.file,'utf8'));}catch(e:any){if(e.code!=='ENOENT')throw e;}
  return {job};
 }
 private async save(job:UpgradeJob){
  await mkdir(this.directory,{recursive:true,mode:0o700});job.updatedAt=Date.now();
  const temp=this.file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(job),{mode:0o600});await rename(temp,this.file);
 }
 start(engine:Component):Promise<UpgradeJob>{
  if(!['claude','codex','agent'].includes(engine))return Promise.reject(new Error('不支持的升级组件'));
  if(this.starting)return this.starting;
  this.starting=this.startInner(engine).finally(()=>{this.starting=undefined;});return this.starting;
 }
 private async startInner(engine:Component){
  if(engine!=='agent'&&this.effects.ready?.()===false)throw new Error('Agent 正在交接，请等待新版启动后再升级引擎');
  const old=(await this.status()).job;
  if(old&&['installing','activating','refreshing'].includes(old.state)){
   // Returning the job in flight is the right answer to "upgrade again" while
   // one is genuinely running: the request is idempotent and the caller gets
   // the thing it asked about. It is the wrong answer when that job is for a
   // release nobody wants any more — a stuck one then blocks every upgrade
   // after it, and the request looks like it did nothing at all.
   const obsolete=old.state==='refreshing'&&!!old.release
    &&await this.effects.supersedes?.(engine,old.release)===true;
   if(!obsolete)return old;
   old.state='error';old.error='已被更新的版本取代，未完成的会话将在新一轮刷新中重试';
   await this.save(old);
  }
  const job:UpgradeJob={id:randomUUID(),engine,state:'installing',updatedAt:Date.now(),sessions:[]};
  await this.save(job);
  this.running=(async()=>{
   try{
    job.release=await this.effects.stage(engine);
    job.sessions=await this.effects.sessions(engine);
    job.state='activating';await this.save(job);
    await this.effects.activate(job.release);
    job.activated=true;job.state='refreshing';await this.save(job);
    await this.reconcile(job);
   }catch(error){job.state='error';job.error=error instanceof Error?error.message:'升级失败';await this.save(job);}
  })().finally(()=>{this.running=undefined;});
  return job;
 }
 async settled(){await this.running;}
 private async reconcile(job:UpgradeJob){
  for(const session of job.sessions){
   if(session.state==='complete'||session.state==='blocked')continue;
   try{Object.assign(session,await this.effects.refresh(session,job.release!));}
   catch(error){session.error=error instanceof Error?error.message:'设备连接异常，将重试';}
   await this.save(job);
  }
  if(job.sessions.every(s=>s.state==='complete'||s.state==='blocked')){
   job.state=job.sessions.some(s=>s.state==='blocked')?'error':'complete';
   if(job.state==='error')job.error='引擎已安装，部分会话未完成刷新，请查看原因';
  }
  await this.save(job);
 }
 async tick(){
  if(this.running||this.starting)return;
  const job=(await this.status()).job;if(!job)return;
  if(job.state==='refreshing'){
   this.running=this.reconcile(job).finally(()=>{this.running=undefined;});await this.running;
  }else if(job.state==='installing'||job.state==='activating'){
   job.state='error';job.error='升级进程已重启，请检查当前版本后重试；旧版本已保留';await this.save(job);
  }
 }
 async retry(){
  await this.settled();const job=(await this.status()).job;
  if(!job?.release||!job.activated||!job.sessions.length)throw new Error('请重新发起升级');
  for(const session of job.sessions)if(session.state==='blocked'){session.state='pending';delete session.error;}
  job.state='refreshing';delete job.error;await this.save(job);await this.tick();return job;
 }
}
