import { mkdtemp,mkdir,writeFile,readFile,rename,realpath } from 'node:fs/promises';
import { join,sep } from 'node:path';
import { spawn } from 'cross-spawn';
import { createHash,randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import { parseEngineAuth } from '@/utils/engineAuth';
import { resolveNodeExecutable } from '@/utils/nodeExecutable';
import { selectionFile,readRuntimeSelection,claudeExecutable,codexExecutable,validateRelease,type Component,type Release } from './managedRuntime';
/**
 * Bounded command run. npm and the engines it installs are `.cmd` shims on
 * Windows, which execFile cannot start, so a Windows machine could never stage
 * a managed engine; cross-spawn resolves them. Rejects like execFile did: the
 * error carries a numeric exit `code` and what was printed.
 */
export function run(command:string,args:string[],options:{cwd?:string;timeout:number;maxBuffer:number}):Promise<{stdout:string;stderr:string}>{
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd:options.cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const out:Buffer[]=[],err:Buffer[]=[];let bytes=0,done=false;
  const text=()=>({stdout:Buffer.concat(out).toString('utf8'),stderr:Buffer.concat(err).toString('utf8')});
  const fail=(message:string,code?:number|null)=>{if(done)return;done=true;clearTimeout(timer);reject(Object.assign(new Error(message),{code,...text()}));};
  const timer=setTimeout(()=>{fail('命令超时');child.kill();},options.timeout);
  const collect=(chunks:Buffer[])=>(chunk:Buffer)=>{
   if(done)return;bytes+=chunk.length;
   if(bytes>options.maxBuffer){fail('命令输出过长');child.kill();return;}
   chunks.push(chunk);
  };
  child.stdout!.on('data',collect(out));child.stderr!.on('data',collect(err));
  child.once('error',error=>fail(error.message));
  child.once('close',code=>{if(code!==0){fail('命令退出码 '+code,code);return;}if(done)return;done=true;clearTimeout(timer);resolve(text());});
 });
}
export const packageNames={codex:'@openai/codex',claude:'@anthropic-ai/claude-agent-sdk'} as const;
async function atomicJSON(path:string,value:unknown){const temp=path+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(value),{mode:0o600});await rename(temp,path);}
// npm keeps its cache wherever the user's own npmrc says. When that pointed at
// a volume that was no longer mounted, every lookup and install failed, and the
// engines stopped following their releases. The Agent's npm calls use a cache
// next to the releases they produce instead.
export function npmArguments(home:string=configuration.lmcHomeDir){
 return ['--cache='+join(home,'runtime-releases','.npm-cache'),'--registry=https://registry.npmjs.org'];
}
export async function latestVersion(engine:Component):Promise<string>{
 if(engine==='agent')return (await agentCatalog()).version;
 const {stdout}=await run('npm',['view',packageNames[engine],'version','--json',...npmArguments()],{timeout:30000,maxBuffer:16384});
 const version=JSON.parse(stdout);validateRelease({engine,version,directory:'/validation'});return version;
}
async function agentCatalog():Promise<Release & {sha256:string}>{
 const release=JSON.parse(await readFile(join(configuration.lmcHomeDir,'agent-release-catalog.json'),'utf8'));
 validateRelease(release);if(release.engine!=='agent'||!/^[a-f0-9]{64}$/.test(release.sha256))throw new Error('LMC 发布清单无效');
 return release;
}
export async function stageRelease(engine:Component):Promise<Release>{
 if(engine==='agent'){
  const release=await agentCatalog();
  const root=await realpath(join(configuration.lmcHomeDir,'..','agent-releases'));
  const directory=await realpath(release.directory);
  if(!directory.startsWith(root+sep))throw new Error('LMC 发布目录不受信任');
  const entry=join(directory,'dist','index.mjs');
  const hash=createHash('sha256').update(await readFile(entry)).digest('hex');
  if(hash!==release.sha256)throw new Error('LMC 发布校验失败');
  const nodeBin=resolveNodeExecutable();
  await run(nodeBin,['--check',entry],{timeout:15000,maxBuffer:8192});
  await run(nodeBin,[join(directory,'bin','happy.mjs'),'--version'],{timeout:15000,maxBuffer:8192});
  return release;
 }
 const version=await latestVersion(engine);
 const root=join(configuration.lmcHomeDir,'runtime-releases');await mkdir(root,{recursive:true,mode:0o700});
 const directory=await mkdtemp(join(root,engine+'-'+version+'-'));
 await writeFile(join(directory,'package.json'),JSON.stringify({private:true,name:'lmc-managed-runtime',version:'1.0.0'}));
 // No credential files, project configuration or install scripts enter this directory.
 await run('npm',['install','--prefix',directory,'--ignore-scripts','--no-audit','--no-fund',...npmArguments(),packageNames[engine]+'@'+version],{cwd:directory,timeout:300000,maxBuffer:128*1024});
 const release:Release={engine,version,directory};
 const executable=engine==='claude'?claudeExecutable(release):codexExecutable(release);
 // The first start of a freshly installed binary is slow where a virus scanner
 // inspects it: 17 s was measured on Windows, 0.3 s on the next run.
 await run(executable,['--version'],{timeout:120000,maxBuffer:8192});
 if(engine==='codex')await run(executable,['app-server','--help'],{timeout:15000,maxBuffer:32768});
 else {
  const req=createRequire(join(directory,'package.json'));
  // Verify the SDK and native runtime together, without creating a model turn.
  if(typeof req('@anthropic-ai/claude-agent-sdk').query!=='function')throw new Error('Claude SDK 不兼容');
 }
 let code=0,stdout='',stderr='';
 try{({stdout,stderr}=await run(executable,engine==='claude'?['auth','status','--json']:['login','status'],{timeout:15000,maxBuffer:65536}));}
 catch(error:any){code=typeof error.code==='number'?error.code:-1;stdout=error.stdout??'';stderr=error.stderr??'';}
 if(parseEngineAuth(engine,code,engine==='claude'?stdout:stdout+'\n'+stderr)!=='ready')throw new Error('新引擎认证检查未通过，旧版本及现有会话已保留');
 return release;
}
export async function activateRelease(release:Release){
 validateRelease(release);const previous=readRuntimeSelection();
 // A baseline entry makes Agent rollback possible on the first managed upgrade.
 if(release.engine==='agent'&&!previous.agent){
  const pkg=JSON.parse(await readFile(join(projectPath(),'package.json'),'utf8'));
  previous.agent={engine:'agent',version:pkg.version,directory:projectPath()};
 }
 await atomicJSON(join(configuration.lmcHomeDir,'runtime-previous.json'),previous);
 await atomicJSON(selectionFile(),{...previous,[release.engine]:release});
}
export async function rollbackRelease(){
 const previous=JSON.parse(await readFile(join(configuration.lmcHomeDir,'runtime-previous.json'),'utf8'));
 for(const release of Object.values(previous))validateRelease(release as Release);
 const current=readRuntimeSelection();await atomicJSON(selectionFile(),previous);
 await atomicJSON(join(configuration.lmcHomeDir,'runtime-previous.json'),current);
 return previous;
}
