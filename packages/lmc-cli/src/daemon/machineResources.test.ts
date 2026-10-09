import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineResources } from '@/api/types';
import { aggregateProcessTrees, defaultSampleIntervalMs, parsePsTable, parseVmStatAvailable, parseWindowsProcessCsv, resourcesChanged, startMachineResources } from './machineResources';

afterEach(() => vi.useRealTimers());

describe('machine resource sampling', () => {
    it('parses vm_stat into reclaimable bytes', () => {
        const out = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               1000.\nPages active:                             5000.\nPages inactive:                           2000.\nPages speculative:                         500.\nPages wired down:                         3000.\n';
        expect(parseVmStatAvailable(out)).toBe(3500 * 16384);
    });
    it('parses ps and PowerShell process tables', () => {
        expect(parsePsTable('  1     0  1024\n 42     1  2048\nbad line\n')).toEqual([{ pid: 1, ppid: 0, rssBytes: 1024 * 1024 }, { pid: 42, ppid: 1, rssBytes: 2048 * 1024 }]);
        expect(parseWindowsProcessCsv('"ProcessId","ParentProcessId","WorkingSetSize"\r\n"4","0","1234"\r\n"100","4","99"\r\n')).toEqual([{ pid: 4, ppid: 0, rssBytes: 1234 }, { pid: 100, ppid: 4, rssBytes: 99 }]);
    });
    it('sums each root with its descendants only', () => {
        const table = [
            { pid: 1, ppid: 0, rssBytes: 1 }, { pid: 10, ppid: 1, rssBytes: 100 }, { pid: 11, ppid: 10, rssBytes: 20 }, { pid: 12, ppid: 11, rssBytes: 3 },
            { pid: 20, ppid: 1, rssBytes: 200 }, { pid: 21, ppid: 20, rssBytes: 5 },
        ];
        expect(aggregateProcessTrees(table, [{ sessionId: 'a', pid: 10 }, { sessionId: 'b', pid: 20 }, { sessionId: 'gone', pid: 99 }]))
            .toEqual({ a: { rssBytes: 123, processes: 3 }, b: { rssBytes: 205, processes: 2 } });
    });
    it('samples Windows a third as often, because each sample starts PowerShell', () => {
        expect(defaultSampleIntervalMs('win32')).toBe(60_000);
        expect(defaultSampleIntervalMs('darwin')).toBe(20_000);
        expect(defaultSampleIntervalMs('linux')).toBe(20_000);
    });
    it('only republishes on a meaningful change', () => {
        const base = { sampledAt: 1, memory: { totalBytes: 16e9, availableBytes: 8e9 }, sessions: { a: { rssBytes: 1e9, processes: 3 } }, daemonRssBytes: 1e8 };
        expect(resourcesChanged(undefined, base)).toBe(true);
        expect(resourcesChanged(base, { ...base, sampledAt: 2, memory: { totalBytes: 16e9, availableBytes: 8e9 + 10e6 } })).toBe(false);
        expect(resourcesChanged(base, { ...base, memory: { totalBytes: 16e9, availableBytes: 8e9 + 60e6 } })).toBe(true);
        expect(resourcesChanged(base, { ...base, sessions: { a: { rssBytes: 1e9 + 20e6, processes: 4 } } })).toBe(false);
        expect(resourcesChanged(base, { ...base, sessions: { a: { rssBytes: 1.1e9, processes: 3 } } })).toBe(true);
        expect(resourcesChanged(base, { ...base, sessions: {} })).toBe(true);
        expect(resourcesChanged(base, { ...base, sessions: { ...base.sessions, b: { rssBytes: 1, processes: 1 } } })).toBe(true);
    });
    it('publishes on an interval, skips unchanged samples and failed samples, and stops', async () => {
        vi.useFakeTimers();
        const publish = vi.fn(async (_resources: MachineResources) => {});
        let rss = 100e6;
        const table = () => [{ pid: 7, ppid: 1, rssBytes: 1e6 }, { pid: 50, ppid: 7, rssBytes: rss }];
        const sampleProcesses = vi.fn(async () => table());
        const stop = startMachineResources({ publish, roots: () => [{ sessionId: 's1', pid: 50 }], daemonPid: 7, intervalMs: 20_000,
            sampleMemory: async () => ({ totalBytes: 16e9, availableBytes: 4e9 }), sampleProcesses });
        await vi.advanceTimersByTimeAsync(0);
        expect(publish).toHaveBeenCalledTimes(1);
        expect(publish.mock.calls[0][0]).toMatchObject({ memory: { totalBytes: 16e9, availableBytes: 4e9 }, daemonRssBytes: 1e6, sessions: { s1: { rssBytes: 100e6, processes: 1 } } });
        await vi.advanceTimersByTimeAsync(20_000); expect(publish).toHaveBeenCalledTimes(1);
        rss = 200e6; await vi.advanceTimersByTimeAsync(20_000); expect(publish).toHaveBeenCalledTimes(2);
        sampleProcesses.mockRejectedValueOnce(new Error('ps failed')); rss = 400e6; await vi.advanceTimersByTimeAsync(20_000); expect(publish).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(20_000); expect(publish).toHaveBeenCalledTimes(3);
        stop(); rss = 800e6; await vi.advanceTimersByTimeAsync(40_000); expect(publish).toHaveBeenCalledTimes(3);
    });
});
