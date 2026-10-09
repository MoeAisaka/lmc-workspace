import { afterAll, expect, it } from 'vitest';
import Fastify from 'fastify';
import { randomBytes, createHash } from 'node:crypto';
import { db } from '@/storage/db';
import { lmcAuth } from './auth';
import { lmcAuthRoutes } from './routes';

const app = Fastify(); lmcAuthRoutes(app);
const users: string[] = [];
afterAll(async () => {
    await app.close();
    for (const id of users) {
        await db.lmcLogin.deleteMany({where: {accountId: id}});
        await db.account.delete({where: {id}});
    }
    await db.$disconnect();
});

it('real password login exposes only stable public identity; rename preserves subject and logout revokes it', async () => {
    const username = 'identity-' + randomBytes(8).toString('hex'), password = randomBytes(24).toString('hex');
    const id = await lmcAuth.createAccount(username, password); users.push(id);
    const login = await app.inject({method: 'POST', url: '/v1/lmc/login', headers: {origin: process.env.LMC_PUBLIC_ORIGIN!}, payload: {username, password}});
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const identity = await app.inject({url: '/v1/lmc/identity', headers: {cookie}});
    expect(identity.statusCode).toBe(200);
    expect(identity.json()).toEqual({version: 1, subject: id, name: username});
    expect(identity.headers['cache-control']).toBe('no-store');
    await db.account.update({where: {id}, data: {username: username + '-renamed'}});
    expect((await app.inject({url: '/v1/lmc/identity', headers: {cookie}})).json().subject).toBe(id);
    expect((await app.inject({method: 'POST', url: '/v1/lmc/logout', headers: {cookie, origin: process.env.LMC_PUBLIC_ORIGIN!}})).statusCode).toBe(200);
    expect((await app.inject({url: '/v1/lmc/identity', headers: {cookie}})).statusCode).toBe(401);
});

it('rejects real device tokens, expired web logins, ambiguous cookies and bearer substitution', async () => {
    const id = await lmcAuth.createAccount('identity-' + randomBytes(8).toString('hex'), randomBytes(24).toString('hex')); users.push(id);
    const web = await lmcAuth.createToken(id, undefined, 'web');
    const device = await lmcAuth.createToken(id, undefined, 'device');
    for (const cookie of ['', 'lmc_session=invalid', `lmc_session=${device}`, `lmc_session=${web}; lmc_session=${web}`]) {
        expect((await app.inject({url: '/v1/lmc/identity', headers: {cookie}})).statusCode).toBe(401);
    }
    expect((await app.inject({url: '/v1/lmc/identity', headers: {authorization: `Bearer ${web}`}})).statusCode).toBe(401);
    expect((await app.inject({url: '/v1/lmc/identity', headers: {cookie: `lmc_session=${web}`, origin: 'https://outside.example'}})).statusCode).toBe(403);
    await db.lmcLogin.update({where: {hash: createHash('sha256').update(web).digest('hex')}, data: {expiresAt: new Date(0)}});
    expect((await app.inject({url: '/v1/lmc/identity', headers: {cookie: `lmc_session=${web}`}})).statusCode).toBe(401);
    expect(await lmcAuth.verifyToken(device)).toMatchObject({userId: id, kind: 'device'});
});
