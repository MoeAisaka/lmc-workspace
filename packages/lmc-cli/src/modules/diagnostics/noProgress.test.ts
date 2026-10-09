import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_NO_PROGRESS_MS, NoProgressMonitor, noProgressMessage, noProgressThreshold } from './noProgress';

function fixture() {
    let now = 0;
    const publish = vi.fn();
    const systemPrompt = vi.fn(async () => ({ status: 'detected' as const, checkedAt: now, owners: ['UserNotificationCenter' as const] }));
    const monitor = new NoProgressMonitor({ now: () => now, thresholdMs: DEFAULT_NO_PROGRESS_MS, publish, systemPrompt,
        toolProcesses: async () => ({ status: 'alive', liveCount: 1, checkedAt: now }) });
    return { monitor, publish, systemPrompt, advance: (ms: number) => { now += ms; } };
}
describe('busy no-progress observations', () => {
    it('triggers once at the threshold, keeps tools factual, then clears on progress', async () => {
        const f = fixture();
        f.advance(DEFAULT_NO_PROGRESS_MS); await f.monitor.check(); expect(f.publish).not.toHaveBeenCalled();
        f.monitor.setBusy(true); f.advance(DEFAULT_NO_PROGRESS_MS - 1); await f.monitor.check(); expect(f.publish).not.toHaveBeenCalled();
        f.advance(1); await f.monitor.check();
        const [value, notify] = f.publish.mock.calls[0];
        expect(value).toMatchObject({ since: DEFAULT_NO_PROGRESS_MS, thresholdMs: DEFAULT_NO_PROGRESS_MS, toolProcesses: { status: 'alive', liveCount: 1 }, systemPrompt: { status: 'detected' } });
        expect(notify).toBe(true);
        const message = noProgressMessage(value, 'lab-mac');
        expect(message).toContain('无进展 5 分钟'); expect(message).toContain('可能仍在执行'); expect(message).toContain('lab-mac'); expect(message).not.toMatch(/卡死|杀|重发/);
        expect(noProgressMessage({ ...value, observedAt: value.since + 6000 })).toContain('不足 1 分钟');
        f.advance(60_000); await f.monitor.check();
        expect(f.publish.mock.calls.filter(call => call[1])).toHaveLength(1);
        f.monitor.progress(); expect(f.publish).toHaveBeenLastCalledWith(undefined, false);
        f.advance(DEFAULT_NO_PROGRESS_MS); await f.monitor.check();
        expect(f.publish.mock.calls.filter(call => call[1])).toHaveLength(2);
        f.monitor.setBusy(false); expect(f.publish).toHaveBeenLastCalledWith(undefined, false);
    });
    it('does not let slow diagnostics restore stale state after activity or cleanup', async () => {
        const f = fixture();
        let finish!: (value: any) => void;
        f.systemPrompt.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        f.monitor.setBusy(true); f.advance(DEFAULT_NO_PROGRESS_MS);
        const checking = f.monitor.check();
        f.monitor.progress(); finish({ status: 'none', checkedAt: 1 }); await checking;
        expect(f.publish).not.toHaveBeenCalled();
        f.monitor.stop(); f.advance(DEFAULT_NO_PROGRESS_MS); await f.monitor.check(); expect(f.publish).not.toHaveBeenCalled();
    });
    it('degrades failed diagnostics to unknown instead of losing the observation', async () => {
        const publish = vi.fn();
        let now = 0;
        const monitor = new NoProgressMonitor({ thresholdMs: 1000, now: () => now, publish,
            systemPrompt: async () => { throw Error('denied'); }, toolProcesses: async () => { throw Error('ps failed'); } });
        monitor.setBusy(true); now = 1000; await monitor.check();
        expect(publish).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: expect.objectContaining({ status: 'unknown' }), toolProcesses: expect.objectContaining({ status: 'unknown' }) }), true);
    });
    it('defaults to five minutes and accepts an explicit machine threshold', () => {
        for (const value of ['', '0', '-1', 'NaN', 'Infinity']) expect(noProgressThreshold(value)).toBe(DEFAULT_NO_PROGRESS_MS);
        expect(noProgressThreshold('120000')).toBe(120000);
    });
});
