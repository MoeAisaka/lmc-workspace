import type { PrismaClient } from '@/generated/client';
import { isDeepStrictEqual } from 'node:util';

type Snapshot={session:{id:string;seq:number;metadata:string;metadataVersion:number;agentState?:string|null;agentStateVersion:number;dataEncryptionKey:string;createdAt:number;updatedAt:number;projectId?:string|null};messages:Array<{id:string;sessionId:string;seq:number;localId?:string|null;content:any;createdAt:number;updatedAt:number}>};

// Operator-only module; deliberately has no public HTTP import endpoint.
export async function importSnapshot(db:PrismaClient,accountId:string,snapshot:Snapshot){
 const {session:s,messages}=snapshot;
 if(!s.id||!Number.isSafeInteger(s.seq)||s.seq<0||!s.metadata||!s.dataEncryptionKey)throw Error('Invalid session snapshot');
 return db.$transaction(async tx=>{
  const existing=await tx.session.findUnique({where:{id:s.id}});
  if(existing&&existing.accountId!==accountId)throw Error('Session owner conflict');
  if(existing?.active)throw Error('Target session is active');
  if(existing&&existing.seq>s.seq)throw Error('Newer target sequence conflict');
  const previous=await tx.sessionMessage.findMany({where:{sessionId:s.id}});
  const byId=new Map(previous.map(m=>[m.id,m])),bySeq=new Map(previous.map(m=>[m.seq,m]));
  const seen=new Set<string>(),seenSeq=new Set<number>(),fresh:typeof messages=[];
  for(const m of messages){
   if(m.sessionId!==s.id||!Number.isSafeInteger(m.seq)||m.seq<1||m.seq>s.seq||seen.has(m.id)||seenSeq.has(m.seq))throw Error('Invalid message ownership or sequence');
   seen.add(m.id);seenSeq.add(m.seq);const p=byId.get(m.id);
   if(p){if(p.seq!==m.seq||p.localId!==(m.localId??null)||!isDeepStrictEqual(p.content,m.content))throw Error('Message content conflict');}
   else{if(bySeq.has(m.seq))throw Error('Message sequence conflict');fresh.push(m);}
  }
  if(previous.some(m=>!seen.has(m.id)))throw Error('Snapshot would omit target messages');
  const data={seq:s.seq,metadata:s.metadata,metadataVersion:s.metadataVersion,agentState:s.agentState??null,agentStateVersion:s.agentStateVersion,dataEncryptionKey:Buffer.from(s.dataEncryptionKey,'base64'),projectId:s.projectId??null,active:false,lastActiveAt:new Date(0),updatedAt:new Date(s.updatedAt)};
  if(existing)await tx.session.update({where:{id:s.id},data});
  else await tx.session.create({data:{...data,id:s.id,accountId,tag:'happy-migrated:'+s.id,createdAt:new Date(s.createdAt)}});
  for(let i=0;i<fresh.length;i+=50)await tx.sessionMessage.createMany({data:fresh.slice(i,i+50).map(m=>({...m,localId:m.localId??null,createdAt:new Date(m.createdAt),updatedAt:new Date(m.updatedAt)}))});
  const count=await tx.sessionMessage.count({where:{sessionId:s.id}});
  if(count!==messages.length)throw Error('Imported count mismatch');
  return {id:s.id,inserted:fresh.length,total:count};
 },{timeout:120000,maxWait:10000});
}
