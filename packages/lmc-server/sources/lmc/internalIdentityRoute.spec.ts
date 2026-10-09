import {describe, it, expect} from 'vitest';
import Fastify from 'fastify';
import {createHash, randomBytes} from 'node:crypto';
import {registerInternalIdentityRoutes} from './internalIdentityRoute';

describe('internal module identity boundary (no DB)', () => {
  it('uses raw peer address, rejects forwarded spoofing, missing and wrong origins', async () => {
    const app = Fastify({trustProxy: true}); let reads = 0;
    registerInternalIdentityRoutes(app, {publicOrigin: 'https://lmc.example', findLogin: async () => {reads++; return null;}});
    try {
      for (const remoteAddress of ['192.168.1.3', '172.31.85.1', '::ffff:192.168.1.3']) {
        const r = await app.inject({url: '/v1/lmc/internal/identity-session', remoteAddress, headers: {origin: 'https://lmc.example', 'x-forwarded-for': '127.0.0.1'}});
        expect(r.statusCode).toBe(403);
      }
      for (const origin of ['', 'https://outside.example']) expect((await app.inject({url: '/v1/lmc/internal/identity-session', headers: {origin}})).statusCode).toBe(403);
      expect(reads).toBe(0);
    } finally {await app.close();}
  });
  it('only returns bounded web identity; duplicate cookies, device, expiry and revocation fail closed', async () => {
    const app = Fastify(); const token = randomBytes(32).toString('base64url');
    const reference = createHash('sha256').update(token).digest('hex');
    let login: {kind: string; expiresAt: Date; account: {id: string; username: string}} | null = {kind: 'web', expiresAt: new Date(Date.now() + 60_000), account: {id: 'owner', username: '测试'}};
    registerInternalIdentityRoutes(app, {publicOrigin: 'https://lmc.example', findLogin: async ref => ref === reference ? login : null});
    const headers = {origin: 'https://lmc.example', cookie: 'lmc_session=' + token};
    try {
      const r = await app.inject({url: '/v1/lmc/internal/identity-session', headers});
      expect(r.statusCode).toBe(200); expect(Object.keys(r.json()).sort()).toEqual(['expiresAt', 'name', 'reference', 'subject', 'version']);
      expect(r.body).not.toContain(token); expect(r.headers['cache-control']).toBe('no-store');
      expect((await app.inject({url: '/v1/lmc/internal/identity-session', headers: {...headers, cookie: headers.cookie + '; ' + headers.cookie}})).statusCode).toBe(401);
      const check = () => app.inject({method: 'POST', url: '/v1/lmc/internal/check-session', headers: {origin: headers.origin}, payload: {reference}});
      expect((await check()).statusCode).toBe(200);
      login!.kind = 'device'; expect((await check()).statusCode).toBe(401);
      login!.kind = 'web'; login!.expiresAt = new Date(0); expect((await check()).statusCode).toBe(401);
      login = null; expect((await check()).statusCode).toBe(401);
    } finally {await app.close();}
  });
});
