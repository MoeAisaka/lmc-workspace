import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sessionRPC: vi.fn(), applySessions: vi.fn(), request: vi.fn(), emitWithAck: vi.fn(), getState: vi.fn(), encryptRaw: vi.fn(async (m: unknown) => m), decryptRaw: vi.fn(async (m: unknown) => m) }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./apiSocket', () => ({ apiSocket: { sessionRPC: mocks.sessionRPC, request: mocks.request, emitWithAck: mocks.emitWithAck } }));
vi.mock('./storage', () => ({ storage: { getState: mocks.getState } }));
vi.mock('./sync', () => ({ sync: { encryption: { getSessionEncryption: () => mocks } } }));
import { sessionArchive } from './ops';

describe('manual archive when the session process cannot be reached', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getState.mockReturnValue({ applySessions: mocks.applySessions, sessions: { offline: { id: 'offline', active: false, metadataVersion: 2, metadata: { lifecycleState: 'running', path: '/p', flavor: 'codex' } } } });
        mocks.emitWithAck.mockResolvedValue({ result: 'success', version: 3 });
        mocks.sessionRPC.mockResolvedValue({ success: true });
        mocks.request.mockResolvedValue({ ok: true });
    });

    it.each(['claude', 'codex'])('persists a %s archive marker before deactivating, so another device sees the same archive', async (flavor) => {
        mocks.getState().sessions.offline.metadata.flavor = flavor;
        await expect(sessionArchive('offline')).resolves.toEqual({ success: true });
        expect(mocks.emitWithAck).toHaveBeenCalledWith('update-metadata', expect.objectContaining({ sid: 'offline', expectedVersion: 2, metadata: expect.objectContaining({ lifecycleState: 'archived', archivedBy: 'user', path: '/p', flavor }) }), 15_000);
        expect(mocks.emitWithAck.mock.invocationCallOrder[0]).toBeLessThan(mocks.request.mock.invocationCallOrder[0]);
        expect(mocks.request).toHaveBeenCalledWith('/v1/sessions/offline/archive', { method: 'POST' });
    });

    it('does not report success or deactivate when the archive marker could not be saved', async () => {
        mocks.emitWithAck.mockResolvedValue({ result: 'error' });
        expect(await sessionArchive('offline')).toMatchObject({ success: false });
        expect(mocks.request).not.toHaveBeenCalled();
        expect(mocks.applySessions).not.toHaveBeenCalled();
    });

    it.each(['claude', 'codex'])('archives an offline legacy %s record without waiting for its absent process', async (flavor) => {
        mocks.getState().sessions.offline.metadata = { path: '/p', flavor };
        mocks.sessionRPC.mockImplementation(() => new Promise(() => {}));
        await expect(sessionArchive('offline')).resolves.toEqual({ success: true });
        expect(mocks.sessionRPC).not.toHaveBeenCalled();
        // No push event is delivered. The ack alone updates the list.
        expect(mocks.applySessions).toHaveBeenCalledWith([expect.objectContaining({
            id: 'offline', metadataVersion: 3,
            metadata: expect.objectContaining({ lifecycleState: 'archived', archivedBy: 'user', flavor }),
        })]);
    });

    it.each([true, false])('uses the same archive path for a connected process (stop success: %s)', async (success) => {
        mocks.getState().sessions.offline.active = true;
        mocks.sessionRPC.mockResolvedValue({ success });
        await expect(sessionArchive('offline')).resolves.toEqual({ success: true });
        expect(mocks.sessionRPC).toHaveBeenCalledWith('offline', 'killSession', {});
        expect(mocks.sessionRPC.mock.invocationCallOrder[0]).toBeLessThan(mocks.emitWithAck.mock.invocationCallOrder[0]);
    });

    it('reports a timed-out metadata write without pretending to archive', async () => {
        mocks.emitWithAck.mockRejectedValue(new Error('operation has timed out'));
        expect(await sessionArchive('offline')).toEqual({ success: false, message: 'operation has timed out' });
        expect(mocks.applySessions).not.toHaveBeenCalled();
        expect(mocks.request).not.toHaveBeenCalled();
    });

    it('keeps agent state received while the metadata write was pending', async () => {
        mocks.emitWithAck.mockImplementationOnce(async () => {
            mocks.getState().sessions.offline.agentStateVersion = 9;
            mocks.getState().sessions.offline.agentState = { controlledByUser: true };
            return { result: 'success', version: 3 };
        });
        await sessionArchive('offline');
        expect(mocks.applySessions).toHaveBeenCalledWith([expect.objectContaining({ agentStateVersion: 9, agentState: { controlledByUser: true } })]);
    });

    it('preserves concurrent metadata when retrying a manual archive', async () => {
        mocks.emitWithAck.mockResolvedValueOnce({ result: 'version-mismatch', version: 3, metadata: { path: '/p', lifecycleState: 'running', modelMode: 'new-choice' } });
        await expect(sessionArchive('offline')).resolves.toEqual({ success: true });
        expect(mocks.emitWithAck).toHaveBeenLastCalledWith('update-metadata', expect.objectContaining({ expectedVersion: 3, metadata: expect.objectContaining({ modelMode: 'new-choice', lifecycleState: 'archived' }) }), 15_000);
    });
});
