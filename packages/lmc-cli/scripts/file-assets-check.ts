/** Child of the disposable MySQL check; never uses the installed Agent identity. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import axios from 'axios';
import { FileAssetInbox, openFileManifest, publishFileAsset, type FileAssetPort } from '../src/modules/common/fileAssets';
import { decodeBase64, encodeBase64, encrypt, decrypt } from '../src/api/encryption';

async function main() {
    const root = resolve(process.env.LMC_FILE_CHECK_ROOT ?? '');
    assert.match(root, /^\/tmp\/lmc-file-mysql-[\w-]+$/);
    const base = new URL(process.env.LMC_FILE_CHECK_URL!);
    assert.equal(base.hostname, '127.0.0.1'); assert.equal(base.protocol, 'http:');
    const http = axios.create({ baseURL: base.href, proxy: false, timeout: 20_000,
        headers: { 'x-test-account': process.env.LMC_FILE_CHECK_ACCOUNT! } });
    const source = join(root, 'source'), target = join(root, 'target');
    await mkdir(source); await mkdir(target);
    const size = 33 * 1024 * 1024 + 13;
    const bytes = Buffer.alloc(size, 0x63);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(source, '跨网络报告.txt'), bytes);
    const accountSecret = randomBytes(32), sessionKey = randomBytes(32);
    let cardAttempts = 0, loseAck = false, failCard = true;
    const cardIds = new Set<string>();
    const port: FileAssetPort = {
        http, root: () => source, sessionId: process.env.LMC_FILE_CHECK_TARGET!,
        wrapOwnerKey: async key => ({ keyMode: 'legacy', ownerKey: encodeBase64(encrypt(accountSecret, 'legacy', encodeBase64(key))) }),
        decryptDelivery: value => decrypt(sessionKey, 'dataKey', decodeBase64(value)),
        encryptReceipt: value => encodeBase64(encrypt(sessionKey, 'dataKey', value)),
        record: async (_, id) => {
            if (id.startsWith('file-received:')) { cardAttempts++; if (failCard) { failCard = false; throw new Error('synthetic card persistence interruption'); } }
            cardIds.add(id);
        },
    };
    const saved = await publishFileAsset(port, '跨网络报告.txt');
    await rm(source, { recursive: true }); // Only the fixture directory created above.
    await http.delete('/fixture/source');
    const file = (await http.get('/v1/files/' + saved.id)).data;
    const key = decodeBase64(decrypt(accountSecret, 'legacy', decodeBase64(file.ownerKey)));
    assert.equal(openFileManifest(file, key).parts.length, 5);
    const deliveryId = randomUUID();
    const body = { id: deliveryId, sessionId: port.sessionId,
        ciphertext: encodeBase64(encrypt(sessionKey, 'dataKey', { version: 1, assetId: saved.id, key: encodeBase64(key) })) };
    const endpoint = '/v1/files/' + saved.id + '/deliveries';
    const queued = (await http.post(endpoint, body)).data;
    assert.equal(queued.state, 'pending');
    assert.equal((await http.post(endpoint, body)).data.id, deliveryId);
    port.root = () => target;
    const post = http.post.bind(http);
    port.http = { get: http.get.bind(http), put: http.put.bind(http), post: (async (...args: any[]) => {
        const result = await (post as any)(...args);
        if (String(args[0]).endsWith('/ack') && !loseAck) { loseAck = true; throw Object.assign(new Error('synthetic lost ACK response'), { isAxiosError: true }); }
        return result;
    }) as any };
    let inbox = new FileAssetInbox(port);
    try {
        await inbox.poll();
        assert.equal((await http.get(endpoint)).data.deliveries[0].state, 'pending');
        assert.equal((await readdir(join(target, '.lmc-inbox'))).length, 1);
        await inbox.stop();
        inbox = new FileAssetInbox(port); // Receiver restart, no in-memory receipt cache.
        await inbox.poll(); await inbox.poll();
        const final = (await http.get(endpoint)).data.deliveries[0];
        assert.equal(final.state, 'received');
        const receipt = decrypt(sessionKey, 'dataKey', decodeBase64(final.receipt));
        assert.equal(createHash('sha256').update(await readFile(receipt.path)).digest('hex'), sha256);
        assert.equal((await readdir(join(target, '.lmc-inbox'))).length, 1);
        assert.equal(cardAttempts, 2); assert.equal(cardIds.size, 2); assert(loseAck);
        await writeFile(process.env.LMC_FILE_CHECK_RESULT!, JSON.stringify({ assetId: saved.id, bytes: size, encryptedParts: 5, sha256,
            checks: ['actual HTTP encrypted upload and local blob storage', 'source directory and source session deleted before download',
                'account key unwrap survives source deletion', 'target initially offline remains pending', 'receipt card failure keeps delivery pending',
                'receiver restart reuses exactly one complete file', 'lost ACK response does not duplicate delivery', 'received bytes match SHA-256'] }, null, 2));
    } finally { await inbox.stop(); }
}
main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
