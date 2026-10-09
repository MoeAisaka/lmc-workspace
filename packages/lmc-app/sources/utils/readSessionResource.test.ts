import { beforeEach, expect, it, vi } from 'vitest';
const { sessionRPC, machineRPC, state } = vi.hoisted(() => ({ sessionRPC: vi.fn(), machineRPC: vi.fn(), state: { sessions: {} as Record<string, any> } }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { sessionRPC, machineRPC } }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => state } }));
import { readSessionResource } from './readSessionResource';
beforeEach(() => { vi.resetAllMocks(); state.sessions = {}; });

it.each(['claude', 'codex'])('reads a disconnected %s session from its own host and cwd', async flavor => {
    state.sessions.s = { metadata: { flavor, machineId: 'original-host', path: '/project with spaces' } };
    sessionRPC.mockRejectedValue(new Error('RPC target disconnected'));
    machineRPC.mockResolvedValue({ success: true, content: 'AQ==' });
    await expect(readSessionResource('s', { path: 'preview.png', action: 'download', offset: 3, revision: 'r1' })).resolves.toMatchObject({ success: true });
    expect(machineRPC).toHaveBeenCalledWith('original-host', 'resource-file', { path: '/project with spaces/preview.png', action: 'download', offset: 3, revision: 'r1' });
});
it('keeps absolute paths and supports an exited session with no RPC registration', async () => {
    state.sessions.s = { metadata: { machineId: 'host', path: '/project' } };
    sessionRPC.mockRejectedValue(new Error('RPC method not available'));
    await readSessionResource('s', { path: '/tmp/p.png', action: 'download' });
    expect(machineRPC).toHaveBeenCalledWith('host', 'resource-file', { path: '/tmp/p.png', action: 'download' });
});
it('does not replay file errors, denied operations or unrelated transport failures', async () => {
    state.sessions.s = { metadata: { machineId: 'host', path: '/project' } };
    sessionRPC.mockResolvedValueOnce({ success: false, error: 'ENOENT' });
    expect(await readSessionResource('s', { path: 'p.png', action: 'download' })).toEqual({ success: false, error: 'ENOENT' });
    for (const reason of ['Permission denied', 'Not connected to the server']) {
        sessionRPC.mockRejectedValueOnce(new Error(reason));
        await expect(readSessionResource('s', { path: 'p.png', action: 'download' })).rejects.toThrow(reason);
    }
    expect(machineRPC).not.toHaveBeenCalled();
});
it('never guesses another host or a daemon cwd, or bypasses Rig capabilities', async () => {
    sessionRPC.mockRejectedValue(new Error('RPC target disconnected'));
    for (const metadata of [{}, { machineId: 'host' }, { machineId: 'host', path: '/p', client: { id: 'rig' } }]) {
        state.sessions.s = { metadata };
        await expect(readSessionResource('s', { path: 'p.png', action: 'download' })).rejects.toThrow('RPC target disconnected');
    }
    expect(machineRPC).not.toHaveBeenCalled();
});
it('returns a disconnected host error without retries or session mutation', async () => {
    state.sessions.s = { metadata: { machineId: 'host', path: '/p' } };
    sessionRPC.mockRejectedValue(new Error('RPC target disconnected'));
    machineRPC.mockRejectedValue(new Error('RPC method not available'));
    await expect(readSessionResource('s', { path: 'p.png', action: 'download' })).rejects.toThrow('RPC method not available');
    expect(machineRPC).toHaveBeenCalledTimes(1);
});
it('asks the Windows host once when an older session process refuses a drive path', async () => {
    state.sessions.s = { metadata: { machineId: 'win-host', path: 'D:\\AgentWork\\project' } };
    const refusal = { success: false, error: '无效的文件路径' };
    sessionRPC.mockResolvedValue(refusal);
    machineRPC.mockResolvedValueOnce({ success: true, content: 'AQ==' });
    await expect(readSessionResource('s', { path: 'D:/out/shot.png', action: 'download' })).resolves.toMatchObject({ success: true });
    expect(machineRPC).toHaveBeenCalledWith('win-host', 'resource-file', { path: 'D:/out/shot.png', action: 'download' });
    // The host being unreachable leaves the session's own answer in place.
    machineRPC.mockRejectedValueOnce(new Error('RPC target disconnected'));
    expect(await readSessionResource('s', { path: 'D:/out/shot.png', action: 'download' })).toEqual(refusal);
    // Not a drive path: the refusal stands and nothing else is asked.
    machineRPC.mockClear();
    expect(await readSessionResource('s', { path: 'https://example.com/a.png', action: 'download' })).toEqual(refusal);
    expect(machineRPC).not.toHaveBeenCalled();
});
it('resolves a relative path against a Windows project directory when the session is gone', async () => {
    state.sessions.s = { metadata: { machineId: 'win-host', path: 'D:\\AgentWork\\project' } };
    sessionRPC.mockRejectedValue(new Error('RPC target disconnected'));
    machineRPC.mockResolvedValue({ success: true, content: 'AQ==' });
    await readSessionResource('s', { path: 'out/shot.png', action: 'download' });
    expect(machineRPC).toHaveBeenCalledWith('win-host', 'resource-file', { path: 'D:\\AgentWork\\project/out/shot.png', action: 'download' });
});
