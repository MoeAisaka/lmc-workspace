import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { contentPair, wrapKey, unwrapKey, encryptRecord, decryptRecord, verifyMessageBatch, sealBackup, openBackup } from './migration-core.mjs';

test('rewrapping preserves data key and authenticated content, excludes the old account', () => {
  const oldPair=contentPair(randomBytes(32)), nextPair=contentPair(randomBytes(32)), key=randomBytes(32);
  const old=wrapKey(key,oldPair.publicKey), next=wrapKey(unwrapKey(old,oldPair.secretKey),nextPair.publicKey);
  assert.deepEqual(unwrapKey(next,nextPair.secretKey),key);
  assert.throws(()=>unwrapKey(next,oldPair.secretKey));
  const payload={role:'user',text:'保留顺序与中文'};
  assert.deepEqual(decryptRecord(encryptRecord(payload,key),key),payload);
  assert.throws(()=>decryptRecord(encryptRecord(payload,key),randomBytes(32)));
});
test('rejects unsupported encryption versions and modified ciphertext',()=>{
  const pair=contentPair(randomBytes(32)), key=randomBytes(32), wrapped=Buffer.from(wrapKey(key,pair.publicKey),'base64');
  wrapped[0]=9;assert.throws(()=>unwrapKey(wrapped.toString('base64'),pair.secretKey));
  const encrypted=Buffer.from(encryptRecord({a:1},key),'base64');encrypted[20]^=1;
  assert.throws(()=>decryptRecord(encrypted.toString('base64'),key));
});
test('message retries are idempotent but sequence, ID and ownership conflicts are rejected',()=>{
  const a={id:'m1',sessionId:'s1',seq:1,content:{t:'encrypted',c:'a'}};
  assert.equal(verifyMessageBatch('s1',[a],[a]).length,0);
  assert.equal(verifyMessageBatch('s1',[],[a]).length,1);
  assert.throws(()=>verifyMessageBatch('s1',[a],[{...a,content:{t:'encrypted',c:'b'}}]));
  assert.throws(()=>verifyMessageBatch('s1',[a],[{...a,id:'m2'}]));
  assert.throws(()=>verifyMessageBatch('s1',[],[{...a,sessionId:'other'}]));
  assert.throws(()=>verifyMessageBatch('s1',[],[a,{...a,seq:2}]));
});
test('backup is authenticated and cannot be opened with another key',()=>{
  const key=randomBytes(32), data={sessions:[{id:'s1',text:'private'}]};const archive=sealBackup(data,key);
  assert(!archive.includes(Buffer.from('private')));assert.deepEqual(openBackup(archive,key),data);
  assert.throws(()=>openBackup(archive,randomBytes(32)));
});
