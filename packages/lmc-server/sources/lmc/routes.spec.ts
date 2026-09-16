import { afterAll, expect, it } from 'vitest';
import Fastify from 'fastify';
import { randomBytes } from 'node:crypto';
import { db } from '@/storage/db';
import { lmcAuth } from './auth';
import { lmcAuthRoutes } from './routes';
const app=Fastify(); lmcAuthRoutes(app);
const users:string[]=[];
afterAll(async()=>{await app.close();for(const id of users){await db.lmcLogin.deleteMany({where:{accountId:id}});await db.account.delete({where:{id}});}await db.$disconnect();});
it('requires same-origin login, restores cookie credentials and invalidates logout',async()=>{
 const username='test-'+randomBytes(8).toString('hex'),password=randomBytes(24).toString('hex');users.push(await lmcAuth.createAccount(username,password));
 const bad=await app.inject({method:'POST',url:'/v1/lmc/login',headers:{origin:'https://evil.example'},payload:{username,password}});expect(bad.statusCode).toBe(403);
 const result=await app.inject({method:'POST',url:'/v1/lmc/login',headers:{origin:process.env.LMC_PUBLIC_ORIGIN!},payload:{username,password}});expect(result.statusCode).toBe(200);
 const cookie=String(result.headers['set-cookie']).split(';')[0];expect(result.headers['set-cookie']).toContain('HttpOnly');
 const restored=await app.inject({url:'/v1/lmc/session',headers:{cookie}});expect(restored.json()).toEqual(result.json());
 expect((await app.inject({url:'/v1/lmc/session'})).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:'/v1/lmc/logout',headers:{cookie,origin:process.env.LMC_PUBLIC_ORIGIN!}})).statusCode).toBe(200);
 expect((await app.inject({url:'/v1/lmc/session',headers:{cookie}})).statusCode).toBe(401);
});
it('requires browser approval and requester proof before issuing a single device token',async()=>{
 const id=await lmcAuth.createAccount('test-'+randomBytes(8).toString('hex'),randomBytes(24).toString('hex'));users.push(id);
 const browser=await lmcAuth.createToken(id,undefined,'web'),pub=randomBytes(32).toString('base64'),proof=randomBytes(32).toString('base64url');
 const req=()=>app.inject({method:'POST',url:'/v1/auth/request',payload:{publicKey:pub,pollSecret:proof,supportsV2:true}});
 expect((await req()).json().state).toBe('requested');
 expect((await app.inject({method:'POST',url:'/v1/auth/response',payload:{publicKey:pub,response:'encrypted-box'}})).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:'/v1/auth/response',headers:{authorization:'Bearer '+browser},payload:{publicKey:pub,response:'encrypted-box'}})).statusCode).toBe(200);
 expect((await app.inject({method:'POST',url:'/v1/auth/request',payload:{publicKey:pub,pollSecret:'x'.repeat(43)}})).statusCode).toBe(401);
 const approved=await req();expect(approved.json().state).toBe('authorized');expect(await lmcAuth.verifyToken(approved.json().token)).toMatchObject({userId:id,kind:'device'});
 expect((await req()).statusCode).toBe(410);
 await db.terminalAuthRequest.deleteMany({where:{publicKey:Buffer.from(pub,'base64').toString('hex')}});
});
it('rejects cross-account device revocation and invalidates owned devices',async()=>{
 const owner=await lmcAuth.createAccount('test-'+randomBytes(8).toString('hex'),randomBytes(24).toString('hex'));
 const other=await lmcAuth.createAccount('test-'+randomBytes(8).toString('hex'),randomBytes(24).toString('hex'));users.push(owner,other);
 const browser=await lmcAuth.createToken(owner,undefined,'web'),outsider=await lmcAuth.createToken(other,undefined,'web');
 const device=await lmcAuth.createToken(owner);
 const listed=await app.inject({url:'/v1/lmc/devices',headers:{authorization:'Bearer '+browser}});
 const deviceId=listed.json().devices[0].id;
 expect((await app.inject({method:'DELETE',url:'/v1/lmc/devices/'+deviceId,headers:{authorization:'Bearer '+outsider}})).statusCode).toBe(404);
 expect(await lmcAuth.verifyToken(device)).not.toBeNull();
 expect((await app.inject({method:'DELETE',url:'/v1/lmc/devices/'+deviceId,headers:{authorization:'Bearer '+browser}})).statusCode).toBe(200);
 expect(await lmcAuth.verifyToken(device)).toBeNull();
 expect((await app.inject({method:'POST',url:'/v1/auth',payload:{publicKey:randomBytes(32).toString('base64')}})).statusCode).toBe(410);
});
it('expires pending pairing requests instead of accepting delayed approvals',async()=>{
 const owner=await lmcAuth.createAccount('test-'+randomBytes(8).toString('hex'),randomBytes(24).toString('hex'));users.push(owner);
 const browser=await lmcAuth.createToken(owner,undefined,'web'),publicKey=randomBytes(32).toString('base64'),pollSecret=randomBytes(32).toString('base64url');
 await app.inject({method:'POST',url:'/v1/auth/request',payload:{publicKey,pollSecret}});
 await db.terminalAuthRequest.update({where:{publicKey:Buffer.from(publicKey,'base64').toString('hex')},data:{createdAt:new Date(Date.now()-11*60_000)}});
 expect((await app.inject({method:'POST',url:'/v1/auth/response',headers:{authorization:'Bearer '+browser},payload:{publicKey,response:'encrypted'}})).statusCode).toBe(409);
 expect((await app.inject({method:'POST',url:'/v1/auth/request',payload:{publicKey,pollSecret}})).statusCode).toBe(410);
});
it('lets a device revoke its own login without gaining browser privileges',async()=>{
 const owner=await lmcAuth.createAccount('test-'+randomBytes(8).toString('hex'),randomBytes(24).toString('hex'));users.push(owner);
 const token=await lmcAuth.createToken(owner);
 expect((await app.inject({url:'/v1/lmc/devices',headers:{authorization:'Bearer '+token}})).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:'/v1/lmc/device/logout',headers:{authorization:'Bearer '+token}})).statusCode).toBe(200);
 expect(await lmcAuth.verifyToken(token)).toBeNull();
});
