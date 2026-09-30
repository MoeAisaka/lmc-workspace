import { describe, expect, it, vi } from 'vitest';
import { createWorkerFailureReporter } from './workerFailure';
const worker = () => ({ orchestration: { role: 'worker', hub: { sessionId: 'H', boundAt: 1 }, board: [
    { id: 'deploy', dispatchId: 'dispatch-original', attempt: 1, stage: 'deploy', state: 'dispatched', counterpart: 'H', title: 'deploy', firstAt: 123, updatedAt: 123 },
] } } as any);

describe('worker terminal failure reporting', () => {
    it('reports a model rejection against the original task and deduplicates concurrent terminal events', async () => {
        let metadata = worker();
        const sendMail = vi.fn(async (_to: string, _text: string) => ({ ok: true as const }));
        const reporter = createWorkerFailureReporter({ selfId: 'W', metadata: () => metadata, updateMetadata: async u => { metadata = u(metadata); }, sendMail });
        const failure = "The 'gpt-6.1' model is not supported when using Codex with a ChatGPT account.";
        await Promise.all([reporter.onFailure(failure), reporter.onFailure(failure)]);
        await reporter.onFailure(failure);
        expect(sendMail).toHaveBeenCalledTimes(1);
        expect(sendMail.mock.calls[0]).toEqual(['H', expect.stringMatching(/\[report deploy · attempt 1 · blocked\]/)]);
        const text = sendMail.mock.calls[0][1];
        expect(text).toContain('dispatch-original'); expect(text).toContain('configuration'); expect(text).toContain('gpt-6.1');
        expect(metadata.orchestration.board[0]).toMatchObject({ state: 'blocked', attempt: 1, dispatchId: 'dispatch-original', firstAt: 123 });
    });
    it.each(['HTTP 401 authentication_error', 'connection closed', '429 quota exceeded'])('reports terminal failure %s for either engine', async detail => {
        const sendMail = vi.fn(async () => ({ ok: true as const }));
        const reporter = createWorkerFailureReporter({ selfId: 'W', metadata: worker, updateMetadata: async () => {}, sendMail });
        expect(await reporter.onFailure(detail)).toBe(true); expect(sendMail).toHaveBeenCalledOnce();
    });
    it('retries failed mail delivery and leaves hub sessions alone', async () => {
        const sendMail = vi.fn().mockResolvedValueOnce({ ok: false, error: 'offline' }).mockResolvedValue({ ok: true });
        const reporter = createWorkerFailureReporter({ selfId: 'W', metadata: worker, updateMetadata: async () => {}, sendMail });
        await reporter.onFailure('connection closed'); await reporter.onFailure('connection closed');
        expect(sendMail).toHaveBeenCalledTimes(2);
        expect(await createWorkerFailureReporter({ selfId: 'H', metadata: () => ({ orchestration: { role: 'hub', workers: [] } } as any), updateMetadata: async () => {}, sendMail }).onFailure('error')).toBe(false);
    });
});
