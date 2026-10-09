import { describe, expect, it } from 'vitest';
import { describeRole } from './roles';

describe('current execution policy in both role briefings', () => {
    const hub = describeRole({ role: 'hub', workers: [] }, 'fixture')!;
    const worker = describeRole({ role: 'worker', hub: { sessionId: 'hub', by: 'manual', boundAt: 1 } }, 'fixture')!;
    it('selects the executor machine catalog without a fixed model matrix', () => {
        expect(hub).toContain('catalog published by the executor machine');
        expect(hub).toContain('experiment');
        expect(hub).toContain('model and effort explicitly');
        expect(hub + worker).not.toMatch(/gpt-\d|claude-(opus|sonnet)|Fable \d|Model matrix/);
    });
    it('keeps DIRECT, one return and the quota-only handoff exception aligned', () => {
        expect(hub).toContain('Default DIRECT');
        for (const text of [hub, worker]) {
            expect(text).toContain('two attempts');
            expect(text).toContain('blocked: quota');
            expect(text).toContain('deadline');
            expect(text).toMatch(/cannot subdelegate|Do not subdelegate/);
        }
        expect(hub).toContain('Other blocked, rejected or in-flight tasks cannot change executor');
        expect(hub).toContain('Configuration/review receipts require no extra acknowledgement');
    });
    it('is shorter than the a82c26c1 role text for equal identities', () => {
        expect(hub.length).toBeLessThanOrEqual(5680);
        expect(worker.length).toBeLessThanOrEqual(1184);
    });
});
