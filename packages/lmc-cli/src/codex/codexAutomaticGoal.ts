import { detectAutomaticGoal, type AutomaticGoalPolicy } from '@/utils/automaticGoal';
import type { ThreadGoal } from './codexAppServerTypes';

/** Called after turn/start, so a native goal cannot start ahead of the user's files/settings. */
export async function createCodexAutomaticGoal(text: string, opts: {
    policy: AutomaticGoalPolicy;
    supported: boolean;
    permissionMode?: string;
    isTurnActive: () => boolean;
    getGoal: () => Promise<{ goal: ThreadGoal | null }>;
    setGoal: (objective: string) => Promise<void>;
}): Promise<void> {
    if (!opts.supported || opts.permissionMode === 'plan' || !detectAutomaticGoal(text) || !opts.isTurnActive()) return;
    const { goal } = await opts.getGoal();
    // Unknown, paused, blocked or budget-limited goals are never overwritten.
    if (goal !== null && goal.status !== 'complete') return;
    if (!opts.isTurnActive()) return;
    const objective = await opts.policy.claim(text, { supported: true, available: true, permissionMode: opts.permissionMode });
    if (objective && opts.isTurnActive()) await opts.setGoal(objective);
}
