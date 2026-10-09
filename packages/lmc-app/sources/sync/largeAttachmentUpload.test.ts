import { describe, expect, it, vi } from 'vitest';
import { uploadInParts } from './largeAttachmentUpload';

const blobOf = (bytes: number[]) => ({
    size: bytes.length,
    slice: (start: number, end: number) => ({ arrayBuffer: async () => new Uint8Array(bytes.slice(start, end)).buffer }),
}) as any;

describe('uploading a file in pieces', () => {
    it('reads, encrypts and sends each piece in order, reporting progress', async () => {
        const sent: number[][] = [];
        const progress: number[] = [];
        const refs = await uploadInParts({
            blob: blobOf([1, 2, 3, 4, 5, 6, 7]), partSize: 3, retryDelaysMs: [],
            encrypt: bytes => new Uint8Array([...bytes].map(b => b + 100)),
            send: async encrypted => { sent.push([...encrypted]); return 'ref-' + sent.length; },
            onProgress: done => progress.push(done),
        });
        expect(refs).toEqual(['ref-1', 'ref-2', 'ref-3']);
        expect(sent).toEqual([[101, 102, 103], [104, 105, 106], [107]]);
        expect(progress).toEqual([3, 6, 7]);
    });

    it('retries the same piece and does not skip or repeat others', async () => {
        const send = vi.fn(async (encrypted: Uint8Array) => 'r' + encrypted[0]);
        send.mockRejectedValueOnce(new Error('429'));
        const refs = await uploadInParts({ blob: blobOf([1, 2]), partSize: 1, retryDelaysMs: [0], encrypt: b => b, send });
        expect(refs).toEqual(['r1', 'r2']);
        expect(send.mock.calls.map(c => c[0][0])).toEqual([1, 1, 2]);
    });

    it('gives up after the retries and refuses an empty or truncated file', async () => {
        await expect(uploadInParts({ blob: blobOf([1]), partSize: 1, retryDelaysMs: [0], encrypt: b => b, send: async () => { throw new Error('down'); } })).rejects.toThrow('down');
        await expect(uploadInParts({ blob: blobOf([]), encrypt: b => b, send: async () => 'r' })).rejects.toThrow('Empty');
        const short = { size: 4, slice: () => ({ arrayBuffer: async () => new Uint8Array(1).buffer }) } as any;
        await expect(uploadInParts({ blob: short, partSize: 4, encrypt: b => b, send: async () => 'r' })).rejects.toThrow('changed');
    });
});
