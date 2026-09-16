import { afterAll, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { db } from '@/storage/db';
import { updateDatabaseMetrics } from '@/app/monitoring/metrics2';
import { createMessagesAndReturn, findAccountIdsByUsername } from './mysqlCompatibility';
let accountId:string|undefined;
afterAll(async()=>{if(accountId){await db.sessionMessage.deleteMany({where:{session:{accountId}}});await db.session.deleteMany({where:{accountId}});await db.account.delete({where:{id:accountId}});}await db.$disconnect();});
it('inserts message batches with returned identities and reads MySQL metrics',async()=>{
 accountId=(await db.account.create({data:{publicKey:randomBytes(32).toString('hex')}})).id;
 const session=await db.session.create({data:{accountId,tag:'compat',metadata:'encrypted'}});
 const result=await db.$transaction(tx=>createMessagesAndReturn(tx,[{sessionId:session.id,localId:'a',seq:1,content:{t:'encrypted',c:'a'}},{sessionId:session.id,localId:'b',seq:2,content:{t:'encrypted',c:'b'}}]));
 expect(result.map(x=>x.seq)).toEqual([1,2]);expect(result.every(x=>!!x.id)).toBe(true);
 const username='LmcMixed_'+randomBytes(8).toString('hex');
 await db.account.update({where:{id:accountId},data:{username}});
 expect((await findAccountIdsByUsername(username.toLowerCase())).map(x=>x.id)).toContain(accountId);
 await expect(updateDatabaseMetrics()).resolves.toBeUndefined();
});
