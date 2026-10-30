/** Synthetic loopback transport probe; never load Agent identity or production configuration. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import axios from 'axios';
import { publishFileAsset } from '@/modules/common/fileAssets';
import { FileShares } from '@/modules/common/fileShares';

async function main() {
    const root = process.env.LMC_SHARE_CHECK_ROOT!, base = process.env.LMC_SHARE_CHECK_URL!;
    assert.equal(dirname(root), resolve(tmpdir())); assert.match(basename(root), /^lmc-share-mysql-[\w-]+$/); assert.equal(new URL(base).hostname, '127.0.0.1');
    const http = axios.create({ baseURL: base, headers: { 'x-test-account': process.env.LMC_SHARE_CHECK_ACCOUNT }, timeout: 30_000 });
    const shares = new FileShares(http, 'https://lmc.example.test');
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 13, 41), path = join(root, 'synthetic-report.bin');
    await mkdir(root, { recursive: true }); await writeFile(path, bytes);
    const file = await publishFileAsset({ http, root: () => root, sessionId: 'synthetic',
        wrapOwnerKey: async () => ({ keyMode: 'sealed', ownerKey: Buffer.alloc(81).toString('base64') }),
        rememberFileKey: (id, key) => shares.remember(id, key), record: async () => {}, decryptDelivery: () => null, encryptReceipt: () => '',
    }, path);
    await unlink(path);
    const link = await shares.run({ action: 'create', asset_id: file.id, public_requested: true }) as any;
    const url = base + new URL(link.url).pathname;
    const response = await fetch(url), received = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200); assert(received.equals(bytes));
    const head = await fetch(url, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), bytes.length);
    assert.equal((await fetch(base + '/v1/files/' + file.id)).status, 401);
    const listed = await shares.run({ action: 'list', asset_id: file.id }) as any; assert.equal(listed.shares.length, 1);
    await shares.run({ action: 'revoke', share_id: link.id }); assert.equal((await fetch(url)).status, 404);
    assert.equal((await http.get('/v1/files/' + file.id)).status, 200);
    shares.clear();
    await writeFile(join(root, 'transport-result.json'), JSON.stringify({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), checks: ['actual CLI publish -> encrypted local storage -> explicit public share', 'source file removed before anonymous multi-part download', 'HEAD retains content length', 'default saved file still requires login', 'revoked link returns 404; authenticated original retained'] }, null, 2));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
