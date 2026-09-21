import { trustedProxies } from './trustedProxies';
import { it, expect, vi } from 'vitest';
import Fastify from 'fastify';
vi.mock('@/storage/db', () => ({ db: {} }));
vi.mock('@/lmc/auth', () => ({ lmcAuth: { login: vi.fn(async (_u: string,p: string) => p === 'valid' ? {token:'synthetic'} : null) }, authRevocations: {} }));
import { lmcAuthRoutes } from './routes';
it('keeps legitimate proxy clients independent after a login lockout',async()=>{
 const origin = new URL(process.env.LMC_PUBLIC_ORIGIN || 'http://127.0.0.1:4193').origin;
 const app=Fastify({trustProxy: trustedProxies()});lmcAuthRoutes(app);
 try {
 for(let i=0;i<10;i++)expect((await app.inject({method:'POST',url:'/v1/lmc/login',remoteAddress:'127.0.0.1',headers:{origin,'x-forwarded-for':'192.0.2.10'},payload:{username:'attacker',password:'wrong'}})).statusCode).toBe(401);
 const response=await app.inject({method:'POST',url:'/v1/lmc/login',remoteAddress:'127.0.0.1',headers:{origin,'x-forwarded-for':'192.0.2.11'},payload:{username:'legitimate',password:'valid'}});

 expect(response.statusCode).toBe(200);
 } finally {await app.close();}
});

it('does not trust forwarded IPs from a direct external client', async () => {
 const app=Fastify({trustProxy: trustedProxies()});
 app.get('/', req => ({ip:req.ip}));
 try {
 const res=await app.inject({url:'/',remoteAddress:'192.0.2.10',headers:{'x-forwarded-for':'192.0.2.11'}});
 expect(res.json().ip).toBe('192.0.2.10');
 } finally {await app.close();}
});
