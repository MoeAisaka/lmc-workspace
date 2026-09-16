import { expect, it, vi } from 'vitest';
import { canRefreshSession, resumeAfterExit } from './sessionRefresh';
import type { TrackedSession } from './types';

const persisted = (): TrackedSession => ({
    startedBy: 'persisted', pid: 0, happySessionId: 'sessionA',
    happySessionMetadataFromLocalWebhook: { hostPid: 123, flavor: 'codex' } as TrackedSession['happySessionMetadataFromLocalWebhook'],
    encryption: { encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey', seq: 0, metadataVersion: 0, agentStateVersion: 0 },
});
const running = async () => [{ pid: 123, name: 'node', cmd: '/opt/homebrew/lib/node_modules/happy/dist/index.mjs codex' }];

it('allows an original live session to refresh after its daemon restarts', async () => {
    expect(await canRefreshSession(persisted(), 123, running)).toBe(true);
});
it('rejects a request from a different pid after daemon restart', async () => {
    expect(await canRefreshSession(persisted(), 456, running)).toBe(false);
});
it('rejects an exited original process', async () => {
    expect(await canRefreshSession(persisted(), 123, async () => [])).toBe(false);
});
it('rejects a recycled pid owned by a different program', async () => {
    expect(await canRefreshSession(persisted(), 123, async () => [{ pid: 123, name: 'python', cmd: 'python app.py' }])).toBe(false);
});
it('rejects missing resume credentials and missing session records', async () => {
    expect(await canRefreshSession({ ...persisted(), encryption: undefined }, 123, running)).toBe(false);
    expect(await canRefreshSession(undefined, 123, running)).toBe(false);
});
it('fails closed when process discovery fails', async () => {
    expect(await canRefreshSession(persisted(), 123, async () => { throw new Error('unavailable'); })).toBe(false);
});
it('keeps refresh working for a registered session', async () => {
    expect(await canRefreshSession({ ...persisted(), startedBy: 'daemon', pid: 123 }, 123, running)).toBe(true);
});
it('does not override a different registered owner using persisted metadata', async () => {
    expect(await canRefreshSession({ ...persisted(), pid: 456 }, 123, running)).toBe(false);
});
it('rejects unsupported engines and invalid pids', async () => {
    const session = persisted();
    session.happySessionMetadataFromLocalWebhook!.flavor = 'gemini';
    expect(await canRefreshSession(session, 123, running)).toBe(false);
    for (const pid of [0, -1, 1.5, Number.NaN]) {
        expect(await canRefreshSession(persisted(), pid, running)).toBe(false);
    }
});
it('waits for the old process to exit before resuming exactly once', async () => {
    const alive = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const resume=vi.fn(async()=>{});const delay=vi.fn(async()=>{});
    await resumeAfterExit(123,alive,resume,delay);expect(delay).toHaveBeenCalledTimes(1);expect(resume).toHaveBeenCalledTimes(1);
});
it('never creates a duplicate when the old process remains alive',async()=>{
    const resume=vi.fn(async()=>{});
    await expect(resumeAfterExit(123,()=>true,resume,async()=>{},2)).rejects.toThrow(/duplicate/);
    expect(resume).not.toHaveBeenCalled();
});

it('allows registered Claude sessions to use the same safe handoff', async()=>{
 const session={...persisted(),startedBy:'daemon' as const,pid:123};
 session.happySessionMetadataFromLocalWebhook!.flavor='claude';
 expect(await canRefreshSession(session,123,running)).toBe(true);
});
