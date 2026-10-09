import { describe, expect, it } from 'vitest';
import { engineDiagnosticNotice } from './engineDiagnosticNotice';
import { AgentStateSchema, MachineMetadataSchema } from './storageTypes';
import { zhHans } from '@/text/translations/zh-Hans';

describe('session engine diagnostics', () => {
    const systemPrompt = { status: 'detected' as const, checkedAt: 100, owners: ['UserNotificationCenter' as const] };
    const noProgress = { since: 0, observedAt: 300000, thresholdMs: 300000, systemPrompt,
        toolProcesses: { status: 'alive' as const, liveCount: 1, checkedAt: 100 } };
    it('preserves new state on the existing channel and formats elapsed time in the session', () => {
        const state = AgentStateSchema.parse({ runtime: { phase: 'working', pid: 1, updatedAt: 100 }, engineDiagnostics: { noProgress } });
        expect(state.runtime?.phase).toBe('working');
        expect(engineDiagnosticNotice(state.engineDiagnostics, 360000)).toMatchObject({ minutes: 6, systemPrompt: { status: 'detected' }, noProgress: { toolProcesses: { status: 'alive' } } });
        expect(engineDiagnosticNotice({}, 360000)).toBeNull();
        expect(engineDiagnosticNotice(undefined, 360000)).toBeNull();
    });
    it('shows ordinary unresponsive delivery too, and chooses the latest window observation', () => {
        const delivery = { kind: 'message' as const, keys: ['a'], reason: 'unresponsive' as const, since: 10,
            systemPrompt: { status: 'none' as const, checkedAt: 200 } };
        expect(engineDiagnosticNotice({ noProgress, delivery }, 360000)).toMatchObject({ delivery, systemPrompt: { status: 'none' } });
        const state = AgentStateSchema.parse({ engineDiagnostics: { delivery } });
        expect(state.engineDiagnostics?.delivery?.reason).toBe('unresponsive');
    });
    it('does not discard unrelated state when a future diagnostic is malformed', () => {
        const state = AgentStateSchema.parse({ controlledByUser: true, engineDiagnostics: { noProgress: 'invalid', delivery: 'invalid' } });
        expect(state.controlledByUser).toBe(true); expect(engineDiagnosticNotice(state.engineDiagnostics, 100)).toBeNull();
    });
    it('shows an exit recovery notice even when the engine considers itself idle', () => {
        const state = AgentStateSchema.parse({ runtime: { phase: 'idle', pid: 1, updatedAt: 100 }, engineDiagnostics: { nativeExit: { since: 50 } } });
        expect(engineDiagnosticNotice(state.engineDiagnostics, 100)).toMatchObject({ nativeExit: { since: 50 } });
        expect(engineDiagnosticNotice(state.engineDiagnostics, 100)?.systemPrompt).toBeUndefined();
        expect(zhHans.lmc.diagnostics.nativeExit).toContain('取消退出后会自动继续收件');
    });
    it('has separate Chinese copy with buffered-input and Mac-screen instructions', () => {
        expect(zhHans.lmc.queue.steerUnresponsive).toContain('终端缓冲');
        expect(zhHans.lmc.queue.steerUnresponsive).not.toEqual(zhHans.lmc.queue.steerUnconfirmed);
        expect(zhHans.lmc.diagnostics.toolsAlive({ count: 2 })).toContain('可能仍在执行');
        expect(zhHans.lmc.diagnostics.noProgress({ minutes: 0 })).toContain('不足 1 分钟');
        expect(zhHans.lmc.diagnostics.systemPrompt({ host: 'lab-mac' })).toContain('lab-mac 这台 Mac 的屏幕');
    });
    it('retains machine FDA observations without breaking older machines', () => {
        const machine = { host: 'lab', platform: 'darwin', homeDir: '/fixture', systemDiagnostics: { fullDiskAccess: { status: 'denied', checkedAt: 1, method: 'tcc-file-open', reason: 'EPERM' } } };
        expect(MachineMetadataSchema.parse(machine).systemDiagnostics?.fullDiskAccess.status).toBe('denied');
        expect(MachineMetadataSchema.parse({ ...machine, systemDiagnostics: undefined }).host).toBe('lab');
    });
});
