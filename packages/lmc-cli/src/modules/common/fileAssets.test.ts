import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { FILE_ASSET_PART_SIZE, type FileDelivery } from 'lmc-wire';
import { encodeBase64, encryptBlob } from '@/api/encryption';
import { FileAssetInbox, openFileManifest, publishFileAsset, receiveFileAsset, type FileAssetPort } from './fileAssets';

describe('persistent file transport with actual files and encryption', () => {
    let root: string, source: string, target: string, port: FileAssetPort, key: Uint8Array, record: any;
    let chunks: Map<number, Buffer>, pending: FileDelivery[], receipts: any[], cancelled: boolean;
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'lmc-file-test-'));
        source = join(root, 'source'); target = join(root, 'target');
        await mkdir(source); await mkdir(target);
        chunks = new Map(); pending = []; receipts = []; cancelled = false;
        const http = {
            get: vi.fn(async (url: string) => {
                if (url.endsWith('/capabilities')) return { data: { version: 1 } };
                if (url.endsWith('/file-deliveries')) return { data: { deliveries: pending } };
                const part = url.match(/\/parts\/(\d+)$/);
                return { data: part ? chunks.get(Number(part[1])) : record };
            }),
            put: vi.fn(async (url: string, body: Buffer) => { chunks.set(Number(url.split('/').pop()), Buffer.from(body)); return { data: {} }; }),
            post: vi.fn(async (url: string, body: any) => {
                if (url === '/v1/files') record = { ...body, partCount: Math.max(1, Math.ceil(body.size / FILE_ASSET_PART_SIZE)), createdAt: 1, manifest: '' };
                else if (url.endsWith('/complete')) record.manifest = body.manifest;
                else if (url.endsWith('/abort')) cancelled = true;
                else if (url.endsWith('/ack')) { receipts.push(body); pending = []; }
                return { data: {} };
            }),
        };
        port = { http: http as any, root: () => source, sessionId: 'target', wrapOwnerKey: async value => { key = value; return { keyMode: 'sealed', ownerKey: encodeBase64(Buffer.alloc(81)) }; }, decryptDelivery: JSON.parse, encryptReceipt: JSON.stringify, record: vi.fn(async () => {}) };
    });
    afterEach(async () => { await rm(root, { recursive: true, force: true }); });
    const delivery = (): FileDelivery => ({ id: randomUUID(), assetId: record.id, sessionId: 'target', ciphertext: JSON.stringify({ version: 1, assetId: record.id, key: encodeBase64(key) }), state: 'pending', receipt: null, createdAt: 1, updatedAt: 1 });
    async function publish(bytes = Buffer.from('a real deliverable\n')) {
        await writeFile(join(source, 'report.txt'), bytes);
        const saved = await publishFileAsset(port, 'report.txt');
        port.root = () => target;
        return saved;
    }
    it('transfers a >32 MiB snapshot after the source disappears, using encrypted bounded parts', async () => {
        const bytes = Buffer.alloc(33 * 1024 * 1024 + 13, 0x7b);
        const saved = await publish(bytes);
        expect(chunks.size).toBe(5);
        expect([...chunks.values()].every(c => c.length <= FILE_ASSET_PART_SIZE + 40)).toBe(true);
        expect(chunks.get(0)!.subarray(40, 140)).not.toEqual(bytes.subarray(0, 100));
        expect(openFileManifest(record, key).size).toBe(bytes.length);
        await rm(source, { recursive: true });
        const path = await receiveFileAsset(port, delivery());
        expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
        expect(saved.name).toBe('report.txt');
    }, 20_000);
    it('handles an empty file and reuses the same received file after a lost ACK', async () => {
        await publish(Buffer.alloc(0));
        const d = delivery(), path = await receiveFileAsset(port, d);
        expect(chunks.get(0)!.length).toBe(40);
        expect(await receiveFileAsset(port, d)).toBe(path);
        expect(await readdir(join(target, '.lmc-inbox'))).toEqual([path.split('/').pop()]);
    });
    it('does not overwrite a changed destination or follow an inbox symlink', async () => {
        await publish();
        const d = delivery(), path = await receiveFileAsset(port, d);
        await writeFile(path, 'user edits');
        await expect(receiveFileAsset(port, d)).rejects.toThrow('未覆盖');
        expect(await readFile(path, 'utf8')).toBe('user edits');
        await rm(join(target, '.lmc-inbox'), { recursive: true });
        await symlink(source, join(target, '.lmc-inbox'));
        await expect(receiveFileAsset(port, delivery())).rejects.toThrow('符号链接');
    });
    it('rejects ciphertext tampering and plaintext hash mismatches without leaving a partial file', async () => {
        await publish();
        const original = Buffer.from(chunks.get(0)!);
        chunks.get(0)![30] ^= 1;
        await expect(receiveFileAsset(port, delivery())).rejects.toThrow('校验失败');
        expect(await readdir(join(target, '.lmc-inbox'))).toEqual([]);
        chunks.set(0, Buffer.from(encryptBlob(Buffer.alloc(original.length - 40, 9), key)));
        await expect(receiveFileAsset(port, delivery())).rejects.toThrow('校验失败');
        expect(await readdir(join(target, '.lmc-inbox'))).toEqual([]);
    });
    it('never acknowledges a received file until its receipt card persists; retries reuse one path', async () => {
        await publish(); pending = [delivery()];
        vi.mocked(port.record).mockRejectedValueOnce(new Error('outbox unavailable'));
        const inbox = new FileAssetInbox(port);
        try {
            await inbox.poll(); expect(receipts).toEqual([]); expect(pending).toHaveLength(1);
            await inbox.poll(); expect(receipts[0].state).toBe('received');
            expect(JSON.parse(receipts[0].receipt).path).toContain('.lmc-inbox');
            expect(await readdir(join(target, '.lmc-inbox'))).toHaveLength(1);
            const calls = vi.mocked(port.record).mock.calls.slice(-2);
            expect(calls[0][1]).toBe(calls[1][1]);
        } finally { await inbox.stop(); }
    });
    it('aborts a changing source and keeps a completed file discoverable if its chat card fails', async () => {
        await writeFile(join(source, 'report.txt'), 'first');
        const originalPut = port.http.put;
        port.http.put = (async (...args: any[]) => { const result = await (originalPut as any)(...args); await writeFile(join(source, 'report.txt'), 'changed'); return result; }) as any;
        await expect(publishFileAsset(port, 'report.txt')).rejects.toThrow('发生变化');
        expect(cancelled).toBe(true); expect(record.manifest).toBe('');
        port.http.put = originalPut;
        vi.mocked(port.record).mockRejectedValueOnce(new Error('outbox unavailable'));
        expect((await publishFileAsset(port, 'report.txt')).cardPending).toBe(true);
        expect(record.manifest).not.toBe('');
    });
    it('explains an old center without trying to upload, and leaves transport failures pending', async () => {
        const get = port.http.get;
        port.http.get = vi.fn().mockRejectedValue({ isAxiosError: true, response: { status: 404 } });
        await expect(publishFileAsset(port, 'report.txt')).rejects.toThrow('升级 LMC 中心');
        expect(port.http.post).not.toHaveBeenCalled();
        port.http.get = get;
        await publish(); pending = [delivery()];
        const getWorking = port.http.get;
        port.http.get = (async (url: string, options: any) => {
            if (url.includes('/parts/')) throw { isAxiosError: true, response: { status: 503 } };
            return getWorking(url, options);
        }) as any;
        const inbox = new FileAssetInbox(port);
        try { await inbox.poll(); expect(receipts).toEqual([]); expect(pending).toHaveLength(1); }
        finally { await inbox.stop(); }
    });
});
