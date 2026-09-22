import type { Message } from '@/sync/typesMessage';
import type { SessionLifecycle } from '@/sync/sessionLifecycle';

export type TurnElapsed = {
    startedAt: number | null;
    endedAt: number | null;
    approximate: boolean;
    status: 'running' | 'completed' | 'stopped' | 'error' | 'unknown';
};
const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const unknown = (): TurnElapsed => ({ startedAt: null, endedAt: null, approximate: true, status: 'unknown' });

/** Latest main turn only. Queued/steered user messages do not reset an observed
 * lifecycle. Parallel tools are wall-clock intervals, never added together. */
export function resolveTurnElapsed(messages: readonly Message[], lifecycle: SessionLifecycle | undefined, active: boolean): TurnElapsed | null {
    const timing = lifecycle?.timing;
    if (timing && valid(timing.startedAt)) {
        if (valid(timing.endedAt)) {
            if (timing.endedAt < timing.startedAt) return unknown();
            // A new turn may have a heartbeat before its start event arrives.
            if (active) return unknown();
            return { ...timing, status: timing.status, endedAt: timing.endedAt };
        }
        if (active && lifecycle?.thinking) return { ...timing, status: 'running' };
        // A missing completion event is not permission to keep ticking forever.
    }

    // Legacy/history fallback needs a user boundary, or a measured lifecycle
    // boundary. No session.createdAt/thinkingAt fallback: heartbeats move.
    const work: Message[] = [];
    let bounded = false;
    let promptTime: number | null = null;
    for (const message of messages) {
        if (timing?.startSeq != null) {
            if (message.serverSeq === undefined) continue;
            if (message.serverSeq < timing.startSeq) { bounded = true; break; }
            if (message.kind === 'user-text') continue;
        } else if (message.kind === 'user-text') {
            bounded = true; promptTime = message.createdAt; break;
        }
        if (message.kind === 'agent-text' && message.text.trim() || message.kind === 'tool-call' && message.tool.name !== 'file') work.push(message);
    }
    if (timing?.startSeq != null) bounded = true;
    if (!work.length) return lifecycle || active ? unknown() : null;
    if (!bounded) return unknown();
    const starts: number[] = [];
    const ends: number[] = [];
    for (const message of [...work].reverse()) {
        const tool = message.kind === 'tool-call' ? message.tool : null;
        // A replayed message timestamp can be days away from its tool clock.
        // Such mixed clocks cannot establish a trustworthy full-turn estimate.
        if (tool && valid(tool.startedAt) && valid(message.createdAt) && Math.abs(tool.startedAt - message.createdAt) > 60_000) return unknown();
        const start = tool && valid(tool.startedAt) ? tool.startedAt : message.createdAt;
        const end = tool && valid(tool.completedAt) ? tool.completedAt : tool ? start : message.createdAt;
        if (!valid(start) || !valid(end) || end < start || (promptTime !== null && start < promptTime)) return unknown();
        starts.push(start); ends.push(end);
    }
    const startedAt = valid(timing?.startedAt) ? timing.startedAt : Math.min(...starts);
    const endedAt = Math.max(...ends);
    if (endedAt < startedAt) return unknown();
    return { startedAt, endedAt: active ? null : endedAt, approximate: true, status: active ? 'running' : 'unknown' };
}
