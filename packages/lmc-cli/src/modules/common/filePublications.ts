import { randomUUID } from 'node:crypto';
import type { SavedFile } from './fileAssets';
export type FilePublication = { id: string; state: 'uploading' | 'ready' | 'failed'; bytes: number; total: number; file?: SavedFile; error?: string };
type Job = { path: string; value: FilePublication; controller: AbortController; done: Promise<void> };
/** RPC calls observe a bounded job; the upload never holds a 30-second RPC open. */
export class FilePublications {
    private jobs = new Map<string, Job>();
    constructor(private publish: (path: string, progress: (bytes: number, total: number) => void, signal: AbortSignal) => Promise<SavedFile>) {}
    start(path: string, requestId: string = randomUUID()): FilePublication {
        if (!/^[a-f0-9-]{36}$/i.test(requestId)) throw new Error('无效的保存请求');
        const prior = this.jobs.get(requestId);
        if (prior) { if (prior.path !== path) throw new Error('保存请求已用于其他文件'); return { ...prior.value }; }
        if ([...this.jobs.values()].filter(job => job.value.state === 'uploading').length >= 2) throw new Error('已有两个文件正在保存，请稍后再试');
        for (const [id, job] of this.jobs) if (this.jobs.size >= 32 && job.value.state !== 'uploading') this.jobs.delete(id);
        const value: FilePublication = { id: requestId, state: 'uploading', bytes: 0, total: 0 };
        const controller = new AbortController();
        const job: Job = { path, value, controller, done: Promise.resolve() };
        this.jobs.set(requestId, job);
        job.done = this.publish(path, (bytes, total) => { value.bytes = bytes; value.total = total; }, controller.signal)
            .then(file => { value.state = 'ready'; value.file = file; })
            .catch(error => { value.state = 'failed'; value.error = error instanceof Error ? error.message : '保存失败'; });
        return { ...value };
    }
    async status(id: string, waitMs = 0): Promise<FilePublication> {
        const job = this.jobs.get(id);
        if (!job) throw new Error('保存记录不可用，请先查看已保存文件，避免重复保存');
        if (waitMs > 0 && job.value.state === 'uploading') {
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([job.done, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(waitMs, 20_000)); })]);
            if (timer) clearTimeout(timer);
        }
        return { ...job.value };
    }
    async stop() {
        for (const job of this.jobs.values()) if (job.value.state === 'uploading') job.controller.abort();
        await Promise.all([...this.jobs.values()].map(job => job.done));
    }
}

