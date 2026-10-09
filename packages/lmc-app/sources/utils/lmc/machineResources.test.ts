import { describe, expect, it } from 'vitest';
import { formatBytes, formatMemoryUsage, machineResourcesOf, sessionMemoryFigure } from './machineResources';

const GB = 1024 ** 3, MB = 1024 ** 2;
describe('machine resources', () => {
    it('formats bytes and usage pairs', () => {
        expect(formatBytes(820 * MB)).toBe('820 MB');
        expect(formatBytes(1.24 * GB)).toBe('1.2 GB');
        expect(formatBytes(12.6 * GB)).toBe('13 GB');
        expect(formatMemoryUsage(9.8 * GB, 16 * GB)).toBe('9.8/16 GB');
        expect(formatMemoryUsage(16.25 * GB, 32 * GB)).toBe('16/32 GB');
        expect(formatMemoryUsage(300 * MB, 900 * MB)).toBe('300/900 MB');
    });
    it('reads the daemon sample only from an online machine', () => {
        const resources = { sampledAt: 1, memory: { totalBytes: 16 * GB, availableBytes: 6 * GB }, sessions: { s1: { rssBytes: GB, processes: 3 } } };
        const machine = (active: boolean, daemonState: any) => ({ id: 'm', active, daemonState } as any);
        expect(machineResourcesOf(machine(true, { resources }))).toEqual(resources);
        expect(machineResourcesOf(machine(false, { resources }))).toBeNull();
        expect(machineResourcesOf(machine(true, { resources: { memory: 'bad' } }))).toBeNull();
        expect(machineResourcesOf(machine(true, null))).toBeNull();
    });
    it('builds the composer figure: session tree, machine usage, and the tight threshold', () => {
        const machine = (availableGb: number, active = true) => ({ id: 'machine-1234', active, metadata: { host: 'MacMini' },
            daemonState: { resources: { sampledAt: 1, memory: { totalBytes: 32 * GB, availableBytes: availableGb * GB }, sessions: { s1: { rssBytes: 1.1 * GB, processes: 3 } } } } } as any);
        const session = (id: string) => ({ id, metadata: { machineId: 'machine-1234' } } as any);
        expect(sessionMemoryFigure(session('s1'), machine(16))).toEqual({ machineId: 'machine-1234', machineName: 'MacMini', sessionBytes: 1.1 * GB, usedBytes: 16 * GB, totalBytes: 32 * GB, tight: false });
        // 85% used is the line; a session the daemon is not tracking still shows its machine.
        expect(sessionMemoryFigure(session('other'), machine(4.8))).toMatchObject({ sessionBytes: null, tight: true });
        expect(sessionMemoryFigure(session('s1'), machine(4.9))?.tight).toBe(false);
        expect(sessionMemoryFigure(session('s1'), machine(16, false))).toBeNull();
        expect(sessionMemoryFigure(session('s1'), null)).toBeNull();
        expect(sessionMemoryFigure(null, machine(16))).toBeNull();
    });
});
