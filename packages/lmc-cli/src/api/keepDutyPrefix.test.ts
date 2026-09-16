import { describe, expect, it } from 'vitest';
import { keepDutyPrefix } from './apiSession';
describe('keepDutyPrefix', () => {
    it('keeps a bound session\'s duty when the engine retitles it, and lets a new duty replace it', () => {
        const worker = { orchestration: { role: 'worker', hub: { sessionId: 'H', boundAt: 1, by: 'auto' } }, summary: { text: '【编码】LMC', updatedAt: 1 } } as any;
        expect(keepDutyPrefix(worker, '评审 task/lmc-50')).toBe('【编码】评审 task/lmc-50');
        expect(keepDutyPrefix(worker, '【评审】LMC')).toBe('【评审】LMC');
        expect(keepDutyPrefix({ summary: { text: '【编码】x', updatedAt: 1 } } as any, 'plain')).toBe('plain');
        expect(keepDutyPrefix(worker.orchestration ? { orchestration: worker.orchestration } as any : null, 'no prefix before')).toBe('no prefix before');
    });
});
