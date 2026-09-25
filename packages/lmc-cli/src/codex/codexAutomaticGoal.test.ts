import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AutomaticGoalPolicy } from '@/utils/automaticGoal';
import type { ThreadGoal } from './codexAppServerTypes';
import { createCodexAutomaticGoal } from './codexAutomaticGoal';

describe('Codex automatic native goals', () => {
    const text = '修复登录问题，测试验证通过后部署';
    async function options() {
        return { policy: new AutomaticGoalPolicy(join(await mkdtemp(join(tmpdir(), 'codex-auto-goal-')), 'state.json')), supported: true, isTurnActive: () => true, getGoal: vi.fn(async (): Promise<{ goal: ThreadGoal | null }> => ({ goal: null })), setGoal: vi.fn(async () => {}) };
    }
    it('creates once after turn acceptance and preserves every non-complete native goal', async () => {
        const opts = await options();
        for (const status of ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'unknown']) {
            opts.getGoal.mockResolvedValue({ goal: { status } as ThreadGoal });
            await createCodexAutomaticGoal(text, opts);
        }
        expect(opts.setGoal).not.toHaveBeenCalled();
        opts.getGoal.mockResolvedValue({ goal: null });
        await createCodexAutomaticGoal(text, opts);
        await createCodexAutomaticGoal(text, opts);
        expect(opts.setGoal).toHaveBeenCalledExactlyOnceWith(text);
    });
    it('does not restart a task completed during lookup, and fails closed on a failed lookup', async () => {
        const opts = await options();
        let active = true;
        opts.isTurnActive = () => active;
        opts.getGoal.mockImplementation(async () => { active = false; return { goal: null }; });
        await createCodexAutomaticGoal(text, opts);
        expect(opts.setGoal).not.toHaveBeenCalled();
        active = true;
        opts.getGoal.mockRejectedValue(new Error('unavailable'));
        await expect(createCodexAutomaticGoal(text, opts)).rejects.toThrow('unavailable');
        expect(opts.setGoal).not.toHaveBeenCalled();
    });
});
