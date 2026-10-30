import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import { createRequire } from 'node:module';
import { sessionRoutes } from '@/app/api/routes/sessionRoutes';
import { v3SessionRoutes } from '@/app/api/routes/v3SessionRoutes';
import { attachmentRoutes } from '@/app/api/routes/attachmentRoutes';
import { putLocalFile } from '@/storage/files';
import { startSocket } from '@/app/api/socket';
import { eventRouter, buildSessionActivityEphemeral } from '@/app/events/eventRouter';
import { readableSession } from './sessions';
// Exercise the same Socket.IO client already used by the CLI, without adding
// a second client dependency solely for this isolated integration fixture.
const { io } = createRequire(new URL('../../../../lmc-cli/package.json', import.meta.url))('socket.io-client');
import { db } from '@/storage/db';
import { lmcAuth, authRevocations } from '../auth';
import { accountsService } from './accounts';
import { resourcesService, readableFile } from './resources';
import { registerAccountRoutes } from './routes';
import { registerResourceRoutes } from './resourceRoutes';
import { registerCommandRoutes } from './commandRoutes';
import { registerDeviceRunRoutes } from './deviceRuns';
import { encryptResourceJson, decryptResourceJson } from './resourceCrypto';
import { accessTransaction } from './transaction';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { fileAssetRoutes } from '@/app/api/routes/fileAssetRoutes';
import { deriveKey } from '../../../../lmc-cli/src/utils/deriveKey';
import { libsodiumEncryptForPublicKey, libsodiumPublicKeyFromSecretKey, encryptLegacy } from '../../../../lmc-cli/src/api/encryption';

// These tests cannot run against a developer's implicit/prod DATABASE_URL.
const enabled = process.env.LMC_MULTI_ACCOUNT_TEST === '1';
const testTargets = new Map([
    ['mysql://root@127.0.0.1:43317/lmc_multiaccount_test', '/tmp/lmc-multiaccount-20261023/data'],
    ['mysql://root@127.0.0.1:43318/lmc_multiaccount_test', '/tmp/lmc-multiaccount-mysql84-20261024/files'],
]);
if (enabled && !testTargets.has(process.env.DATABASE_URL ?? '')) throw new Error('Use the isolated multiaccount test database');
describe.skipIf(!enabled)('multi-account isolated database integration', () => {
    const app = Fastify();
    const origin = 'http://127.0.0.1:4193';
    type User = { id: string; token: string; secret: string; username: string; password: string };
    let admin: User, a: User, b: User, c: User;
    let socketUrl: string;
    const sockets: any[] = [];
    const event = (socket: any, name: string) => new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => { socket.off(name, receive); reject(new Error('Missing socket event: ' + name)); }, 3000);
        const receive = (data: any) => { clearTimeout(timer); resolve(data); };
        socket.once(name, receive);
    });
    async function connect(user: User, scope: Record<string, string | number> = {}) {
        const socket = io(socketUrl, { path: '/v1/updates', transports: ['websocket'], reconnection: false,
            auth: { token: user.token, clientType: 'user-scoped', ...scope }, extraHeaders: { origin } });
        sockets.push(socket);
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Socket connect timed out')), 3000);
            socket.once('connect', () => { clearTimeout(timer); resolve(); });
            socket.once('connect_error', (error: Error) => { clearTimeout(timer); socket.close(); reject(error); });
        });
        return socket;
    }
    async function session(owner: User, sealed = true) {
        const key = randomBytes(32), id = randomUUID();
        const pub = libsodiumPublicKeyFromSecretKey(await deriveKey(Buffer.from(owner.secret, 'base64url'), 'Happy EnCoder', ['content']));
        const envelope = sealed ? Buffer.concat([Buffer.from([0]), libsodiumEncryptForPublicKey(key, pub)]) : null;
        const project = await db.project.create({ data: { accountId: owner.id, externalId: id, metadata: 'private-project' } });
        await db.session.create({ data: { id, tag: id, accountId: owner.id, metadata: 'synthetic-ciphertext', dataEncryptionKey: envelope, projectId: project.id } });
        await db.sessionMessage.create({ data: { sessionId: id, seq: 1, content: { t: 'encrypted', c: 'synthetic-history' } } });
        await putLocalFile(`sessions/${id}/attachments/probe.bin`, Buffer.from('synthetic-encrypted-attachment'));
        return { id, key, projectId: project.id, envelope };
    }
    const shareSession = (id: string, version: number, readers: User[]) => resourcesService.set(a.id, 'session', id, {
        version, adminManaged: false, grants: readers.map(u => ({ accountId: u.id, actions: ['read'] })) });
    async function create(role: 'admin' | 'member' = 'member'): Promise<User> {
        const username = 'acl-' + randomBytes(8).toString('hex'), password = randomBytes(20).toString('hex');
        const id = await lmcAuth.createAccount(username, password);
        if (role === 'admin') await db.account.update({ where: { id }, data: { role } });
        return { id, username, password, ...(await lmcAuth.login(username, password))! };
    }
    async function file(owner: User, keyMode: 'sealed' | 'legacy' = 'sealed') {
        const key = randomBytes(32), id = randomUUID(), secret = Buffer.from(owner.secret, 'base64url');
        const pub = libsodiumPublicKeyFromSecretKey(await deriveKey(secret, 'Happy EnCoder', ['content']));
        const ownerKey = keyMode === 'sealed' ? Buffer.concat([Buffer.from([0]), libsodiumEncryptForPublicKey(key, pub)]) : encryptLegacy(key.toString('base64'), secret);
        await db.fileAsset.create({ data: { id, accountId: owner.id, keyMode, ownerKey, state: 'ready', size: BigInt(0), partCount: 1, manifest: randomBytes(40) } });
        return { id, key };
    }
    const headers = (user: User) => ({ authorization: 'Bearer ' + user.token, origin });
    beforeAll(async () => {
        if (process.env.DATA_DIR !== testTargets.get(process.env.DATABASE_URL!)) throw new Error('Use isolated attachment storage');
        process.env.LMC_MASTER_KEY = '11'.repeat(32); process.env.LMC_MULTI_ACCOUNT_ENABLED = '1';
        // Single dedicated disposable schema; rerunning test cleans its fixtures only.
        await db.lmcSharedCommand.deleteMany(); await db.lmcDeviceRun.deleteMany(); await db.fileDelivery.deleteMany();
        await db.lmcResourceGrant.deleteMany(); await db.lmcResourcePolicy.deleteMany(); await db.lmcAccessAudit.deleteMany(); await db.lmcInvitation.deleteMany(); await db.fileAssetPart.deleteMany(); await db.fileAsset.deleteMany(); await db.lmcLogin.deleteMany(); await db.terminalAuthRequest.deleteMany(); await db.sessionMessage.deleteMany(); await db.accessKey.deleteMany(); await db.usageReport.deleteMany(); await db.session.deleteMany(); await db.project.deleteMany(); await db.machine.deleteMany(); await db.account.deleteMany();
        admin = await create('admin'); a = await create(); b = await create(); c = await create();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app as any); fileAssetRoutes(app as any);
        sessionRoutes(app as any); v3SessionRoutes(app as any); attachmentRoutes(app as any); startSocket(app as any);
        const deps = { origin, enabled: () => true, verifyToken: (token: string) => lmcAuth.verifyToken(token) };
        registerAccountRoutes(app, { ...deps, accounts: accountsService }); registerResourceRoutes(app, { ...deps, resources: resourcesService });
        registerCommandRoutes(app, deps); registerDeviceRunRoutes(app, deps);
        socketUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    }, 30000);
    afterAll(async () => { sockets.forEach(s => s.close()); await app.close(); await db.$disconnect(); });
    it('requires web auth and administrator role, does not return secrets', async () => {
        const device = await lmcAuth.createToken(admin.id);
        expect((await app.inject({ url: '/v1/lmc/accounts', headers: { authorization: 'Bearer ' + device } })).statusCode).toBe(401);
        expect((await app.inject({ url: '/v1/lmc/accounts', headers: headers(a) })).statusCode).toBe(403);
        const response = await app.inject({ url: '/v1/lmc/accounts', headers: headers(admin) });
        expect(response.statusCode).toBe(200);
        expect(response.body).not.toMatch(/lmcSecret|password|tokenHash|publicKey/);
        expect((await app.inject({ url: '/v1/lmc/accounts', headers: { ...headers(admin), origin: 'https://outside.invalid' } })).statusCode).toBe(403);
    });
    it('claims an invitation once under concurrent requests and never stores its token', async () => {
        const invitation = await accountsService.invite(admin.id);
        const record = await db.lmcInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
        expect(record.tokenHash).not.toBe(invitation.token);
        expect(JSON.stringify(record)).not.toContain(invitation.token);
        const results = await Promise.allSettled([accountsService.accept(invitation.token, 'new-' + randomBytes(6).toString('hex'), 'synthetic-password-123'), accountsService.accept(invitation.token, 'new-' + randomBytes(6).toString('hex'), 'synthetic-password-456')]);
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        const winner = results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<{ id: string }>;
        expect((await db.account.findUniqueOrThrow({ where: { id: winner.value.id } })).role).toBe('member');
        const revoked = await accountsService.invite(admin.id); await accountsService.revokeInvitation(admin.id, revoked.id);
        await expect(accountsService.accept(revoked.token, 'no-access', 'synthetic-password-123')).rejects.toMatchObject({ status: 410 });
    });
    it.each(['sealed', 'legacy'] as const)('shares only one %s file key, hides it from unrelated accounts/admin and revokes', async mode => {
        const asset = await file(a, mode);
        const privateAsset = await file(a);
        await resourcesService.set(a.id, 'file', asset.id, { version: 0, adminManaged: false, grants: [{ accountId: b.id, actions: ['read'] }] });
        const allowed = await readableFile(b.id, asset.id);
        expect(allowed).not.toBeNull(); expect(allowed!.keyMode).toBe('sealed');
        const seed = await deriveKey(Buffer.from(b.secret, 'base64url'), 'Happy EnCoder', ['content']);
        const secret = createHash('sha512').update(seed).digest().subarray(0, 32), wrapped = allowed!.ownerKey;
        expect(Buffer.from(nacl.box.open(wrapped.slice(57), wrapped.slice(33, 57), wrapped.slice(1, 33), secret)!)).toEqual(asset.key);
        expect(await readableFile(c.id, asset.id)).toBeNull(); expect(await readableFile(admin.id, asset.id)).toBeNull(); expect(await readableFile(b.id, privateAsset.id)).toBeNull();
        const list = await app.inject({ url: '/v1/files', headers: headers(b) });
        expect(list.statusCode).toBe(200); expect(list.json().files.some((f: any) => f.id === asset.id)).toBe(true); expect(list.body).not.toContain(privateAsset.id);
        await expect(resourcesService.set(b.id, 'file', asset.id, { version: 1, adminManaged: false, grants: [{ accountId: c.id, actions: ['read'] }] })).rejects.toMatchObject({ status: 403 });
        expect((await app.inject({ method: 'POST', url: '/v1/files/' + asset.id + '/deliveries', headers: headers(b), payload: { id: randomUUID(), sessionId: 'guessed-session', ciphertext: Buffer.alloc(100).toString('base64') } })).statusCode).toBe(404);
        await resourcesService.set(a.id, 'file', asset.id, { version: 1, adminManaged: false, grants: [] });
        expect((await app.inject({ url: '/v1/files/' + asset.id, headers: headers(b) })).statusCode).toBe(404);
        expect((await app.inject({ url: '/v1/files/' + asset.id + '/parts/0', headers: headers(b) })).statusCode).toBe(404);
    });
    it('serializes conflicting grant updates and honors administrator control', async () => {
        const asset = await file(a);
        const changes = await Promise.allSettled([b, c].map(user => resourcesService.set(a.id, 'file', asset.id, { version: 0, adminManaged: false, grants: [{ accountId: user.id, actions: ['read'] }] })));
        expect(changes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        await resourcesService.set(admin.id, 'file', asset.id, { version: 1, adminManaged: true, grants: [{ accountId: b.id, actions: ['read'] }] });
        await expect(resourcesService.set(a.id, 'file', asset.id, { version: 2, adminManaged: false, grants: [] })).rejects.toMatchObject({ status: 403 });
        expect((await resourcesService.audit(a.id, 'file', asset.id)).some(e => e.actorId === admin.id)).toBe(true);
        expect(await readableFile(admin.id, asset.id)).toBeNull();
    });
    it('keeps the last admin and revokes disabled member tokens and pending pairing', async () => {
        await expect(accountsService.update(admin.id, admin.id, { role: 'member', enabled: true, version: 0 })).rejects.toMatchObject({ code: 'last_admin' });
        const member = await create(); const device = await lmcAuth.createToken(member.id);
        const notices: string[] = []; const listener = (id: string) => notices.push(id); authRevocations.on('user', listener);
        await db.terminalAuthRequest.create({ data: { publicKey: randomBytes(32).toString('hex'), responseAccountId: member.id, response: 'synthetic' } });
        await accountsService.update(admin.id, member.id, { role: 'member', enabled: false, version: 0 });
        authRevocations.off('user', listener);
        expect(notices).toContain(member.id); expect(await lmcAuth.verifyToken(member.token)).toBeNull(); expect(await lmcAuth.verifyToken(device)).toBeNull();
        expect(await lmcAuth.login(member.username, member.password)).toBeNull();
        expect(await db.terminalAuthRequest.count({ where: { responseAccountId: member.id, consumedAt: null } })).toBe(0);
        await expect(lmcAuth.createToken(member.id)).rejects.toThrow();
        await accountsService.update(admin.id, member.id, { role: 'member', enabled: true, version: 1 });
        expect(await lmcAuth.verifyToken(device)).toBeNull();
    });
    it('rolls back the entire ACL when key redistribution fails; disabling the feature revokes shared reads', async () => {
        const asset = await file(a);
        await resourcesService.set(a.id, 'file', asset.id, { version: 0, adminManaged: false, grants: [{ accountId: b.id, actions: ['read'] }] });
        await db.fileAsset.update({ where: { id: asset.id }, data: { ownerKey: randomBytes(105) } });
        await expect(resourcesService.set(a.id, 'file', asset.id, { version: 1, adminManaged: false, grants: [{ accountId: c.id, actions: ['read'] }] })).rejects.toMatchObject({ code: 'key_unavailable' });
        expect(await resourcesService.get(a.id, 'file', asset.id)).toMatchObject({ version: 1, grants: [{ accountId: b.id, actions: ['read'] }] });
        process.env.LMC_MULTI_ACCOUNT_ENABLED = '0';
        expect(await readableFile(b.id, asset.id)).toBeNull();
        expect(await readableFile(a.id, asset.id)).not.toBeNull();
        process.env.LMC_MULTI_ACCOUNT_ENABLED = '1';
    });
    it('shares only a session key/history/attachments, hides project linkage and excludes other accounts and device tokens', async () => {
        const shared = await session(a), privateSession = await session(a);
        await shareSession(shared.id, 0, [b]);
        const response = await app.inject({ url: `/v1/sessions/${shared.id}`, headers: headers(b) });
        expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
        const row = response.json().session;
        expect(row).toMatchObject({ shared: true, accessVersion: 1, projectId: null });
        const seed = await deriveKey(Buffer.from(b.secret, 'base64url'), 'Happy EnCoder', ['content']);
        const secret = createHash('sha512').update(seed).digest().subarray(0, 32), wrapped = Buffer.from(row.dataEncryptionKey, 'base64');
        expect(Buffer.from(nacl.box.open(wrapped.slice(57), wrapped.slice(33, 57), wrapped.slice(1, 33), secret)!)).toEqual(shared.key);
        expect(row.dataEncryptionKey).not.toBe(shared.envelope!.toString('base64'));
        for (const path of ['/v2/sessions/active', '/v2/sessions?changedSince=' + (Date.now() + 60000)]) {
            const list = (await app.inject({ url: path, headers: headers(b) })).json();
            expect(list.sessions.find((s: any) => s.id === shared.id)).toMatchObject({ shared: true, accessVersion: 1, projectId: null });
        }
        const catalog = (await app.inject({ url: '/v1/sessions', headers: headers(b) })).json();
        expect(catalog.sharedSessionIds).toContain(shared.id); expect(catalog.sharedSessionIds).not.toContain(privateSession.id);
        expect(catalog.sessions.find((s: any) => s.id === shared.id).projectId).toBeNull();
        for (const path of [`/v1/sessions/${shared.id}/messages`, `/v3/sessions/${shared.id}/messages`]) {
            const result = await app.inject({ url: path, headers: headers(b) });
            expect(result.statusCode).toBe(200); expect(result.body).toContain('synthetic-history');
        }
        const attachment = await app.inject({ url: `/v1/sessions/${shared.id}/attachments/probe.bin`, headers: headers(b) });
        expect(attachment.statusCode).toBe(200); expect(attachment.body).toBe('synthetic-encrypted-attachment');
        for (const denied of [admin, c, { ...b, token: await lmcAuth.createToken(b.id) }]) {
            expect((await app.inject({ url: `/v1/sessions/${shared.id}`, headers: headers(denied) })).statusCode).toBe(404);
            expect((await app.inject({ url: `/v3/sessions/${shared.id}/messages`, headers: headers(denied) })).statusCode).toBe(404);
            expect((await app.inject({ url: `/v1/sessions/${shared.id}/attachments/probe.bin`, headers: headers(denied) })).statusCode).toBe(404);
        }
        expect((await app.inject({ url: `/v1/sessions/${privateSession.id}`, headers: headers(b) })).statusCode).toBe(404);
    });
    it('fails closed for root-key sessions, execution grants and shared mutations', async () => {
        const legacy = await session(a, false), shared = await session(a);
        expect((await resourcesService.get(a.id, 'session', legacy.id)).sharingSupported).toBe(false);
        await expect(shareSession(legacy.id, 0, [b])).rejects.toMatchObject({ code: 'legacy_key' });
        await expect(resourcesService.set(a.id, 'session', shared.id, { version: 0, adminManaged: false, grants: [{ accountId: b.id, actions: ['read', 'configure'] }] })).rejects.toMatchObject({ status: 400 });
        await shareSession(shared.id, 0, [b]);
        for (const denied of [b, c, admin]) {
            expect((await app.inject({ method: 'POST', url: `/v3/sessions/${shared.id}/messages`, headers: headers(denied), payload: { messages: [{ localId: 'forged', content: 'forged' }] } })).statusCode).toBe(404);
            expect((await app.inject({ method: 'POST', url: `/v1/sessions/${shared.id}/archive`, headers: headers(denied) })).statusCode).toBe(404);
            expect((await app.inject({ method: 'DELETE', url: `/v1/sessions/${shared.id}`, headers: headers(denied) })).statusCode).toBe(404);
            expect((await app.inject({ method: 'POST', url: `/v1/sessions/${shared.id}/attachments/request-upload`, headers: headers(denied), payload: { filename: 'probe', size: 10 } })).statusCode).toBe(404);
        }
        expect(await db.sessionMessage.count({ where: { sessionId: shared.id } })).toBe(1);
        expect(await db.session.findUnique({ where: { id: shared.id } })).toMatchObject({ active: true });
    });
    it('uses content-free shared notifications and rejects impersonated agent scopes on live sockets', async () => {
        const shared = await session(a); await shareSession(shared.id, 0, [b]);
        const owner = await connect(a), reader = await connect(b), stranger = await connect(c);
        const device = await connect({ ...b, token: await lmcAuth.createToken(b.id) });
        await expect(connect(b, { clientType: 'session-scoped', sessionId: shared.id })).rejects.toThrow('Session scope rejected');
        const observed: unknown[] = [], wrongRooms: unknown[] = [];
        reader.on('update', (v: unknown) => observed.push(v)); reader.on('ephemeral', (v: unknown) => observed.push(v));
        stranger.on('shared-session-changed', (v: unknown) => wrongRooms.push(v)); device.on('shared-session-changed', (v: unknown) => wrongRooms.push(v));
        const notice = event(reader, 'shared-session-changed');
        eventRouter.emitEphemeral({ userId: a.id, payload: buildSessionActivityEphemeral(shared.id, true, Date.now(), true) });
        expect(await notice).toEqual({ sessionId: shared.id });
        const metadata = await reader.timeout(2000).emitWithAck('update-metadata', { sid: shared.id, metadata: 'forged', expectedVersion: 0 });
        expect(metadata.result).toBe('error');
        expect(await db.session.findUnique({ where: { id: shared.id } })).toMatchObject({ metadata: 'synthetic-ciphertext' });
        // Identical method names stay inside each account's room. A reader
        // cannot hijack the owner's registered Agent or call through its room.
        const method = shared.id + ':permission';
        const ownerAgent = await connect(a, { clientType: 'session-scoped', sessionId: shared.id }), readerAgent = await connect(b);
        const ownerRegistered = event(ownerAgent, 'rpc-registered'); ownerAgent.emit('rpc-register', { method }); await ownerRegistered;
        const readerRegistered = event(readerAgent, 'rpc-registered'); readerAgent.emit('rpc-register', { method }); await readerRegistered;
        ownerAgent.on('rpc-request', (_: unknown, reply: (v: string) => void) => reply('owner-only'));
        readerAgent.on('rpc-request', (_: unknown, reply: (v: string) => void) => reply('reader-own-room'));
        expect((await reader.timeout(2000).emitWithAck('rpc-call', { method, params: 'opaque' })).result).toBe('reader-own-room');
        expect((await owner.timeout(2000).emitWithAck('rpc-call', { method, params: 'opaque' })).result).toBe('owner-only');
        expect(observed).toEqual([]); expect(wrongRooms).toEqual([]);
        const revoke = event(reader, 'session-access-changed'); await shareSession(shared.id, 1, []);
        expect(await revoke).toEqual({ sessionId: shared.id });
        expect((await app.inject({ url: `/v3/sessions/${shared.id}/messages`, headers: headers(b) })).statusCode).toBe(404);
        expect((await app.inject({ url: `/v1/sessions/${shared.id}/attachments/probe.bin`, headers: headers(b) })).statusCode).toBe(404);
        expect((await app.inject({ url: '/v1/sessions', headers: headers(b) })).json().sharedSessionIds).not.toContain(shared.id);
        [owner, reader, stranger, device, ownerAgent, readerAgent].forEach(s => s.close());
    });
    it('disabling a member disconnects an already connected browser and denies session reads', async () => {
        const member = await create(), shared = await session(a); await shareSession(shared.id, 0, [member]);
        const socket = await connect(member), disconnect = event(socket, 'disconnect');
        await accountsService.update(admin.id, member.id, { role: 'member', enabled: false, version: 0 });
        await disconnect; expect(socket.connected).toBe(false);
        expect((await app.inject({ url: `/v1/sessions/${shared.id}`, headers: headers(member) })).statusCode).toBe(401);
        process.env.LMC_MULTI_ACCOUNT_ENABLED = '0';
        expect(await readableSession(member.id, shared.id, 'web')).toBeNull();
        expect(await readableSession(a.id, shared.id, 'web')).not.toBeNull();
        process.env.LMC_MULTI_ACCOUNT_ENABLED = '1';
    });
    it('authenticates shared authors, deduplicates sends and rechecks revoked queue entries', async () => {
        const shared = await session(a);
        await db.session.update({ where: { id: shared.id }, data: { seq: 1 } });
        await resourcesService.set(a.id, 'session', shared.id, { version: 0, adminManaged: false, grants: [{ accountId: b.id, actions: ['read', 'send', 'stop', 'approve'] }] });
        const deviceToken = await lmcAuth.createToken(a.id);
        const submit = (user = b, requestId = 'shared-one', value: unknown = { text: 'Review this proposal' }) => app.inject({ method: 'POST', url: `/v1/lmc/sessions/${shared.id}/commands`, headers: headers(user), payload: { requestId, content: encryptResourceJson(shared.key, value) } });
        expect((await submit()).statusCode).toBe(409);
        const runner = await connect({ ...a, token: deviceToken }, { clientType: 'session-scoped', sessionId: shared.id, collaborationProtocol: 1 });
        expect((await submit(c)).statusCode).toBe(403);
        expect((await submit(b, 'forged-author', { text: 'hello', role: 'assistant' })).statusCode).toBe(400);
        expect((await submit(b, 'login-command', { text: '/login' })).statusCode).toBe(400);
        const first = await submit(); expect(first.statusCode).toBe(200);
        const id = first.json().commandId;
        expect((await submit()).json().commandId).toBe(id);
        expect(await db.sessionMessage.count({ where: { sessionId: shared.id, localId: id } })).toBe(1);
        const stored = await db.sessionMessage.findFirstOrThrow({ where: { sessionId: shared.id, localId: id } });
        expect(decryptResourceJson(shared.key, (stored.content as any).c)).toMatchObject({ role: 'user', localKey: id, meta: { actor: { id: b.id, name: b.username }, intent: 'queue' } });
        const method = shared.id + ':permission'; const registered = event(runner, 'rpc-registered'); runner.emit('rpc-register', { method }); await registered;
        const calls: unknown[] = []; runner.on('rpc-request', (request: any, reply: (v: string) => void) => { calls.push(decryptResourceJson(shared.key, request.params)); reply(encryptResourceJson(shared.key, { accepted: true })); });
        const approval = (value: unknown) => app.inject({ method: 'POST', url: `/v1/lmc/sessions/${shared.id}/action`, headers: headers(b), payload: { method: 'permission', params: encryptResourceJson(shared.key, value) } });
        expect((await approval({ id: 'permission-1', approved: true, mode: 'bypassPermissions' })).statusCode).toBe(400);
        expect((await approval({ id: 'permission-1', approved: true })).statusCode).toBe(200);
        expect(calls).toEqual([{ id: 'permission-1', approved: true }]);
        await shareSession(shared.id, 1, []);
        const claim = (commandId: string) => app.inject({ method: 'POST', url: `/v1/lmc/sessions/${shared.id}/commands/claim`, headers: { authorization: 'Bearer ' + deviceToken }, payload: { commandId } });
        expect((await claim(id)).json()).toEqual({ allowed: false });
        expect(await db.lmcSharedCommand.findUnique({ where: { id } })).toMatchObject({ state: 'cancelled' });
        expect((await approval({ id: 'permission-2', approved: true })).statusCode).toBe(403);
        await resourcesService.set(a.id, 'session', shared.id, { version: 2, adminManaged: false, grants: [{ accountId: b.id, actions: ['read', 'send'] }] });
        const second = await submit(b, 'shared-two'); expect(second.statusCode).toBe(200);
        const pending = () => app.inject({ url: `/v1/lmc/sessions/${shared.id}/commands/pending`, headers: { authorization: 'Bearer ' + deviceToken } });
        expect((await pending()).json().messages).toHaveLength(1);
        expect((await app.inject({ url: `/v1/lmc/sessions/${shared.id}/commands/pending`, headers: headers(b) })).statusCode).toBe(401);
        expect((await claim(second.json().commandId)).json()).toEqual({ allowed: true });
        expect((await claim(second.json().commandId)).json()).toEqual({ allowed: false });
        expect((await pending()).json().messages).toHaveLength(0);
        runner.close();
    });
    it('restricts a runtime credential to its session and its newly published files', async () => {
        const target = await session(b), unrelated = await session(b), unrelatedFile = await file(b);
        const token = await accessTransaction(tx => lmcAuth.createSessionToken(tx, b.id, target.id, randomUUID()));
        const h = { authorization: 'Bearer ' + token };
        expect((await app.inject({ url: `/v1/sessions/${target.id}`, headers: h })).statusCode).toBe(200);
        for (const url of ['/v1/sessions', '/v1/machines', '/v1/files', '/v1/lmc/accounts/me', `/v1/sessions/${unrelated.id}`, `/v1/files/${unrelatedFile.id}`]) expect((await app.inject({ url, headers: h })).statusCode).toBe(403);
        await expect(connect({ ...b, token }, { clientType: 'user-scoped' })).rejects.toThrow('Runtime scope rejected');
        await expect(connect({ ...b, token }, { clientType: 'session-scoped', sessionId: unrelated.id })).rejects.toThrow('Runtime scope rejected');
        const runner = await connect({ ...b, token }, { clientType: 'session-scoped', sessionId: target.id, collaborationProtocol: 1 }); runner.close();
        const id = randomUUID(), ownerKey = randomBytes(105).toString('base64');
        const created = await app.inject({ method: 'POST', url: '/v1/files', headers: h, payload: { id, size: 0, keyMode: 'sealed', ownerKey } });
        expect(created.statusCode).toBe(200);
        expect(await db.fileAsset.findUnique({ where: { id } })).toMatchObject({ accountId: b.id, runtimeSessionId: target.id });
        expect((await app.inject({ method: 'POST', url: `/v1/files/${unrelatedFile.id}/abort`, headers: h })).statusCode).toBe(403);
        const delivery = await db.fileDelivery.create({ data: { id: randomUUID(), accountId: b.id, sessionId: target.id, assetId: unrelatedFile.id, ciphertext: randomBytes(40) } });
        expect((await app.inject({ url: `/v1/sessions/${target.id}/file-deliveries`, headers: h })).json().deliveries).toHaveLength(1);
        expect((await app.inject({ url: `/v1/files/${unrelatedFile.id}`, headers: h })).statusCode).toBe(200);
        expect((await app.inject({ method: 'POST', url: `/v1/files/${unrelatedFile.id}/abort`, headers: h })).statusCode).toBe(403);
        expect((await app.inject({ method: 'POST', url: `/v1/sessions/${target.id}/file-deliveries/${delivery.id}/ack`, headers: h, payload: { state: 'received', receipt: randomBytes(40).toString('base64') } })).statusCode).toBe(200);
        expect((await app.inject({ url: `/v1/sessions/${unrelated.id}/file-deliveries`, headers: h })).statusCode).toBe(403);
        expect(await lmcAuth.browserCredentials(token)).toBeNull();
    });
    it('runs a creator-owned private session on a shared device without distributing machine or account keys', async () => {
        const machineId = randomUUID(), machineKey = randomBytes(32);
        const ownerKey = await accessTransaction(tx => lmcAuth.wrapNewResourceKey(tx, a.id, machineKey));
        await db.machine.create({ data: { id: machineId, accountId: a.id, metadata: encryptResourceJson(machineKey, { host: 'Shared computer', platform: 'darwin', homeDir: '/private/owner' }), dataEncryptionKey: new Uint8Array(ownerKey), active: true } });
        await resourcesService.set(a.id, 'machine', machineId, { version: 0, adminManaged: false, grants: [{ accountId: b.id, actions: ['read', 'execute'] }] });
        const directory = await app.inject({ url: '/v1/lmc/shared-machines', headers: headers(b) });
        expect(directory.json().machines).toContainEqual({ id: machineId, name: 'Shared computer', platform: 'darwin', active: true, canExecute: true });
        expect(directory.body).not.toContain('homeDir'); expect(directory.body).not.toContain('dataEncryptionKey');
        const deviceToken = await lmcAuth.createToken(a.id);
        const host = await connect({ ...a, token: deviceToken }, { clientType: 'machine-scoped', machineId, collaborationProtocol: 1 });
        const registered = event(host, 'rpc-registered'); host.emit('rpc-register', { method: machineId + ':shared-runtime' }); await registered;
        let claims = 0, childToken = '', childId = '';
        host.on('rpc-request', async (data: any, reply: (value: string) => void) => {
            const input = decryptResourceJson(machineKey, data.params) as any;
            if (data.method === machineId + ':resume-happy-session') {
                expect(Object.keys(input)).toEqual(['sessionId']);
                reply(encryptResourceJson(machineKey, { type: 'success', sessionId: input.sessionId })); return;
            }
            const claimed = await app.inject({ method: 'POST', url: `/v1/lmc/runtime/${input.sessionId}/claim`, headers: { authorization: 'Bearer ' + deviceToken }, payload: { launchId: input.launchId } });
            const runtime = claimed.json(); claims++; childToken = runtime.token; childId = runtime.sessionId;
            expect(claimed.statusCode).toBe(200); expect(runtime.accountId).toBe(b.id); expect(runtime.secret).toBeUndefined();
            const metadata = encryptResourceJson(Buffer.from(runtime.key, 'base64'), { flavor: runtime.engine, machineId, sharedDevice: true });
            const started = await app.inject({ method: 'POST', url: `/v1/lmc/runtime/${runtime.sessionId}/start`, headers: { authorization: 'Bearer ' + runtime.token }, payload: { metadata, agentState: null } });
            expect(started.statusCode).toBe(200);
            reply(encryptResourceJson(machineKey, { type: 'success', sessionId: runtime.sessionId }));
        });
        const payload = { requestId: randomUUID(), engine: 'codex' };
        const [first, second] = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: `/v1/lmc/machines/${machineId}/runs`, headers: headers(b), payload })));
        expect(first.statusCode).toBe(200); expect(second.statusCode).toBe(200); expect(first.json().sessionId).toBe(second.json().sessionId); expect(claims).toBe(1);
        expect(await db.session.findUnique({ where: { id: childId } })).toMatchObject({ accountId: b.id });
        expect((await app.inject({ url: `/v1/sessions/${childId}`, headers: headers(a) })).statusCode).toBe(404);
        expect((await app.inject({ url: `/v1/sessions/${childId}`, headers: headers(b) })).statusCode).toBe(200);
        const scoped = { authorization: 'Bearer ' + childToken };
        expect((await app.inject({ method: 'POST', url: `/v1/lmc/runtime/${childId}/authorize`, headers: scoped })).statusCode).toBe(200);
        await db.lmcDeviceRun.update({ where: { sessionId: childId }, data: { state: 'claimed' } });
        expect((await app.inject({ method: 'POST', url: `/v1/lmc/runtime/${childId}/resume`, headers: headers(b) })).json().code).toBe('start_in_progress');
        await db.lmcDeviceRun.update({ where: { sessionId: childId }, data: { state: 'active' } });
        const native = await session(a);
        await db.session.update({ where: { id: native.id }, data: { metadata: encryptResourceJson(native.key, { machineId, flavor: 'codex', codexThreadId: 'native-thread' }) } });
        await resourcesService.set(a.id, 'session', native.id, { version: 0, adminManaged: false, grants: [{ accountId: b.id, actions: ['read', 'send'] }] });
        expect((await app.inject({ method: 'POST', url: `/v1/lmc/runtime/${native.id}/resume`, headers: headers(b) })).json()).toEqual({ type: 'success', sessionId: native.id });
        await shareSession(native.id, 1, []);
        expect((await app.inject({ method: 'POST', url: `/v1/lmc/runtime/${native.id}/resume`, headers: headers(b) })).statusCode).toBe(403);
        await resourcesService.set(a.id, 'machine', machineId, { version: 1, adminManaged: false, grants: [] });
        expect((await app.inject({ method: 'POST', url: `/v1/lmc/runtime/${childId}/authorize`, headers: scoped })).statusCode).toBe(403);
        expect((await app.inject({ method: 'POST', url: `/v3/sessions/${childId}/messages`, headers: headers(b), payload: { messages: [{ localId: 'after-device-revoke', content: 'synthetic' }] } })).statusCode).toBe(403);
        expect((await app.inject({ url: `/v1/sessions/${childId}`, headers: headers(b) })).statusCode).toBe(200);
        expect((await app.inject({ url: '/v1/lmc/shared-machines', headers: headers(b) })).json().machines.some((m: any) => m.id === machineId)).toBe(false);
        host.close();
    }, 15000);
    it('serializes competing administrator demotions', async () => {
        const second = await create('admin');
        const results = await Promise.allSettled([admin, second].map(user => accountsService.update(user.id, user.id, { role: 'member', enabled: true, version: 0 })));
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect(await db.account.count({ where: { role: 'admin', enabled: true } })).toBe(1);
    });
});
