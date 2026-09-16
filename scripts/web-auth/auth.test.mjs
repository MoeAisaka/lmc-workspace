import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueCookie, checkCookie, safeReturnPath } from './auth.mjs';
const key=Buffer.alloc(32,7);
test('persistent cookie survives service recreation but rejects tampering, expiry and credential changes',()=>{
 const cookie=issueCookie(key,'revision',1000,3600);
 assert.equal(checkCookie(cookie,key,'revision',1001),true);
 assert.equal(checkCookie(cookie+'x',key,'revision',1001),false);
 assert.equal(checkCookie(cookie,key,'changed',1001),false);
 assert.equal(checkCookie(cookie,key,'revision',4600),false);
 assert.equal(checkCookie(cookie,Buffer.alloc(32,8),'revision',1001),false);
});
test('only local return paths are accepted',()=>{
 for(const p of ['https://evil.test','//evil.test','/\\evil.test','/\r\nLocation: x','/_lmc-auth/login']) assert.equal(safeReturnPath(p),'/');
 assert.equal(safeReturnPath('/session/abc?x=1'),'/session/abc?x=1');
});
import { createAuthServer } from './server.mjs';
test('HTTP gate remembers login, rejects wrong origin/password, and emits protected cookies', async () => {
 let clock=1000;
 const server=createAuthServer({origin:'https://happy.test',key,revision:()=> 'rev',now:()=>clock,verify:async(u,p)=>u==='operator'&&p==='test-only'});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}`;
 try {
  let r=await fetch(url+'/check',{redirect:'manual',headers:{'x-forwarded-uri':'/session/test'}});assert.equal(r.status,302);assert.match(r.headers.get('location'),/session/);
  const page=await fetch(url+'/_lmc-auth/login');
  assert.match(await page.text(), /<meta name="referrer" content="same-origin">/);
  const login=(origin,password)=>fetch(url+'/_lmc-auth/login',{method:'POST',redirect:'manual',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'operator',password,remember:'1',next:'/session/test'})});
  assert.equal((await login('https://evil.test','test-only')).status,403);
  assert.equal((await login('null','test-only')).status,403);
  assert.equal((await login('https://happy.test','wrong')).status,401);
  r=await login('https://happy.test','test-only');assert.equal(r.status,303);
  const setCookie=r.headers.get('set-cookie');for(const flag of ['HttpOnly','Secure','SameSite=Lax','Max-Age=2592000'])assert.ok(setCookie.includes(flag));
  const cookie=setCookie.split(';')[0];assert.equal((await fetch(url+'/check',{headers:{cookie}})).status,204);
  clock+=30*86400;assert.equal((await fetch(url+'/check',{headers:{cookie},redirect:'manual'})).status,302);
 } finally { await new Promise(resolve=>server.close(resolve)); }
});
