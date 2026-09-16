import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
const nacl=createRequire(new URL('../../packages/lmc-server/package.json',import.meta.url))('tweetnacl');

export function contentPair(secret) {
  if(secret.length!==32)throw Error('Invalid master secret');
  const root=createHmac('sha512','Happy EnCoder Master Seed').update(secret).digest();
  const seed=createHmac('sha512',root.subarray(32)).update(Buffer.concat([Buffer.from([0]),Buffer.from('content')])).digest().subarray(0,32);
  return nacl.box.keyPair.fromSecretKey(createHash('sha512').update(seed).digest().subarray(0,32));
}
export function wrapKey(key,publicKey){
  if(key.length!==32)throw Error('Invalid data key');
  const ephemeral=nacl.box.keyPair(), nonce=randomBytes(24);
  return Buffer.concat([Buffer.from([0]),ephemeral.publicKey,nonce,nacl.box(key,nonce,publicKey,ephemeral.secretKey)]).toString('base64');
}
export function unwrapKey(value,privateKey){
  const b=Buffer.from(value,'base64');if(b.length!==105||b[0]!==0)throw Error('Unsupported wrapped key');
  const key=nacl.box.open(b.subarray(57),b.subarray(33,57),b.subarray(1,33),privateKey);
  if(!key||key.length!==32)throw Error('Cannot decrypt data key');return Buffer.from(key);
}
export function encryptRecord(value,key,variant='dataKey'){
  const plain=Buffer.from(JSON.stringify(value));
  if(variant==='legacy'){const n=randomBytes(24);return Buffer.concat([n,nacl.secretbox(plain,n,key)]).toString('base64');}
  if(variant!=='dataKey')throw Error('Unsupported variant');
  const n=randomBytes(12),c=createCipheriv('aes-256-gcm',key,n);
  return Buffer.concat([Buffer.from([0]),n,c.update(plain),c.final(),c.getAuthTag()]).toString('base64');
}
export function decryptRecord(value,key,variant='dataKey'){
  const b=Buffer.from(value,'base64');let plain;
  if(variant==='legacy'){plain=nacl.secretbox.open(b.subarray(24),b.subarray(0,24),key);if(!plain)throw Error('Cannot decrypt legacy record');}
  else {if(variant!=='dataKey'||b.length<29||b[0]!==0)throw Error('Unsupported record');const c=createDecipheriv('aes-256-gcm',key,b.subarray(1,13));c.setAuthTag(b.subarray(-16));plain=Buffer.concat([c.update(b.subarray(13,-16)),c.final()]);}
  return JSON.parse(Buffer.from(plain).toString());
}
export function verifyMessageBatch(sessionId,existing,incoming){
  const ids=new Map(),seqs=new Map(),fresh=[];
  for(const m of existing){if(m.sessionId!==sessionId)throw Error('Session ownership mismatch');ids.set(m.id,m);seqs.set(m.seq,m);}
  for(const m of incoming){
    if(m.sessionId!==sessionId||!Number.isSafeInteger(m.seq)||m.seq<1)throw Error('Invalid message ownership or sequence');
    const prev=ids.get(m.id),sameSeq=seqs.get(m.seq);
    if(prev){if(prev.seq!==m.seq||prev.localId!==m.localId||!isDeepStrictEqual(prev.content,m.content))throw Error('Message ID content conflict');continue;}
    if(sameSeq)throw Error('Message sequence conflict');
    ids.set(m.id,m);seqs.set(m.seq,m);fresh.push(m);
  }
  return fresh;
}
export function sealBackup(data,key){
  const n=randomBytes(12),c=createCipheriv('aes-256-gcm',key,n);c.setAAD(Buffer.from('LMC migration backup v1'));
  return Buffer.concat([Buffer.from('LMC1'),n,c.update(Buffer.from(JSON.stringify(data))),c.final(),c.getAuthTag()]);
}
export function openBackup(bytes,key){
  const b=Buffer.from(bytes);if(b.subarray(0,4).toString()!=='LMC1')throw Error('Unsupported backup');
  const c=createDecipheriv('aes-256-gcm',key,b.subarray(4,16));c.setAAD(Buffer.from('LMC migration backup v1'));c.setAuthTag(b.subarray(-16));
  return JSON.parse(Buffer.concat([c.update(b.subarray(16,-16)),c.final()]).toString());
}
