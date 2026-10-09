import { describe, expect, it } from 'vitest';
import { hubTitleFixed, keepDutyPrefix } from './apiSession';
describe('keepDutyPrefix', () => {
    it('keeps a bound session\'s duty when the engine retitles it, and lets a new duty replace it', () => {
        const worker = { orchestration: { role: 'worker', hub: { sessionId: 'H', boundAt: 1, by: 'auto' } }, summary: { text: '【编码】LMC', updatedAt: 1 } } as any;
        expect(keepDutyPrefix(worker, '评审 task/lmc-50')).toBe('【编码】评审 task/lmc-50');
        expect(keepDutyPrefix(worker, '【评审】LMC')).toBe('【评审】LMC');
        expect(keepDutyPrefix({ summary: { text: '【编码】x', updatedAt: 1 } } as any, 'plain')).toBe('plain');
        expect(keepDutyPrefix(worker.orchestration ? { orchestration: worker.orchestration } as any : null, 'no prefix before')).toBe('no prefix before');
    });
    it('fixes a hub title once it has one, and leaves other sessions free to retitle', () => {
        const hub = { role: 'hub', workers: [] };
        expect(hubTitleFixed({ orchestration: hub, summary: { text: '【总控】LMC', updatedAt: 1 } } as any)).toBe(true);
        expect(hubTitleFixed({ orchestration: hub } as any)).toBe(false);
        expect(hubTitleFixed({ orchestration: hub, summary: { text: '  ', updatedAt: 1 } } as any)).toBe(false);
        expect(hubTitleFixed({ orchestration: { role: 'worker', hub: { sessionId: 'H', boundAt: 1, by: 'auto' } }, summary: { text: '【编码】x', updatedAt: 1 } } as any)).toBe(false);
        expect(hubTitleFixed({ summary: { text: 'plain', updatedAt: 1 } } as any)).toBe(false);
        expect(hubTitleFixed(null)).toBe(false);
    });
});
