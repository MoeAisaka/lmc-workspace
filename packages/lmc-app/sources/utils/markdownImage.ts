import { apiSocket } from '@/sync/apiSocket';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';

type ImageSource = { kind: 'uri'; uri: string } | { kind: 'file'; path: string; mime: string };
const imageTypes = new Map(Object.entries({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
}));

/** Markdown destinations name files on the session host, not on the browser. */
export function parseMarkdownImageSource(value: string): ImageSource | null {
    let target = value.trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    if (!target || /[\x00-\x1f]/.test(target)) return null;
    if (/^(?:https?:\/\/|\/\/|data:image\/|blob:)/i.test(target)) return { kind: 'uri', uri: target };
    if (/^file:\/\/(?:localhost)?\//i.test(target)) target = target.replace(/^file:\/\/(?:localhost)?/i, '');
    else if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
    try { target = decodeURIComponent(target); } catch { /* A literal percent may be part of a filename. */ }
    if (/[\x00-\x1f]/.test(target)) return null;
    const mime = imageTypes.get(target.split('.').pop()?.toLowerCase() || '');
    return mime ? { kind: 'file', path: target, mime } : null;
}

type ImageChunk = { success: boolean; content?: string; size?: number; revision?: string; nextOffset?: number | null };
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const inFlight = new Map<string, Promise<string>>();

async function readImage(sessionId: string, path: string, mime: string): Promise<string> {
    let offset = 0;
    let size: number | undefined;
    let revision: string | undefined;
    const chunks: Uint8Array[] = [];
    do {
        const part = await apiSocket.sessionRPC<ImageChunk, { path: string; action: string; offset?: number; revision?: string }>(
            sessionId, 'resource-file', { path, action: 'download', ...(offset ? { offset, revision } : {}) },
        );
        if (!part.success || !part.content || !Number.isSafeInteger(part.size) || part.size! <= 0 || part.size! > MAX_IMAGE_BYTES) throw new Error('Image unavailable');
        if (size === undefined) { size = part.size; revision = part.revision; }
        if (part.size !== size || part.revision !== revision) throw new Error('Image changed during reading');
        const bytes = decodeBase64(part.content);
        if (!bytes.length || offset + bytes.length > size!) throw new Error('Invalid image chunk');
        chunks.push(bytes);
        offset += bytes.length;
        if (part.nextOffset == null) break;
        if (part.nextOffset !== offset || offset >= size!) throw new Error('Invalid image cursor');
    } while (offset < MAX_IMAGE_BYTES);
    if (size === undefined || offset !== size) throw new Error('Incomplete image');
    const bytes = new Uint8Array(size);
    let cursor = 0;
    for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.length; }
    return `data:${mime};base64,${encodeBase64(bytes)}`;
}

/** Coalesce simultaneous views without retaining image bytes after unmount. */
export function loadMarkdownImage(sessionId: string, path: string, mime: string): Promise<string> {
    const key = JSON.stringify([sessionId, path, mime]);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const promise = readImage(sessionId, path, mime).finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
}
