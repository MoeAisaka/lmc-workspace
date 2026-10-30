import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FilePublications } from './filePublications';

describe('file publication jobs', () => {
    it('returns immediately, reports progress, and reconnects the same intent without starting a second upload', async () => {
        let finish!: (file: any) => void, report!: (bytes: number, total: number) => void;
        const publish = vi.fn((_path, progress) => { report = progress; return new Promise<any>(resolve => { finish = resolve; }); });
        const jobs = new FilePublications(publish), id = randomUUID();
        expect(jobs.start('report.pdf', id).state).toBe('uploading');
        report(10, 100);
        expect(jobs.start('report.pdf', id).bytes).toBe(10);
        expect(publish).toHaveBeenCalledTimes(1);
        expect(() => jobs.start('different.pdf', id)).toThrow('其他文件');
        finish({ id: randomUUID(), name: 'report.pdf', size: 100, mimeType: 'application/pdf' });
        expect((await jobs.status(id, 100)).state).toBe('ready');
        await jobs.stop();
    });
    it('bounds concurrent uploads and cancels them on a clean session shutdown', async () => {
        const publish = vi.fn((_path, _progress, signal: AbortSignal) => new Promise<any>((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')))));
        const jobs = new FilePublications(publish);
        const first = jobs.start('one'), second = jobs.start('two');
        expect(() => jobs.start('three')).toThrow('两个文件');
        await jobs.stop();
        expect((await jobs.status(first.id)).state).toBe('failed');
        expect((await jobs.status(second.id)).error).toBe('cancelled');
    });
});
