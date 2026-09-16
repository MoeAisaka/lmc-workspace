import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportSessionRefreshFailure } from './reportSessionRefreshFailure';

afterEach(() => vi.useRealTimers());

describe('reportSessionRefreshFailure', () => {
    it('waits for the error metadata write before cleanup can continue', async () => {
        let complete!: () => void;
        let written: any;
        const result = reportSessionRefreshFailure(new Error('thread/resume timed out'), updater => {
            written = updater({ name: 'Keep me' } as any);
            return new Promise<void>(resolve => { complete = resolve; });
        });
        let settled = false;
        void result.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(written).toMatchObject({ name: 'Keep me', sessionConfigState: 'error', sessionConfigError: 'thread/resume timed out', sessionConfigUpdatedAt: expect.any(Number) });
        complete();
        await expect(result).resolves.toBe('reported');
    });
    it('bounds an unavailable socket and does not mask the startup failure', async () => {
        vi.useFakeTimers();
        const result = reportSessionRefreshFailure(new Error('connect failed'), () => new Promise<void>(() => {}), 50);
        await vi.advanceTimersByTimeAsync(50);
        await expect(result).resolves.toBe('timeout');
        expect(vi.getTimerCount()).toBe(0);
    });
    it('handles a rejected metadata write without replacing the original failure', async () => {
        await expect(reportSessionRefreshFailure(new Error('resume failed'), async () => { throw new Error('socket closed'); })).resolves.toBe('unavailable');
    });
});
