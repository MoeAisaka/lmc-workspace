import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ read: vi.fn(), clear: vi.fn(), processes: vi.fn() }));
vi.mock('@/persistence', () => ({ readDaemonState: mocks.read, clearDaemonState: mocks.clear }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));
vi.mock('@/configuration', () => ({ configuration: { currentCliVersion: '1.2.96' } }));
vi.mock('./sessionProcesses', () => ({ listSessionProcesses: mocks.processes }));

import { checkIfDaemonRunningAndCleanupStaleState, cleanupDaemonState } from './controlClient';

const state = { pid: 123, httpPort: 5001, startedWithCliVersion: '1.2.96' };
const daemon = { pid: 123, cmd: String.raw`"C:\Program Files\nodejs\node.exe" --no-warnings C:\Users\MoeAi\AppData\Roaming\npm\node_modules\link-my-cli\dist\index.mjs daemon start-sync` };
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
