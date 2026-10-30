/** Opt-in real-MySQL/local-HTTP check. Run only against a task-created disposable instance. */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fastify from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';

async function main() {
    const root = resolve(process.argv[2] ?? '');
    assert.match(root, /^\/tmp\/lmc-file-mysql-[\w-]+$/);
    const instance = JSON.parse(await readFile(join(root, 'test-instance.json'), 'utf8'));
    const url = new URL(instance.url);
    assert.equal(instance.root, root);
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.pathname, '/lmc_filecheck');
    process.env.DATABASE_URL = instance.url;
    process.env.DATA_DIR = join(root, 'blobs');
    delete process.env.S3_HOST;
    delete process.env.REDIS_URL;
    const { db } = await import('../sources/storage/db');
    const { fileAssetRoutes } = await import('../sources/app/api/routes/fileAssetRoutes');
    const { deleteSessionAttachments, putLocalFile } = await import('../sources/storage/files');
    const datadir = await db.$queryRawUnsafe<Array<{ path: string }>>('SELECT @@datadir AS path');
    assert.equal(resolve(datadir[0].path), join(root, 'data'));
    assert.equal(await db.account.count(), 0, 'Requires an empty disposable database');
    const owner = await db.account.create({ data: { publicKey: 'synthetic-owner-' + randomUUID() } });
    const stranger = await db.account.create({ data: { publicKey: 'synthetic-stranger-' + randomUUID() } });
    const source = await db.session.create({ data: { accountId: owner.id, tag: 'source', metadata: '{}' } });
    const target = await db.session.create({ data: { accountId: owner.id, tag: 'target', metadata: '{}' } });
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_, body, done) => done(null, body));
    app.decorate('authenticate', async (request: any, reply: any) => {
        const account = request.headers['x-test-account'];
        if (account !== owner.id && account !== stranger.id) return reply.code(401).send({ error: 'Unauthorized fixture' });
        request.userId = account;
    });
    fileAssetRoutes(app as any);
    // Test-only endpoint, never registered by the application. Only this synthetic source can be deleted.
    app.delete('/fixture/source', async () => {
        await db.session.delete({ where: { id: source.id } });
        await deleteSessionAttachments(source.id);
        return { removed: true };
    });
    const checks: string[] = [];
    try {
        await app.listen({ host: '127.0.0.1', port: 0 });
        const address = app.server.address(); assert(address && typeof address !== 'string');
        const base = 'http://127.0.0.1:' + address.port;
        const call = (method: any, path: string, payload?: any, account = owner.id) => app.inject({
            method, url: path, payload,
            headers: { 'x-test-account': account, ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/octet-stream' } : {}) },
        });
        const id = randomUUID(), key = Buffer.alloc(81, 2).toString('base64');
        const create = { id, size: 3, keyMode: 'sealed', ownerKey: key };
        const creates = await Promise.all(Array.from({ length: 8 }, () => call('POST', '/v1/files', create)));
        assert(creates.every(r => r.statusCode === 200));
        assert.equal(await db.fileAsset.count(), 1);
        checks.push('eight concurrent creates retain one file identity');
        const parts = [Buffer.alloc(43, 7), Buffer.alloc(43, 8)];
        const puts = await Promise.all(parts.map(p => call('PUT', '/v1/files/' + id + '/parts/0', p)));
        assert.deepEqual(puts.map(r => r.statusCode).sort(), [200, 409]);
        const manifests = [Buffer.alloc(80, 4).toString('base64'), Buffer.alloc(80, 5).toString('base64')];
        const completes = await Promise.all(manifests.map(manifest => call('POST', '/v1/files/' + id + '/complete', { manifest })));
        assert.deepEqual(completes.map(r => r.statusCode).sort(), [200, 409]);
        assert.deepEqual((await call('GET', '/v1/files/' + id + '/parts/0')).rawPayload, parts[puts.findIndex(r => r.statusCode === 200)]);
        checks.push('concurrent different chunks and manifests preserve exactly one winner');
        for (const path of ['/v1/files/' + id, '/v1/files/' + id + '/parts/0']) {
            assert.equal((await call('GET', path, undefined, stranger.id)).statusCode, 404);
        }
        assert.equal((await app.inject('/v1/files/capabilities')).statusCode, 401);
        checks.push('unauthenticated and foreign account access denied');
        const deliveryId = randomUUID();
        const deliveryBody = { id: deliveryId, sessionId: target.id, ciphertext: key };
        const deliveries = await Promise.all(Array.from({ length: 8 }, () => call('POST', '/v1/files/' + id + '/deliveries', deliveryBody)));
        assert(deliveries.every(r => r.statusCode === 200));
        assert.equal(await db.fileDelivery.count(), 1);
        const acks = await Promise.all(['received', 'failed'].map(state => call('POST', '/v1/sessions/' + target.id + '/file-deliveries/' + deliveryId + '/ack', { state, receipt: key })));
        assert.deepEqual(acks.map(r => r.statusCode).sort(), [200, 409]);
        assert.equal((await call('GET', '/v1/sessions/' + target.id + '/file-deliveries')).json().deliveries.length, 0);
        checks.push('concurrent delivery retries and conflicting ACKs keep one terminal result');
        await assert.rejects(db.fileAsset.delete({ where: { id } }), (e: any) => e.code === 'P2003');
        await assert.rejects(db.account.delete({ where: { id: owner.id } }), (e: any) => e.code === 'P2003');
        checks.push('foreign keys reject deletion of referenced file and owner');
        const date = new Date('2026-01-01T00:00:00Z');
        const pageIds = Array.from({ length: 31 }, () => randomUUID());
        await db.fileAsset.createMany({ data: pageIds.map(id => ({ id, accountId: owner.id, size: 0, partCount: 1, keyMode: 'sealed', ownerKey: Buffer.alloc(81), manifest: Buffer.alloc(40), state: 'ready', createdAt: date })) });
        const first = (await call('GET', '/v1/files')).json();
        const second = (await call('GET', '/v1/files?before=' + first.next)).json();
        assert.equal(first.files.length, 30); assert.equal(second.files.length, 2);
        assert.equal(new Set([...first.files, ...second.files].map(f => f.id)).size, 32);
        checks.push('database cursor pagination handles equal timestamps without loss or repetition');
        await db.fileAsset.deleteMany({ where: { id: { in: pageIds } } });
        await putLocalFile('sessions/' + source.id + '/attachments/fixture.enc', Buffer.from('synthetic old attachment'));
        const cliRoot = resolve(process.cwd(), '../lmc-cli');
        const transportResult = join(root, 'transport-result.json');
        await new Promise<void>((accept, reject) => {
            const child = spawn('pnpm', ['exec', 'tsx', '--tsconfig', 'tsconfig.json', 'scripts/file-assets-check.ts'], {
                cwd: cliRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
                    LMC_FILE_CHECK_ROOT: root, LMC_FILE_CHECK_URL: base, LMC_FILE_CHECK_ACCOUNT: owner.id,
                    LMC_FILE_CHECK_TARGET: target.id, LMC_FILE_CHECK_RESULT: transportResult },
            });
            let diagnostic = '';
            child.stdout.on('data', b => { diagnostic += b.toString(); });
            child.stderr.on('data', b => { diagnostic += b.toString(); });
            child.on('error', reject);
            child.on('exit', code => code === 0 ? accept() : reject(new Error('Transport child failed: ' + diagnostic.slice(-6000))));
        });
        assert.equal(await db.session.count({ where: { id: source.id } }), 0);
        const transport = JSON.parse(await readFile(transportResult, 'utf8'));
        assert.equal(await db.fileAssetPart.count({ where: { assetId: transport.assetId } }), 5);
        assert.equal(await db.fileDelivery.count({ where: { assetId: transport.assetId, state: 'received' } }), 1);
        const result = { timestamp: new Date().toISOString(), database: (await db.$queryRawUnsafe<any[]>('SELECT VERSION() AS version'))[0].version,
            environment: 'loopback-only disposable MySQL + actual routes/local storage + CLI source; synthetic fixture auth',
            checks, transport, productionAccess: false };
        await mkdir(join(root, 'results'), { recursive: true });
        await writeFile(join(root, 'results/mysql-integration.json'), JSON.stringify(result, null, 2) + '\n');
        console.log(JSON.stringify({ passed: checks.length, transport: transport.checks.length, evidence: join(root, 'results/mysql-integration.json') }));
    } finally { await app.close(); await db.$disconnect(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
