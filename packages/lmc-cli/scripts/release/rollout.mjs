import fs from 'node:fs';import os from 'node:os';import {createRequire} from 'node:module';import{createDecipheriv,createCipheriv,randomBytes}from'node:crypto';import{execFileSync}from'node:child_process';
const home=os.homedir(),dir=home+'/.lmc/agent',root=home+'/.lmc/agent-releases/upgrades-20260907',require=createRequire(root+'/package.json'),{io}=require('socket.io-client');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8')),auth=read(dir+'/access.key'),settings=read(dir+'/settings.json'),records=read(dir+'/sessions.json').sessions,url=settings.serverUrl;
const decode=(value,key,variant='dataKey')=>{if(!value)return null;if(variant!=='dataKey')throw Error('Unsupported credential format');const b=Buffer.from(value,'base64'),c=createDecipheriv('aes-256-gcm',key,b.subarray(1,13));c.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([c.update(b.subarray(13,-16)),c.final()]).toString());};
const encode=(data,key)=>{const n=randomBytes(12),c=createCipheriv('aes-256-gcm',key,n);return Buffer.concat([Buffer.from([0]),n,c.update(JSON.stringify(data)),c.final(),c.getAuthTag()]).toString('base64');};
const get=async route=>{const r=await fetch(url+route,{headers:{Authorization:'Bearer '+auth.token},signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('HTTP '+r.status);return r.json();};
const action=process.argv[2]||'snapshot';
if(action==='snapshot'){
 const data=await get('/v2/sessions?limit=200');if(data.hasNext)throw Error('Use paginated verification');
 const pids=new Set(execFileSync('ps',['-axo','pid='],{encoding:'utf8'}).trim().split(/\s+/).map(Number));
 const result=[];for(const raw of data.sessions){const rec=records[raw.id];if(!rec)continue;const key=Buffer.from(rec.encryptionKey,'base64'),meta=decode(raw.metadata,key,rec.encryptionVariant);if(!pids.has(meta.hostPid))continue;const state=decode(raw.agentState,key,rec.encryptionVariant);result.push({id:raw.id,pid:meta.hostPid,engine:meta.flavor,config:meta.sessionConfigState,auth:meta.engineAuth?.status,capabilities:meta.sessionCapabilities,engineRuntime:meta.engineRuntime,agentBuild:meta.agentBuild?.slice(0,12),runtime:state?.runtime,requests:Object.keys(state?.requests??{}).length,seq:raw.seq});}
 console.log(JSON.stringify(result));process.exit(0);
}
const socket=io(url,{path:'/v1/updates',transports:['websocket'],auth:{token:auth.token,clientType:'user-scoped',appState:'background'},reconnection:false});
try{
 await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',()=>reject(Error('Socket unavailable')));setTimeout(()=>reject(Error('Socket timeout')),15000).unref();});
 let id=settings.machineId,key=Buffer.from(auth.encryption.machineKey,'base64'),method,params={};
 if(action==='status')method='runtime-status';
 else if(action==='latest')method='runtime-latest';
 else if(action==='upgrade'){method='runtime-upgrade';params={engine:process.argv[3]||'agent'};}
 else if(action==='retry')method='runtime-retry';
 else if(action==='resource'){id=process.argv[3];key=Buffer.from(records[id].encryptionKey,'base64');method='resource-file';params={path:process.argv[4],action:process.argv[5]||'download'};}
 else throw Error('Unknown action');
 const response=await socket.timeout(45000).emitWithAck('rpc-call',{method:id+':'+method,params:encode(params,key)});if(!response.ok)throw Error(response.error||'RPC failed');const result=decode(response.result,key);
 if(action==='resource'&&result.content){
  const chunks=[Buffer.from(result.content,'base64')];let next=result.nextOffset;
  while(typeof next==='number'){
   const r=await socket.timeout(45000).emitWithAck('rpc-call',{method:id+':resource-file',params:encode({...params,offset:next,revision:result.revision},key)});
   if(!r.ok)throw Error('Chunk RPC failed');const chunk=decode(r.result,key);if(!chunk.success)throw Error(chunk.error);chunks.push(Buffer.from(chunk.content,'base64'));next=chunk.nextOffset;
  }
  const bytes=Buffer.concat(chunks);console.log(JSON.stringify({success:true,name:result.name,size:result.size,receivedBytes:bytes.length,matchesOriginal:bytes.equals(fs.readFileSync(params.path))}));
 }
 else console.log(JSON.stringify(result));
}finally{socket.close();}
