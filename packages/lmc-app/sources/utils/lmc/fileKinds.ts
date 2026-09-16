/**
 * What a file is, as far as showing it goes.
 *
 * Shared by the viewer and by whatever opens a file reference, so a path that
 * would only ever render as mojibake is downloaded instead of opened, and both
 * make that call the same way.
 */

const BINARY_EXTENSIONS = [
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'ico',
    'mp4', 'avi', 'mov', 'wmv', 'flv', 'webm',
    'mp3', 'wav', 'flac', 'aac', 'ogg',
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'zip', 'tar', 'gz', 'rar', '7z',
    'exe', 'dmg', 'deb', 'rpm',
    'woff', 'woff2', 'ttf', 'otf',
    'db', 'sqlite', 'sqlite3',
];

export function isBinaryExtension(path: string): boolean {
    const extension = path.split('.').pop()?.toLowerCase();
    return extension ? BINARY_EXTENSIONS.includes(extension) : false;
}

export function decodeBase64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/**
 * Whether decoded bytes are text after all. An extension is only a hint — a
 * `.log` can be a core dump and a `.bin` can be a config — so the content
 * decides once it is in hand.
 */
export function looksBinary(bytes: Uint8Array, decoded: string): boolean {
    if (decoded.length === 0) return false;
    if (bytes.some((byte) => byte === 0)) return true;
    let unprintable = 0;
    for (const character of decoded) {
        const code = character.charCodeAt(0);
        if (code < 32 && code !== 9 && code !== 10 && code !== 13) unprintable += 1;
    }
    return unprintable / decoded.length > 0.1;
}

export function fileName(path: string): string {
    const trimmed = path.replace(/\/+$/, '');
    return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}
