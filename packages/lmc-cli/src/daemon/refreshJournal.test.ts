import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RefreshJournal } from './refreshJournal';
it('retains accepted handoffs across daemon restart and updates atomically', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'lmc-refresh-'));
 try {
  const first = new RefreshJournal(dir);
  await first.put({ sessionId:'test', pid:123, options:{receiveSeq:9}, state:'waiting', updatedAt:1 });
  const restarted = new RefreshJournal(dir);
  expect(await restarted.list()).toEqual([{sessionId:'test',pid:123,options:{receiveSeq:9},state:'waiting',updatedAt:1}]);
  await restarted.put({sessionId:'test',pid:123,options:{receiveSeq:9},state:'error',error:'认证失败',updatedAt:2});
  expect((await first.list())[0].state).toBe('error');
  await first.remove('test'); expect(await restarted.list()).toEqual([]);
 } finally { await rm(dir,{recursive:true,force:true}); }
});
it('rejects invalid job identities instead of writing outside its journal', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'lmc-refresh-'));
 try { await expect(new RefreshJournal(dir).put({sessionId:'../bad',pid:1,options:{},state:'waiting',updatedAt:1})).rejects.toThrow(); }
 finally { await rm(dir,{recursive:true,force:true}); }
});
