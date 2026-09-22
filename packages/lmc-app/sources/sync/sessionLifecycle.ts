export type SessionLifecycle = {
    seq: number; turnId?: string; thinking: boolean;
    /** Provider turn boundaries, never heartbeat or session creation timestamps. */
    timing?: {
        startedAt: number | null; endedAt: number | null; startSeq: number | null;
        approximate: boolean; status: 'running' | 'completed' | 'stopped' | 'error';
    };
};
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Message sequence numbers share one server clock; never compare them with heartbeat timestamps. */
export function resolveSessionLifecycle(previous: SessionLifecycle | undefined, raw: unknown, seq: number, loadedThrough = 0, receivedAt?: number): SessionLifecycle | undefined {
    if (!Number.isSafeInteger(seq) || seq <= Math.max(previous?.seq ?? 0, loadedThrough)) return previous;
    const message = raw as any;
    const content = message?.content;
    const envelope = message?.role === 'session' ? content : content?.type === 'session' ? content.data : undefined;
    const legacy = message?.role === 'agent' && ['codex', 'acp'].includes(content?.type) ? content.data : undefined;
    const data = envelope ?? legacy;
    if (!data || data.isSidechain || ['subagent', 'parent_call_id', 'parentCallId', 'agent_thread_id', 'agentThreadId'].some(key => Boolean(data[key]))) return previous;
    const type = envelope ? data.ev?.t : data.type;
    const start = type === 'turn-start' || type === 'task_started';
    const end = type === 'turn-end' || type === 'task_complete' || type === 'turn_aborted';
    if (!start && !end) return previous;
    const turnId = data.turn ?? data.turn_id ?? data.turnId;
    if (end && previous?.thinking && previous.turnId && turnId !== previous.turnId) return previous;
    const time = timestamp(envelope?.time) ? envelope.time : timestamp(receivedAt) ? receivedAt : null;
    const sameTurn = previous?.turnId === turnId;
    const matching = previous?.thinking && sameTurn ? previous.timing : undefined;
    const finished = end && typeof turnId === 'string' && sameTurn && previous?.timing?.endedAt != null ? previous.timing : undefined;
    // Duplicate starts for the same turn must not reset the clock.
    const timing = finished ?? (start && matching ? matching : time === null ? undefined : {
        startedAt: start ? time : matching?.startedAt ?? null,
        endedAt: start ? null : time,
        startSeq: start ? seq : matching?.startSeq ?? null,
        approximate: !timestamp(envelope?.time) || (!start && (matching?.approximate ?? true)),
        status: start ? 'running' as const : type === 'turn_aborted' || data.ev?.status === 'cancelled'
            ? 'stopped' as const : data.ev?.status === 'failed' ? 'error' as const : 'completed' as const,
    });
    return { seq, turnId: typeof turnId === 'string' ? turnId : undefined, thinking: start, ...(timing ? { timing } : {}) };
}


/** Forward history repairs turn ownership only; callers must not replay its state over live heartbeats. */
export function resolveFetchedSessionLifecycle(
    previous: SessionLifecycle | undefined,
    messages: readonly { seq: number; raw: unknown; receivedAt?: number }[],
    edge: 'newest' | 'older',
    loadedThrough = 0,
): SessionLifecycle | undefined {
    if (edge === 'older') return previous;
    let lifecycle = previous;
    for (const message of [...messages].sort((a, b) => a.seq - b.seq)) {
        lifecycle = resolveSessionLifecycle(lifecycle, message.raw, message.seq, loadedThrough, message.receivedAt);
    }
    return lifecycle;
}
