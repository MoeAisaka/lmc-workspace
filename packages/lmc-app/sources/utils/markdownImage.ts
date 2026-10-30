import { readSessionResource } from './readSessionResource';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { currentSavedFileId } from '@/utils/lmc/savedFileLink';

export type ImageSource =
    | { kind: 'uri'; uri: string }
    | { kind: 'file'; path: string; mime: string }
    | { kind: 'saved-file'; id: string };

export class UnsupportedSavedImageError extends Error {
    constructor() {
        super('Saved file is not a supported image');
        this.name = 'UnsupportedSavedImageError';
    }
}

const imageTypes = new Map(Object.entries({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
}));
const allowedImageMimes = new Set<string>(imageTypes.values());
const imageMimeAliases = new Map(Object.entries({
    'image/jpg': 'image/jpeg',
    'image/x-png': 'image/png',
    'image/vnd.microsoft.icon': 'image/x-icon',
}));

/** `D:\\dir\\a.png` or `D:/dir/a.png`: absolute on a Windows session host. */
export function isWindowsDrivePath(value: string): boolean {
    return /^[a-z]:[\\/]/i.test(value);
}

/** Markdown destinations name files on the session host, saved LMC assets, or external URIs. */
export function parseMarkdownImageSource(value: string, origin?: string): ImageSource | null {
    let target = value.trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    if (!target || /[\x00-\x1f]/.test(target)) return null;
    const savedId = currentSavedFileId(target, origin);
    if (savedId) return { kind: 'saved-file', id: savedId };
    if (/^(?:https?:\/\/|\/\/|data:image\/|blob:)/i.test(target)) return { kind: 'uri', uri: target };
    if (/^file:\/\/(?:localhost)?\//i.test(target)) {
        target = target.replace(/^file:\/\/(?:localhost)?/i, '');
    }
    // A drive letter is a path on a Windows session host, not a URL scheme.
    else if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !isWindowsDrivePath(target)) return null;
    try { target = decodeURIComponent(target); } catch { /* A literal percent may be part of a filename. */ }
    if (/[\x00-\x1f]/.test(target)) return null;
    // Both file:///D:/... and Markdown's </D:/...> name D:/... on Windows.
    if (/^\/[a-z]:[\\/]/i.test(target)) target = target.slice(1);
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
        const part = await readSessionResource<ImageChunk>(
            sessionId, { path, action: 'download', ...(offset ? { offset, revision } : {}) },
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

function resolveSavedImageMime(mimeType: string, name: string): string | null {
    const raw = mimeType.split(';')[0].trim().toLowerCase();
    const normalized = imageMimeAliases.get(raw) ?? raw;
    if (allowedImageMimes.has(normalized)) return normalized;
    if (!normalized || normalized === 'application/octet-stream') {
        return imageTypes.get(name.split('.').pop()?.toLowerCase() || '') ?? null;
    }
    return null;
}

async function readSavedImage(id: string): Promise<string> {
    const { getFileAsset, readFileAssetParts } = await import('@/sync/apiFileAssets');
    const file = await getFileAsset(id);
    const mime = resolveSavedImageMime(file.manifest.mimeType, file.manifest.name);
    if (!mime) throw new UnsupportedSavedImageError();
    const size = file.manifest.size;
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_IMAGE_BYTES) throw new Error('Image unavailable');
    const bytes = new Uint8Array(size);
    let cursor = 0;
    await readFileAssetParts(file, async chunk => {
        if (!chunk.length || cursor + chunk.length > size) throw new Error('Invalid image chunk');
        bytes.set(chunk, cursor);
        cursor += chunk.length;
    });
    if (cursor !== size) throw new Error('Incomplete image');
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

/** Decrypt and assemble a published LMC FileAsset image for inline Markdown rendering. */
export function loadSavedFileImage(id: string): Promise<string> {
    const key = JSON.stringify(['saved-file', id]);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const promise = readSavedImage(id).finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
}
