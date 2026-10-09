import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RefreshJournal, type RefreshJob } from './refreshJournal';
import { recoverLateRefreshes, REFRESH_EXIT_TIMEOUT } from './lateRefreshRecovery';

const expired = (): RefreshJob => ({ sessionId: 'same-session', pid: 123,
    options: { receiveSeq: 10899, model: 'same-model', effort: 'medium', permissionMode: 'yolo' },
    state: 'error', error: REFRESH_EXIT_TIMEOUT, updatedAt: 1 });

it.each(['claude', 'codex'])('recovers a late %s exit from its durable cursor once, including after daemon restart', async engine => {
    const dir = await mkdtemp(join(tmpdir(), 'lmc-late-refresh-'));
    try {
        const journal = new RefreshJournal(dir);
        const job = expired();
        await journal.put(job);
        let alive = true;
        const watch = vi.fn();
        const ports = { journal: new RefreshJournal(dir), alive: () => alive, inFlight: () => false,
            metadata: async () => ({ hostPid: 123, sessionConfigState: 'refreshing', lifecycleState: 'running', flavor: engine }), watch };
        await recoverLateRefreshes(ports);
        expect(watch).not.toHaveBeenCalled();
        alive = false;
        await recoverLateRefreshes(ports);
        expect(watch).toHaveBeenCalledTimes(1);
        expect(watch.mock.calls[0][0]).toMatchObject({ sessionId: job.sessionId, pid: job.pid, options: job.options, state: 'waiting' });
        expect((await journal.list())[0].options).toEqual(job.options);
        await recoverLateRefreshes(ports);
        expect(watch).toHaveBeenCalledTimes(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

it.each([
    null,
    { hostPid: 456, sessionConfigState: 'refreshing' },
    { hostPid: 123, sessionConfigState: 'applied' },
    { hostPid: 123, sessionConfigState: 'error' },
    { hostPid: 123, sessionConfigState: 'refreshing', lifecycleState: 'archiveRequested' },
    { hostPid: 123, sessionConfigState: 'refreshing', lifecycleState: 'archived' },
])('does not resurrect a cancelled, archived, replaced or unverifiable session (%j)', async metadata => {
    const put = vi.fn(), watch = vi.fn();
    await recoverLateRefreshes({ journal: { list: async () => [expired()], put }, alive: () => false,
        inFlight: () => false, metadata: async () => metadata, watch });
    expect(put).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
});

it('does not turn unrelated errors or a missing cursor into automatic retries', async () => {
    const put = vi.fn(), watch = vi.fn(), metadata = vi.fn();
    await recoverLateRefreshes({ journal: { list: async () => [
        { ...expired(), error: 'Authentication failed' }, { ...expired(), options: {} },
    ], put }, alive: () => false, inFlight: () => false, metadata, watch });
    expect(metadata).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
});

it('rechecks the process and in-flight owner after asynchronous metadata lookup', async () => {
    for (const changed of ['alive', 'inFlight']) {
        let queried = false;
        const put = vi.fn(), watch = vi.fn();
        await recoverLateRefreshes({ journal: { list: async () => [expired()], put },
            alive: () => changed === 'alive' && queried, inFlight: () => changed === 'inFlight' && queried,
            metadata: async () => { queried = true; return { hostPid: 123, sessionConfigState: 'refreshing' }; }, watch });
        expect(put).not.toHaveBeenCalled();
        expect(watch).not.toHaveBeenCalled();
    }
});
