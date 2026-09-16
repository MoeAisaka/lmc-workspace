import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
it('exits gracefully after shutdown hooks instead of leaving a detached center',async()=>{
 const child=spawn(process.execPath,['--import','tsx','sources/lmc/main.ts'],{env:{...process.env,PORT:'0',LMC_WEB_DIR:'',DATA_DIR:mkdtempSync(join(tmpdir(),'lmc-lifecycle-'))},stdio:['ignore','pipe','pipe']});
 let output='';child.stderr.on('data',()=>{});
 try {
  await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('Candidate did not start')),15000);
   child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.includes('API ready')){clearTimeout(timer);resolve();}});
   child.once('exit',()=>{clearTimeout(timer);reject(new Error('Candidate exited before ready'));});
  });
  const ended=new Promise<number|null>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Shutdown retained a process')),5000);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});
  child.kill('SIGTERM');expect(await ended).toBe(0);
 } finally {if(child.exitCode===null)child.kill('SIGKILL');}
},22000);
