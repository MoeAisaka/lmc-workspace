/** Opt-in integration against a task-created empty MySQL instance, no production identity. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fastify from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';

async function main() {
    const root = resolve(process.argv[2] ?? ''); assert.equal(dirname(root), resolve(tmpdir())); assert.match(basename(root), /^lmc-share-mysql-[\w-]+$/);
    const instance = JSON.parse(await readFile(join(root, 'test-instance.json'), 'utf8'));
    assert.equal(instance.root, root); assert.equal(new URL(instance.url).hostname, '127.0.0.1'); assert.equal(new URL(instance.url).pathname, '/lmc_sharecheck');
    process.env.DATABASE_URL = instance.url; process.env.DATA_DIR = join(root, 'blobs'); process.env.LMC_FILE_SHARE_ORIGIN = 'https://vault.example.test';
    delete process.env.S3_HOST; delete process.env.REDIS_URL;
    const { db } = await import('../sources/storage/db');
    const { fileAssetRoutes } = await import('../sources/app/api/routes/fileAssetRoutes');
    const { fileShareRoutes } = await import('../sources/app/api/routes/fileShareRoutes');
    assert.equal(resolve((await db.$queryRawUnsafe<any[]>('SELECT @@datadir AS path'))[0].path), join(root, 'data'));
    assert.equal(await db.account.count(), 0);
    const owner = await db.account.create({ data: { publicKey: 'synthetic-owner-' + randomUUID() } });
    const app = fastify(); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 9 * 1024 * 1024 }, (_, body, done) => done(null, body));
    app.decorate('authenticate', async (req: any, reply: any) => { if (req.headers['x-test-account'] !== owner.id) return reply.code(401).send({ error: 'Unauthorized fixture' }); req.userId = owner.id; });
    fileAssetRoutes(app as any); fileShareRoutes(app as any);
    try {
        await app.listen({ host: '127.0.0.1', port: 0 }); const addr = app.server.address(); assert(addr && typeof addr !== 'string');
        await new Promise<void>((accept, reject) => {
            const child = spawn('pnpm', ['exec', 'tsx', '--tsconfig', 'tsconfig.json', 'scripts/file-shares-check.ts'], {
                cwd: resolve(process.cwd(), '../lmc-cli'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LMC_SHARE_CHECK_ROOT: root, LMC_SHARE_CHECK_URL: 'http://127.0.0.1:' + addr.port, LMC_SHARE_CHECK_ACCOUNT: owner.id },
            });
            let diagnostic = ''; child.stdout.on('data', b => { diagnostic += b; }); child.stderr.on('data', b => { diagnostic += b; });
            child.on('error', reject); child.on('exit', code => code === 0 ? accept() : reject(new Error('Synthetic transport failed: ' + diagnostic.slice(-2000))));
        });
        const first = await db.fileShare.findFirstOrThrow();
        const body = { id: randomUUID(), tokenHash: first.tokenHash, keyEnvelope: Buffer.from(first.keyEnvelope).toString('base64'), hours: 24 };
        const call = () => app.inject({ method: 'POST', url: '/v1/files/' + first.assetId + '/shares', payload: body, headers: { 'x-test-account': owner.id } });
        const results = await Promise.all(Array.from({ length: 8 }, call)); assert(results.every(r => r.statusCode === 200));
        assert.equal(await db.fileShare.count({ where: { id: body.id } }), 1);
        await assert.rejects(db.fileAsset.delete({ where: { id: first.assetId } }), (e: any) => e.code === 'P2003');
        await db.fileShare.update({ where: { id: body.id }, data: { expiresAt: new Date(Date.now() - 1) } });
        const result = { timestamp: new Date().toISOString(), database: (await db.$queryRawUnsafe<any[]>('SELECT VERSION() AS version'))[0].version,
            productionAccess: false, transport: JSON.parse(await readFile(join(root, 'transport-result.json'), 'utf8')), checks: ['eight racing creates retain one share identity', 'foreign key retains shared immutable snapshot', 'DateTime expiry persists in MySQL'] };
        await writeFile(join(root, 'mysql-integration.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify({ passed: result.checks.length + result.transport.checks.length, evidence: join(root, 'mysql-integration.json') }));
    } finally { await app.close(); await db.$disconnect(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
