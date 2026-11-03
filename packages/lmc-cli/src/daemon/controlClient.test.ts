import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ read: vi.fn(), clear: vi.fn(), processes: vi.fn() }));
vi.mock('@/persistence', () => ({ readDaemonState: mocks.read, clearDaemonState: mocks.clear }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));
vi.mock('@/configuration', () => ({ configuration: { currentCliVersion: '1.2.96' } }));
vi.mock('./sessionProcesses', () => ({ listSessionProcesses: mocks.processes }));

import { checkIfDaemonRunningAndCleanupStaleState, cleanupDaemonState, prepareDaemonSessionRefresh } from './controlClient';

const state = { pid: 123, httpPort: 5001, startedWithCliVersion: '1.2.96' };
const daemon = { pid: 123, cmd: String.raw`"C:\Program Files\nodejs\node.exe" --no-warnings C:\Users\alice\AppData\Roaming\npm\node_modules\link-my-cli\dist\index.mjs daemon start-sync` };
beforeEach(() => {
    vi.clearAllMocks();
    mocks.read.mockResolvedValue(state);
    mocks.processes.mockResolvedValue([daemon]);
    vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('HTTP timeout')));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('daemon identity after a health probe timeout', () => {
    it('does not replace a live Windows daemon when its HTTP response is temporarily slow', async () => {
        expect(await checkIfDaemonRunningAndCleanupStaleState()).toBe(true);
        expect(mocks.clear).not.toHaveBeenCalled();
    });
    it('keeps the normal successful HTTP probe fast', async () => {
        vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);
        expect(await checkIfDaemonRunningAndCleanupStaleState()).toBe(true);
        expect(mocks.processes).not.toHaveBeenCalled();
    });
    it('reclaims a PID reused by a session instead of a daemon', async () => {
        mocks.processes.mockResolvedValue([{ ...daemon, cmd: daemon.cmd.replace('daemon start-sync', 'codex --resume abcdefgh') }]);
        expect(await checkIfDaemonRunningAndCleanupStaleState()).toBe(false);
        expect(mocks.clear).toHaveBeenCalledWith(state.pid);
    });
    it('does not delete ownership when the command is inaccessible', async () => {
        mocks.processes.mockResolvedValue([{ pid: state.pid, cmd: undefined }]);
        await expect(checkIfDaemonRunningAndCleanupStaleState()).rejects.toThrow(/verify/i);
        expect(mocks.clear).not.toHaveBeenCalled();
    });
    it('does not delete ownership when process discovery fails', async () => {
        mocks.processes.mockRejectedValue(new Error('CIM unavailable'));
        await expect(checkIfDaemonRunningAndCleanupStaleState()).rejects.toThrow(/verify/i);
        expect(mocks.clear).not.toHaveBeenCalled();
    });
    it('cleans only the recorded owner when that process is dead', async () => {
        vi.mocked(process.kill).mockImplementation(() => { throw new Error('ESRCH'); });
        expect(await checkIfDaemonRunningAndCleanupStaleState()).toBe(false);
        expect(mocks.clear).toHaveBeenCalledWith(state.pid);
        expect(mocks.processes).not.toHaveBeenCalled();
    });
    it('restricts daemon shutdown cleanup to this process', async () => {
        await cleanupDaemonState();
        expect(mocks.clear).toHaveBeenCalledWith(process.pid);
    });
});

describe('prepareDaemonSessionRefresh across daemon handoff', () => {
    it('retries while daemon.state.json is missing or stale and succeeds once the replacement daemon answers', async () => {
        mocks.read
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ pid: 999, httpPort: 5001, startedWithCliVersion: '1.2.142' })
            .mockResolvedValue({ pid: 1000, httpPort: 5002, startedWithCliVersion: '1.2.143' });
        vi.mocked(process.kill).mockImplementation((pid: number) => {
            if (pid === 999) throw new Error('ESRCH');
            return true;
        });
        vi.mocked(fetch)
            .mockRejectedValueOnce(new Error('fetch failed'))
            .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) } as Response);

        const result = await prepareDaemonSessionRefresh('session-1', 4242, { receiveSeq: 7 }, { timeoutMs: 2_000, intervalMs: 5 });
        expect(result).toEqual({});
        expect(mocks.read).toHaveBeenCalledTimes(4);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('fails fast without retrying on permanent validation errors returned by the daemon', async () => {
        vi.mocked(fetch).mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ error: 'Claude 不支持 Codex 专属配置' }),
        } as Response);

        const result = await prepareDaemonSessionRefresh('session-1', 4242, { codexServiceTier: 'fast', engine: 'claude' }, { timeoutMs: 2_000, intervalMs: 5 });
        expect(result).toEqual({ error: 'Claude 不支持 Codex 专属配置' });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('returns the last transient error once the retry deadline expires', async () => {
        mocks.read.mockResolvedValue(null);
        const result = await prepareDaemonSessionRefresh('session-1', 4242, {}, { timeoutMs: 20, intervalMs: 5 });
        expect(result).toEqual({ error: 'No daemon running, no state file found' });
        expect(mocks.read.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
});
