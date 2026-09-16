import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { db } from '@/storage/db';
import { lmcAuth } from './auth';
const users: string[]=[];
afterAll(async()=> { for(const id of users) { await db.lmcLogin.deleteMany({where:{accountId:id}}); await db.account.delete({where:{id}}); } await db.$disconnect(); });
describe('LMC local authentication',()=> {
 it('uses a stable encrypted account secret and revokes durable tokens',async()=> {
  const username='test-'+randomBytes(8).toString('hex');
  const password=randomBytes(24).toString('hex');
  const id=await lmcAuth.createAccount(username,password); users.push(id);
  expect(await lmcAuth.login(username,'wrong-password')).toBeNull();
  const first=await lmcAuth.login(username,password); expect(first).not.toBeNull();
  const second=await lmcAuth.login(username,password); expect(second!.secret).toBe(first!.secret);
  const account=await db.account.findUniqueOrThrow({where:{id}});
  expect(account.lmcSecret).not.toContain(first!.secret);
  expect(account.lmcPasswordHash).not.toContain(password);
  expect(await lmcAuth.verifyToken(first!.token)).toMatchObject({userId:id});
  await lmcAuth.invalidateToken(first!.token);
  expect(await lmcAuth.verifyToken(first!.token)).toBeNull();
  expect(await lmcAuth.verifyToken(second!.token)).toMatchObject({userId:id});
  await lmcAuth.invalidateUserTokens(id);
  expect(await lmcAuth.verifyToken(second!.token)).toBeNull();
 });
 it('rejects expired tokens even while a prior lookup succeeded',async()=> {
  const id=await lmcAuth.createAccount('test-'+randomBytes(8).toString('hex'),randomBytes(24).toString('hex'));users.push(id);
  const token=await lmcAuth.createToken(id);
  expect(await lmcAuth.verifyToken(token)).toMatchObject({userId:id});
  await db.lmcLogin.updateMany({where:{accountId:id},data:{expiresAt:new Date(0)}});
  expect(await lmcAuth.verifyToken(token)).toBeNull();
 });
});
