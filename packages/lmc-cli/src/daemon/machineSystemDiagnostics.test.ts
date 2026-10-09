import { afterEach, describe, expect, it, vi } from 'vitest';
import { startMachineSystemDiagnostics } from './machineSystemDiagnostics';

afterEach(() => vi.useRealTimers());
describe('machine FDA capability publication', () => {
    it('publishes without holding startup, refreshes, and ignores completion after stop', async () => {
        vi.useFakeTimers();
        const value = { status: 'denied' as const, checkedAt: 1, method: 'tcc-file-open' as const, reason: 'EPERM' as const };
        const publish = vi.fn(async () => {});
        let current: any = value;
        const check = vi.fn(async () => current);
        const stop = startMachineSystemDiagnostics(publish, check);
        await vi.advanceTimersByTimeAsync(0); expect(publish).toHaveBeenCalledWith(value);
        // Same answer with a newer timestamp is not rewritten into shared machine metadata.
        current = { ...value, checkedAt: 2 };
        await vi.advanceTimersByTimeAsync(60000); expect(check).toHaveBeenCalledTimes(2); expect(publish).toHaveBeenCalledTimes(1);
        current = { status: 'readable', checkedAt: 3, method: 'tcc-file-open' };
        await vi.advanceTimersByTimeAsync(60000); expect(publish).toHaveBeenCalledTimes(2);
        stop(); await vi.advanceTimersByTimeAsync(60000); expect(publish).toHaveBeenCalledTimes(2);
        let resolve!: (diagnostic: typeof value) => void;
        const stopPending = startMachineSystemDiagnostics(publish, () => new Promise(r => { resolve = r; }));
        stopPending(); resolve(value); await vi.advanceTimersByTimeAsync(0); expect(publish).toHaveBeenCalledTimes(2);
    });
});
