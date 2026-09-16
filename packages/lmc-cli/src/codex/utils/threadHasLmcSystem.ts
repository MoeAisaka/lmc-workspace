import { HAPPY_SYSTEM_BLOCK_OPEN } from '@/codex/codexPrompt';
import type { Thread } from '@/codex/codexAppServerTypes';

/**
 * Whether a resumed thread already carries the instructions we inject once per
 * conversation — the option-chips prompt and the title instruction, both wrapped
 * in `<happy-system>` markers.
 *
 * Resuming used to assume the answer was yes and set the injected flag without
 * checking. A thread that never received them (created before the feature, or
 * resumed from a process that exited before the first turn) then stayed without
 * them for the rest of its life, because the flag only resets on /clear. The
 * visible symptom is an agent that never emits `<options>`, so its answers never
 * become chips.
 *
 * Only user messages are searched: that is where the wrapper is written. Reading
 * agent text as evidence would be wrong — a model quoting the marker back does
 * not mean the instructions were ever given.
 */
export function threadHasLmcSystemBlock(thread: Pick<Thread, 'turns'>): boolean {
    for (const turn of thread.turns ?? []) {
        for (const item of turn.items ?? []) {
            if (item.type !== 'userMessage' || !Array.isArray(item.content)) continue;
            for (const part of item.content) {
                if (part.type === 'text' && part.text.includes(HAPPY_SYSTEM_BLOCK_OPEN)) return true;
            }
        }
    }
    return false;
}
