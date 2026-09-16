import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {SessionEnvelope} from '@lmc/wire';
export type ReviewEntry={id:string;revision:number;turn:string;path:string;kind:'add'|'update'|'delete'|'rename';destination?:string;patch:string;patchFile?:string};
type ReviewData={revision:number;viewed:number;turn:string;entries:ReviewEntry[]};
function safePath(path:unknown):path is string{return typeof path==='string'&&path.length>0&&path.length<4096&&!path.includes('\0')&&!/^[a-z]+:/i.test(path);}
function privatePath(path:string){return /(?:^|\/)(?:\.env(?:\..*)?|access\.key|credentials(?:\.json)?|id_rsa|id_ed25519)$|\.(pem|p12|key)$/i.test(path);}
export function reviewChanges(envelope:SessionEnvelope):Omit<ReviewEntry,'id'|'revision'|'turn'>[]{
 if(envelope.ev.t!=='tool-call-start')return [];
 const {name,args}=envelope.ev;const entries:Omit<ReviewEntry,'id'|'revision'|'turn'>[]=[];
 const add=(path:unknown,kind:ReviewEntry['kind'],patch:unknown,destination?:unknown)=>{
  if(!safePath(path))return;
  const text=privatePath(path)?'此文件仅记录路径，不保存内容差异':typeof patch==='string'?patch:'引擎未提供文本差异';
  entries.push({path,kind,patch:text.length>128000?text.slice(0,128000)+'\n[差异过长，已截断；请打开文件查看]':text,...(safePath(destination)?{destination}: {})});
 };
 if(/patch/i.test(name)&&args.changes&&typeof args.changes==='object'){
  for(const [path,value] of Object.entries(args.changes)){const change=value as any;add(path,change?.move_path?'rename':change?.type==='add'?'add':change?.type==='delete'?'delete':'update',change?.unified_diff??change?.content,change?.move_path);}
 }else if(/write|edit|create.*file/i.test(name)){
  const patch=typeof args.old_string==='string'&&typeof args.new_string==='string'?args.old_string.split('\n').map(l=>'-'+l).join('\n')+'\n'+args.new_string.split('\n').map(l=>'+'+l).join('\n'):typeof args.content==='string'?'[写入内容；原内容未由引擎提供]\n'+args.content:undefined;
  add(args.file_path??args.path??args.filename,'update',patch);
 }
 const patch=args.patch??args.patchText??args.input;
 if(/patch/i.test(name)&&typeof patch==='string'){
  for(const match of patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)\n?([\s\S]*?)(?=^\*\*\* (?:Add|Update|Delete) File:|^\*\*\* End Patch|$(?![\s\S]))/gm)){
   const destination=match[3].match(/^\*\*\* Move to: (.+)$/m)?.[1];
   add(match[2],destination?'rename':match[1]==='Add'?'add':match[1]==='Delete'?'delete':'update',match[3],destination);
  }
 }
 return entries;
}
/** Session-scoped operation journal, independent of the browser's message/DOM window.
 * These are provider-reported changes, not an attribution of the whole working tree.
 */
export class ResourceReview{
 private pending:Promise<unknown>=Promise.resolve();
 constructor(private directory:string){}
 async flush(){await this.pending;}
 private async load():Promise<ReviewData>{try{return JSON.parse(await readFile(join(this.directory,'index.json'),'utf8'));}catch(e:any){if(e.code==='ENOENT')return {revision:0,viewed:0,turn:'',entries:[]};throw e;}}
 private async save(data:ReviewData){await mkdir(this.directory,{recursive:true,mode:0o700});const temp=join(this.directory,randomUUID()+'.tmp');await writeFile(temp,JSON.stringify(data),{mode:0o600});await rename(temp,join(this.directory,'index.json'));}
 observe(envelope:SessionEnvelope):Promise<void>{
  const changes=reviewChanges(envelope);
  if(!changes.length&&envelope.ev.t!=='turn-start')return Promise.resolve();
  const action=this.pending.then(async()=>{
   const data=await this.load();
   if(envelope.ev.t==='turn-start'&&!envelope.subagent){data.turn=envelope.turn??'';await this.save(data);return;}
   const operationId=envelope.ev.t==='tool-call-start'?envelope.ev.call:envelope.id;
   if(data.entries.some(e=>e.id===operationId))return;
   if(!data.turn)data.turn=envelope.turn??'';
   await mkdir(this.directory,{recursive:true,mode:0o700});
   for(const change of changes){
    const revision=++data.revision;const patchFile=revision+'.txt';
    await writeFile(join(this.directory,patchFile),change.patch,{mode:0o600});
    data.entries.push({...change,patch:'',patchFile,id:operationId,revision,turn:envelope.turn??''});
   }
   await this.save(data);
  });
  this.pending=action.catch(()=>{});return action;
 }
 async read(scope:'all'|'turn'|'unseen',before?:number){
  await this.pending;const data=await this.load();
  const selected=data.entries.filter(e=>(before===undefined||e.revision<before)&&(scope==='all'||scope==='turn'&&e.turn===data.turn||scope==='unseen'&&e.revision>data.viewed));
  const page=selected.slice(-20);
  const entries=await Promise.all(page.map(async e=>{
   const patch=e.patchFile&&/^\d+\.txt$/.test(e.patchFile)?await readFile(join(this.directory,e.patchFile),'utf8'):e.patch;
   return {...e,patch:patch.length>12000?patch.slice(0,12000)+'\n[预览已截断，请打开文件查看]':patch};
  }));
  return {cursor:data.revision,paths:[...new Set(data.entries.flatMap(e=>[e.path,...(e.destination?[e.destination]:[])]))],entries,olderCursor:selected.length>20?page[0].revision:undefined};
 }
 markViewed(cursor:number):Promise<void>{
  const action=this.pending.then(async()=>{const data=await this.load();if(!Number.isSafeInteger(cursor)||cursor<0||cursor>data.revision)throw new Error('无效的审阅位置');data.viewed=Math.max(data.viewed,cursor);await this.save(data);});this.pending=action.catch(()=>{});return action;
 }
}
