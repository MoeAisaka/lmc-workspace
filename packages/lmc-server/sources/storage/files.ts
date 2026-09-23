import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as path from 'path';
import { Client } from 'minio';

const useLocalStorage = !process.env.S3_HOST;
const dataDir = process.env.DATA_DIR || './data';
const localFilesDir = path.join(dataDir, 'files');

// A removable-volume permission prompt can stall a filesystem call indefinitely.
// Never perform synchronous IO on the server thread, or fill the shared libuv
// pool with retries. Timed-out operations retain their slot until IO settles.
let localOperations = 0;
let stalledOperations = 0;
const LOCAL_IO_TIMEOUT_MS = 15_000;
const MAX_WAITING_OPERATIONS = 64;
const localWaiters: Array<() => void> = [];
function unavailable() {
    return Object.assign(new Error('Local storage unavailable'), { statusCode: 503 });
}

function localIO<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (stalledOperations >= 2 || localWaiters.length >= MAX_WAITING_OPERATIONS) {
        return Promise.reject(unavailable());
    }
    return new Promise<T>((resolve, reject) => {
        const controller = new AbortController();
        let started = false;
        let timedOut = false;
        // The deadline includes time waiting for a slot. Expired queued work
        // is removed and must never run later, especially for writes/deletes.
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            if (started) stalledOperations++;
            else {
                const index = localWaiters.indexOf(start);
                if (index >= 0) localWaiters.splice(index, 1);
            }
            reject(unavailable());
        }, LOCAL_IO_TIMEOUT_MS);
        const start = () => {
            started = true;
            localOperations++;
            Promise.resolve().then(() => operation(controller.signal)).then(resolve, error => {
                if (['EPERM', 'EACCES', 'EIO', 'ENODEV', 'ETIMEDOUT', 'ABORT_ERR'].includes(error?.code)) {
                    reject(unavailable());
                } else reject(error);
            }).finally(() => {
                clearTimeout(timer);
                localOperations--;
                if (timedOut) stalledOperations--;
                while (localOperations < 2 && localWaiters.length) localWaiters.shift()!();
            });
        };
        if (localOperations < 2) start();
        else localWaiters.push(start);
    });
}

// S3 config (only used when S3_HOST is set)
let s3client: any = null;
let s3bucket: string = '';
let s3host: string = '';
let s3public: string = '';

if (!useLocalStorage) {
    const s3Port = process.env.S3_PORT ? parseInt(process.env.S3_PORT, 10) : undefined;
    const s3UseSSL = process.env.S3_USE_SSL ? process.env.S3_USE_SSL === 'true' : true;
    const s3Region = process.env.S3_REGION || 'us-east-1';
    s3client = new Client({
        endPoint: process.env.S3_HOST!,
        port: s3Port,
        useSSL: s3UseSSL,
        accessKey: process.env.S3_ACCESS_KEY!,
        secretKey: process.env.S3_SECRET_KEY!,
        region: s3Region,
    });
    s3bucket = process.env.S3_BUCKET!;
    s3host = process.env.S3_HOST!;
    s3public = process.env.S3_PUBLIC_URL!;
}

export { s3client, s3bucket, s3host };

export async function loadFiles() {
    if (useLocalStorage) {
        await localIO(() => fs.mkdir(localFilesDir, { recursive: true }));
        return;
    }
    await s3client.bucketExists(s3bucket);
}

export function getPublicUrl(filePath: string) {
    if (useLocalStorage) {
        const baseUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || '3005'}`;
        return `${baseUrl}/files/${filePath}`;
    }
    return `${s3public}/${filePath}`;
}

export function isLocalStorage() {
    return useLocalStorage;
}

export function getLocalFilesDir() {
    return localFilesDir;
}

export async function putLocalFile(filePath: string, data: Buffer) {
    const fullPath = path.join(localFilesDir, filePath);
    await localIO(async signal => {
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        signal.throwIfAborted();
        const temporary = `${fullPath}.${randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporary, data, { flag: 'wx', signal });
            signal.throwIfAborted();
            await fs.rename(temporary, fullPath);
        } finally {
            await fs.rm(temporary, { force: true });
        }
    });
}

/** Read opaque local bytes without blocking unrelated HTTP/WebSocket work. */
export function readLocalFile(filePath: string): Promise<Buffer> {
    return localIO(signal => fs.readFile(path.join(localFilesDir, filePath), { signal }));
}

/** Only absence is false; inaccessible storage must remain a retryable error. */
export async function localFileExists(filePath: string): Promise<boolean> {
    try {
        await localIO(() => fs.stat(path.join(localFilesDir, filePath)));
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
}

/**
 * Delete all attachments for a session.
 * Local: removes the session attachments directory.
 * S3: deletes all objects with prefix "sessions/{sessionId}/attachments/".
 */
export async function deleteSessionAttachments(sessionId: string): Promise<void> {
    const prefix = `sessions/${sessionId}/attachments`;
    if (useLocalStorage) {
        const dir = path.join(localFilesDir, prefix);
        await localIO(() => fs.rm(dir, { recursive: true, force: true }));
        return;
    }

    // S3: list and delete all objects under the prefix
    const stream = s3client.listObjects(s3bucket, prefix + '/', true);
    const keys: string[] = await new Promise((resolve, reject) => {
        const collected: string[] = [];
        stream.on('data', (obj: { name: string }) => { if (obj.name) collected.push(obj.name); });
        stream.on('end', () => resolve(collected));
        stream.on('error', reject);
    });

    if (keys.length > 0) {
        await s3client.removeObjects(s3bucket, keys);
    }
}

/**
 * Delete all avatar blobs for a project. Avatar refs are deliberately kept
 * outside the database: the encrypted bytes are opaque and the active ref is
 * stored on Project, while this prefix cleanup handles old replacements too.
 */
export async function deleteProjectAvatars(projectId: string): Promise<void> {
    const prefix = `projects/${projectId}/avatar`;
    if (useLocalStorage) {
        const dir = path.join(localFilesDir, prefix);
        await localIO(() => fs.rm(dir, { recursive: true, force: true }));
        return;
    }

    const stream = s3client.listObjects(s3bucket, prefix + '/', true);
    const keys: string[] = await new Promise((resolve, reject) => {
        const collected: string[] = [];
        stream.on('data', (obj: { name: string }) => { if (obj.name) collected.push(obj.name); });
        stream.on('end', () => resolve(collected));
        stream.on('error', reject);
    });

    if (keys.length > 0) {
        await s3client.removeObjects(s3bucket, keys);
    }
}

export type ImageRef = {
    width: number;
    height: number;
    thumbhash: string;
    path: string;
}
