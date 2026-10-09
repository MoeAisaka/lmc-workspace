import { open, unlink } from 'node:fs/promises';

/**
 * Assemble a file from ordered pieces, writing each as it arrives so memory
 * holds one piece rather than the file. A piece that cannot be fetched or
 * decrypted, or a total that does not match what was announced, removes the
 * partial file: half a file must never look like the whole one.
 */
export async function writeAttachmentParts(
    parts: string[], path: string, expectedSize: number,
    fetchPiece: (ref: string) => Promise<Uint8Array | null>,
    retryDelayMs = 1000,
): Promise<number> {
    const handle = await open(path, 'wx', 0o600);
    let written = 0;
    try {
        for (const ref of parts) {
            let piece: Uint8Array | null = null;
            for (let attempt = 1; ; attempt++) {
                try { piece = await fetchPiece(ref); break; }
                catch (error) {
                    if (attempt >= 3) throw error;
                    await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
                }
            }
            if (!piece) throw new Error('Attachment piece could not be decrypted');
            written += piece.length;
            if (written > expectedSize) throw new Error('Attachment is larger than announced');
            await handle.write(piece);
        }
        if (written !== expectedSize) throw new Error('Attachment is incomplete');
        await handle.close();
        return written;
    } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(path).catch(() => undefined);
        throw error;
    }
}
