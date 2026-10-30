import { z } from 'zod';
import { fileAssetManifestSchema, fileAssetRecordSchema, fileDeliverySchema, fileShareCreateSchema, fileShareSchema, type FileAssetManifest, type FileDelivery, type FileShare } from 'lmc-wire';
import { sync } from './sync';
import { storage } from './storage';
import { getServerUrl } from './serverConfig';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { decryptBlob, encryptBlob } from '@/encryption/blob';
import { randomUUID, getRandomBytes } from 'expo-crypto';

export type OpenFileAsset = { manifest: FileAssetManifest; key: Uint8Array; createdAt: number; shared?: boolean };
export const FILE_DOWNLOAD_MEMORY_LIMIT = 128 * 1024 * 1024;
export const FILE_PREVIEW_LIMIT = 16 * 1024 * 1024;

async function request(path: string, options?: RequestInit): Promise<Response> {
    const credentials = sync.getCredentials();
    if (!credentials) throw new Error('请先登录 LMC');
    const response = await fetch(getServerUrl() + path, { ...options, headers: { Authorization: 'Bearer ' + credentials.token, 'Content-Type': 'application/json', ...options?.headers }, signal: options?.signal ?? AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(response.status === 404 ? '文件不存在或当前 LMC 中心需要升级' : '文件操作失败（' + response.status + '），请重试');
    return response;
}
export async function decryptFileAsset(record: unknown, providedKey?: Uint8Array): Promise<OpenFileAsset> {
    const file = fileAssetRecordSchema.parse(record);
    let key = providedKey;
    if (!key) {
        if (file.keyMode === 'sealed') key = await sync.encryption.decryptEncryptionKey(file.ownerKey) ?? undefined;
        else {
            const legacy = await sync.encryption.openEncryption(null);
            const [value] = await legacy.decrypt([decodeBase64(file.ownerKey, 'base64')]);
            if (typeof value === 'string') key = decodeBase64(value, 'base64');
        }
    }
    if (key?.length !== 32) throw new Error('当前账号无法解密此文件');
    const clear = decryptBlob(decodeBase64(file.manifest, 'base64'), key);
    if (!clear) throw new Error('文件清单解密失败');
    const manifest = fileAssetManifestSchema.parse(JSON.parse(new TextDecoder().decode(clear)));
    if (manifest.id !== file.id || manifest.size !== file.size || manifest.parts.length !== file.partCount) throw new Error('文件清单不匹配');
    return { manifest, key, createdAt: file.createdAt, shared: z.object({ shared: z.boolean().default(false) }).parse(record).shared };
}
export async function getFileAsset(id: string): Promise<OpenFileAsset> {
    return decryptFileAsset(await (await request('/v1/files/' + encodeURIComponent(id))).json());
}
export async function listFileAssets(before?: string) {
    const data = await (await request('/v1/files' + (before ? '?before=' + encodeURIComponent(before) : ''))).json();
    return { files: await Promise.all((data.files as unknown[]).map(record => decryptFileAsset(record))), next: data.next as string | null };
}
export async function readFileAssetParts(file: OpenFileAsset, write: (bytes: Uint8Array) => Promise<void>, progress?: (received: number) => void, signal?: AbortSignal) {
    let received = 0;
    for (let index = 0; index < file.manifest.parts.length; index++) {
        signal?.throwIfAborted();
        const response = await request('/v1/files/' + file.manifest.id + '/parts/' + index, { signal });
        const bytes = decryptBlob(new Uint8Array(await response.arrayBuffer()), file.key);
        const part = file.manifest.parts[index];
        if (!bytes || bytes.length !== part.size) throw new Error('文件分片不完整');
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer));
        if (Array.from(hash, b => b.toString(16).padStart(2, '0')).join('') !== part.sha256) throw new Error('文件分片校验失败');
        signal?.throwIfAborted();
        await write(bytes);
        received += bytes.length;
        progress?.(received);
    }
}
export async function fileAssetBlob(file: OpenFileAsset, limit = FILE_DOWNLOAD_MEMORY_LIMIT, progress?: (received: number) => void, signal?: AbortSignal) {
    if (file.manifest.size > limit) throw new Error('此浏览器的内存下载上限为 128 MiB，请转交到电脑会话下载');
    const chunks: ArrayBuffer[] = [];
    await readFileAssetParts(file, async bytes => { chunks.push(new Uint8Array(bytes).buffer); }, progress, signal);
    return new Blob(chunks, { type: file.manifest.mimeType });
}
export async function downloadFileAsset(file: OpenFileAsset, progress?: (received: number) => void, signal?: AbortSignal) {
    if (typeof window === 'undefined') throw new Error('请在网页版下载文件');
    const picker = (window as any).showSaveFilePicker;
    if (typeof picker === 'function') {
        // Must run in the original click gesture, before any network await.
        const handle = await picker.call(window, { suggestedName: file.manifest.name });
        const output = await handle.createWritable();
        try { await readFileAssetParts(file, bytes => output.write(bytes), progress, signal); await output.close(); }
        catch (error) { await output.abort().catch(() => {}); throw error; }
        return;
    }
    const blob = await fileAssetBlob(file, FILE_DOWNLOAD_MEMORY_LIMIT, progress, signal);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = file.manifest.name; link.style.display = 'none';
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const intents = new Map<string, { id: string; sessionId: string; ciphertext: string }>();
export async function deliverFileAsset(file: OpenFileAsset, sessionId: string): Promise<FileDelivery> {
    const session = storage.getState().sessions[sessionId];
    if (!session?.metadata?.sessionCapabilities?.persistentFiles) throw new Error('目标会话需要升级 Agent 后才能接收文件');
    const encryption = sync.encryption.getSessionEncryption(sessionId);
    if (!encryption) throw new Error('目标会话尚未同步，请刷新后重试');
    const identity = file.manifest.id + ':' + sessionId;
    let intent = intents.get(identity);
    if (!intent) {
        // Reopening the page after a lost response must not enqueue the same
        // still-pending delivery a second time.
        const pending = (await getFileDeliveries(file.manifest.id)).find(d => d.sessionId === sessionId && d.state === 'pending');
        if (pending) return pending;
        intent = { id: randomUUID(), sessionId, ciphertext: await encryption.encryptRaw({ version: 1, assetId: file.manifest.id, key: encodeBase64(file.key, 'base64') }) };
        intents.set(identity, intent);
    }
    const response = await request('/v1/files/' + file.manifest.id + '/deliveries', { method: 'POST', body: JSON.stringify(intent) });
    const delivery = fileDeliverySchema.parse(await response.json());
    intents.delete(identity);
    return delivery;
}
export async function getFileDeliveries(id: string): Promise<FileDelivery[]> {
    return z.array(fileDeliverySchema).parse((await (await request('/v1/files/' + encodeURIComponent(id) + '/deliveries')).json()).deliveries);
}
export async function decryptFileReceipt(delivery: FileDelivery): Promise<{ path?: string; error?: string } | null> {
    if (!delivery.receipt) return null;
    const raw = await sync.encryption.getSessionEncryption(delivery.sessionId)?.decryptRaw(delivery.receipt);
    const parsed = z.object({ path: z.string().optional(), error: z.string().optional() }).safeParse(raw);
    return parsed.success ? parsed.data : null;
}

// Retry identity survives a lost HTTP response without storing the bearer link.
// This map is RAM-only and bounded; links are never put in localStorage.
const shareIntents = new Map<string, { token: string; body: z.infer<typeof fileShareCreateSchema> }>();
export async function createFileShare(file: OpenFileAsset, hours = 24): Promise<FileShare & { url: string }> {
    const identity = file.manifest.id + ':' + hours;
    let intent = shareIntents.get(identity);
    if (!intent) {
        if (shareIntents.size >= 32) throw new Error('待确认的外链操作过多，请刷新页面后查看已有外链');
        const bytes = getRandomBytes(32);
        const hex = (value: Uint8Array) => Array.from(value, b => b.toString(16).padStart(2, '0')).join('');
        intent = { token: hex(bytes), body: fileShareCreateSchema.parse({ id: randomUUID(), hours,
            tokenHash: hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))),
            keyEnvelope: encodeBase64(encryptBlob(file.key, bytes), 'base64') }) };
        shareIntents.set(identity, intent);
    }
    const response = await request('/v1/files/' + file.manifest.id + '/shares', { method: 'POST', body: JSON.stringify(intent.body) });
    const share = fileShareSchema.parse(await response.json());
    if (!share.urlPrefix || share.revokedAt || share.expiresAt <= Date.now()) throw new Error('外链已不可用，请刷新后重试');
    shareIntents.delete(identity);
    return { ...share, url: share.urlPrefix + intent.token };
}
export async function getFileShares(id: string): Promise<FileShare[]> {
    return z.array(fileShareSchema).parse((await (await request('/v1/files/' + encodeURIComponent(id) + '/shares')).json()).shares);
}
export async function revokeFileShare(id: string): Promise<void> {
    await request('/v1/file-shares/' + encodeURIComponent(id), { method: 'DELETE' });
}

