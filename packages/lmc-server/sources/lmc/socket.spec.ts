import { afterAll, expect, it } from 'vitest';
import fastify from 'fastify';
import { io } from 'socket.io-client';
import { randomBytes } from 'node:crypto';
import { lmcAuth } from './auth';
import { startSocket } from '@/app/api/socket';
import { db } from '@/storage/db';
const app=fastify();let id:string|undefined;
afterAll(async()=>{await app.close();if(id){await db.lmcLogin.deleteMany({where:{accountId:id}});await db.account.delete({where:{id}});}await db.$disconnect();});
it('disconnects an authenticated live socket when its login is revoked',async()=>{
 id=await lmcAuth.createAccount('test-'+randomBytes(8).toString('hex'),randomBytes(24).toString('hex'));
 const token=await lmcAuth.createToken(id,undefined,'web');
 startSocket(app as any);await app.listen({port:0,host:'127.0.0.1'});
 const address=app.server.address() as {port:number};
 const client=io('http://127.0.0.1:'+address.port,{path:'/v1/updates',transports:['websocket'],auth:{token,clientType:'user-scoped'},reconnection:false});
 try {
  await new Promise<void>((resolve,reject)=>{client.once('connect',resolve);client.once('connect_error',reject);});
  const disconnected=new Promise<void>(resolve=>client.once('disconnect',()=>resolve()));
  await lmcAuth.invalidateToken(token);await disconnected;expect(client.connected).toBe(false);
 }finally{client.close();}
});
