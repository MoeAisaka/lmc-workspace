import { constants } from 'node:fs';
import { open, mkdir, lstat, link, unlink, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import axios, { type AxiosInstance } from 'axios';
import { FILE_ASSET_MAX_SIZE, FILE_ASSET_PART_SIZE, fileAssetManifestSchema, fileAssetRecordSchema, fileDeliveryPayloadSchema, fileDeliverySchema, type FileAssetManifest, type FileDelivery } from 'lmc-wire';
import { decryptBlob, encryptBlob, encodeBase64, decodeBase64, getRandomBytes } from '@/api/encryption';
import { resolveResourceFile } from './resourceFiles';

export type OwnerFileKey = { keyMode: 'sealed' | 'legacy'; ownerKey: string };
export type SavedFile = { id: string; name: string; size: number; mimeType: string; cardPending?: boolean };
export interface FileAssetPort {
    http: Pick<AxiosInstance, 'get' | 'post' | 'put'>;
    root: () => string;
    sessionId: string;
    wrapOwnerKey: (key: Uint8Array) => Promise<OwnerFileKey>;
    rememberFileKey?: (id: string, key: Uint8Array) => void;
    decryptDelivery: (ciphertext: string) => unknown;
    encryptReceipt: (value: unknown) => string;
    record: (file: SavedFile, identity: string) => Promise<void>;
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const types: Record<string, string> = { pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', zip: 'application/zip', html: 'text/html', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
function mime(name: string) { return types[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'; }

async function retry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try { return await operation(); } catch (error) {
            if (axios.isCancel(error) || (error as Error)?.name === 'AbortError') throw error;
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            if (attempt >= 3 || (status && status < 500 && status !== 429)) throw error;
            await new Promise(resolve => setTimeout(resolve, [500, 1500, 4000][attempt]));
        }
    }
}
async function readExact(handle: Awaited<ReturnType<typeof open>>, length: number, offset: number): Promise<Buffer> {
    const bytes = Buffer.alloc(length);
    let used = 0;
    while (used < length) {
        const { bytesRead } = await handle.read(bytes, used, length - used, offset + used);
        if (!bytesRead) throw new Error('文件读取中断');
        used += bytesRead;
    }
    return bytes;
}
export async function publishFileAsset(port: FileAssetPort, target: string, progress?: (bytes: number, total: number) => void, signal?: AbortSignal): Promise<SavedFile> {
    const capability = await port.http.get('/v1/files/capabilities', { signal }).catch(error => {
        if (axios.isAxiosError(error) && error.response?.status === 404) throw new Error('请先升级 LMC 中心以支持持久文件');
        throw error;
    });
    if (capability.data?.version !== 1) throw new Error('请先升级 LMC 中心以支持持久文件');
    const path = await resolveResourceFile(port.root(), target);
    const handle = await open(path, 'r');
    let uploadId: string | undefined;
    let complete = false;
    try {
        const initial = await handle.stat();
        if (!initial.isFile() || initial.size > FILE_ASSET_MAX_SIZE) throw new Error('仅支持不超过 2 GiB 的普通文件');
        const key = getRandomBytes(32), id = randomUUID();
        const name = basename(path).slice(0, 255);
        const manifest: FileAssetManifest = { version: 1, id, name, mimeType: mime(name), size: initial.size, parts: [] };
        const owner = await port.wrapOwnerKey(key);
        signal?.throwIfAborted();
        await retry(() => port.http.post('/v1/files', { id, size: initial.size, ...owner }));
        uploadId = id;
        progress?.(0, initial.size);
        const count = Math.max(1, Math.ceil(initial.size / FILE_ASSET_PART_SIZE));
        for (let index = 0; index < count; index++) {
            signal?.throwIfAborted();
            const bytes = await readExact(handle, Math.min(FILE_ASSET_PART_SIZE, initial.size - index * FILE_ASSET_PART_SIZE), index * FILE_ASSET_PART_SIZE);
            manifest.parts.push({ size: bytes.length, sha256: digest(bytes) });
            const encrypted = Buffer.from(encryptBlob(bytes, key));
            await retry(() => port.http.put('/v1/files/' + id + '/parts/' + index, encrypted, { signal, headers: { 'Content-Type': 'application/octet-stream' }, maxBodyLength: FILE_ASSET_PART_SIZE + 40 }));
            progress?.(Math.min((index + 1) * FILE_ASSET_PART_SIZE, initial.size), initial.size);
        }
        const after = await handle.stat();
        if (initial.ino !== after.ino || initial.size !== after.size || initial.mtimeMs !== after.mtimeMs || initial.ctimeMs !== after.ctimeMs) throw new Error('文件在保存时发生变化，请重新保存');
        const encryptedManifest = encodeBase64(encryptBlob(Buffer.from(JSON.stringify(fileAssetManifestSchema.parse(manifest))), key));
        signal?.throwIfAborted();
        await retry(() => port.http.post('/v1/files/' + id + '/complete', { manifest: encryptedManifest }));
        complete = true;
        port.rememberFileKey?.(id, key);
        const file = { id, name, size: initial.size, mimeType: manifest.mimeType };
        // Completion of the upload and persistence of its chat card are separate.
        // A stable message id prevents retrying this confirmation from duplicating it.
        try { await port.record(file, 'file-published:' + id); }
        catch { return { ...file, cardPending: true }; }
        return file;
    } finally {
        await handle.close();
        if (uploadId && !complete) await port.http.post('/v1/files/' + uploadId + '/abort', {}).catch(() => {});
    }
}

export function openFileManifest(record: unknown, key: Uint8Array): FileAssetManifest {
    const file = fileAssetRecordSchema.parse(record);
    const clear = decryptBlob(decodeBase64(file.manifest), key);
    if (!clear) throw new Error('无法解密文件清单');
    const manifest = fileAssetManifestSchema.parse(JSON.parse(Buffer.from(clear).toString('utf8')));
    if (manifest.id !== file.id || manifest.size !== file.size || manifest.parts.length !== file.partCount) throw new Error('文件清单不匹配');
    return manifest;
}
function safeName(name: string) {
    // Windows reserved punctuation and control characters must not become paths.
    const result = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 150);
    return result || 'file';
}
async function matchesFile(path: string, manifest: FileAssetManifest): Promise<boolean> {
    try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== manifest.size) return false;
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
            for (let index = 0; index < manifest.parts.length; index++) {
                const part = manifest.parts[index];
                if (digest(await readExact(handle, part.size, index * FILE_ASSET_PART_SIZE)) !== part.sha256) return false;
            }
            return true;
        } finally { await handle.close(); }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
}

/** Fixed destination + exclusive link make a lost ACK/restart safe without a second copy. */
export async function receiveFileAsset(port: FileAssetPort, delivery: FileDelivery, stopping: () => boolean = () => false): Promise<string> {
    const payload = fileDeliveryPayloadSchema.parse(port.decryptDelivery(delivery.ciphertext));
    if (payload.assetId !== delivery.assetId) throw new Error('投递文件不匹配');
    const key = decodeBase64(payload.key);
    const record = await port.http.get('/v1/files/' + payload.assetId);
    const manifest = openFileManifest(record.data, key);
    port.rememberFileKey?.(payload.assetId, key);
    const root = await realpath(port.root());
    const inbox = join(root, '.lmc-inbox');
    await mkdir(inbox, { recursive: true });
    if ((await lstat(inbox)).isSymbolicLink() || await realpath(inbox) !== inbox) throw new Error('收件目录不可使用符号链接');
    const destination = join(inbox, delivery.id + '-' + safeName(manifest.name));
    if (await matchesFile(destination, manifest)) return destination;
    try { await lstat(destination); throw new Error('收件路径已有不同文件，未覆盖'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temporary = destination + '.' + randomUUID() + '.part';
    const output = await open(temporary, 'wx', 0o600);
    try {
        for (let index = 0; index < manifest.parts.length; index++) {
            if (stopping()) throw new Error('投递已暂停');
            const response = await port.http.get('/v1/files/' + payload.assetId + '/parts/' + index, { responseType: 'arraybuffer', maxContentLength: FILE_ASSET_PART_SIZE + 40 });
            const bytes = decryptBlob(new Uint8Array(response.data), key);
            const part = manifest.parts[index];
            if (!bytes || bytes.length !== part.size || digest(bytes) !== part.sha256) throw new Error('文件分片校验失败');
            await output.writeFile(bytes);
        }
        await output.sync();
        await output.close();
        try { await link(temporary, destination); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !await matchesFile(destination, manifest)) throw error;
        }
        return destination;
    } finally {
        await output.close().catch(() => {});
        await unlink(temporary).catch(() => {});
    }
}

/** No user-message callback: delivery only writes the inbox and records a receipt. */
export class FileAssetInbox {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private closed = false;
    private running = false;
    private unsupported = false;
    private idle: Promise<void> = Promise.resolve();
    constructor(private port: FileAssetPort) {}
    async poll(): Promise<void> {
        if (this.closed || this.running || this.unsupported) return;
        if (this.timer) clearTimeout(this.timer);
        this.running = true;
        let finished!: () => void;
        this.idle = new Promise(resolve => { finished = resolve; });
        try {
            const response = await this.port.http.get('/v1/sessions/' + encodeURIComponent(this.port.sessionId) + '/file-deliveries');
            for (const raw of response.data.deliveries ?? []) {
                if (this.closed) break;
                const delivery = fileDeliverySchema.parse(raw);
                let receipt: { path?: string; error?: string };
                let state: 'received' | 'failed' = 'received';
                try {
                    const path = await receiveFileAsset(this.port, delivery, () => this.closed);
                    receipt = { path };
                } catch (error) {
                    if (this.closed || axios.isAxiosError(error)) continue; // transient transport failures stay pending
                    state = 'failed';
                    receipt = { error: error instanceof Error ? error.message.slice(0, 500) : '文件接收失败' };
                }
                if (state === 'received') {
                    const manifest = openFileManifest((await this.port.http.get('/v1/files/' + delivery.assetId)).data, decodeBase64(fileDeliveryPayloadSchema.parse(this.port.decryptDelivery(delivery.ciphertext)).key));
                    await this.port.record({ id: manifest.id, name: manifest.name, size: manifest.size, mimeType: manifest.mimeType }, 'file-received:' + delivery.id);
                }
                await this.port.http.post('/v1/sessions/' + encodeURIComponent(this.port.sessionId) + '/file-deliveries/' + delivery.id + '/ack', { state, receipt: this.port.encryptReceipt(receipt) });
            }
        } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 404) this.unsupported = true;
            // A disconnect leaves the durable delivery pending. Never log request
            // config here: it contains authorization and encrypted key material.
        } finally {
            this.running = false;
            finished();
            if (!this.closed && !this.unsupported) { this.timer = setTimeout(() => { void this.poll(); }, 15000); this.timer.unref(); }
        }
    }
    stop() { this.closed = true; if (this.timer) clearTimeout(this.timer); return this.idle; }
}

