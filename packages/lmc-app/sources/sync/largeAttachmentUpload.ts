/**
 * Sending a file too large to hold in memory.
 *
 * A single upload reads the whole file, encrypts it into a second copy and
 * hands a third to fetch — a few hundred megabytes of that ends a phone's
 * browser tab. Here the file is read one piece at a time; each piece is its
 * own encrypted blob, so the center needs no change and the receiving Agent
 * writes pieces to disk as they arrive. The order travels in the (encrypted)
 * file event, and every piece is authenticated on its own.
 */
export const ATTACHMENT_PART_SIZE = 8 * 1024 * 1024;

/** Long enough in total to outlast the center's one-minute upload window. */
const RETRY_DELAYS_MS = [1000, 5000, 20000, 40000];

export async function uploadInParts(opts: {
    blob: Pick<Blob, 'size' | 'slice'>;
    encrypt: (bytes: Uint8Array) => Uint8Array;
    /** Uploads one encrypted piece and returns its ref. */
    send: (encrypted: Uint8Array) => Promise<string>;
    onProgress?: (sentBytes: number, totalBytes: number) => void;
    partSize?: number;
    retryDelaysMs?: number[];
}): Promise<string[]> {
    const partSize = opts.partSize ?? ATTACHMENT_PART_SIZE;
    const delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
    const total = opts.blob.size;
    if (!(total > 0)) throw new Error('Empty file');
    const refs: string[] = [];
    for (let start = 0; start < total; start += partSize) {
        const end = Math.min(total, start + partSize);
        const bytes = new Uint8Array(await opts.blob.slice(start, end).arrayBuffer());
        if (bytes.length !== end - start) throw new Error('File changed while it was being read');
        const encrypted = opts.encrypt(bytes);
        for (let attempt = 0; ; attempt++) {
            try { refs.push(await opts.send(encrypted)); break; }
            catch (error) {
                if (attempt >= delays.length) throw error;
                await new Promise(resolve => setTimeout(resolve, delays[attempt]));
            }
        }
        opts.onProgress?.(end, total);
    }
    return refs;
}
