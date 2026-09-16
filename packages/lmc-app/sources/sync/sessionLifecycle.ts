export type SessionLifecycle = { seq: number; turnId?: string; thinking: boolean };

/** Message sequence numbers share one server clock; never compare them with heartbeat timestamps. */
export function resolveSessionLifecycle(previous: SessionLifecycle | undefined, raw: unknown, seq: number, loadedThrough = 0): SessionLifecycle | undefined {
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
    return { seq, turnId: typeof turnId === 'string' ? turnId : undefined, thinking: start };
}


/** Forward history repairs turn ownership only; callers must not replay its state over live heartbeats. */
export function resolveFetchedSessionLifecycle(
    previous: SessionLifecycle | undefined,
    messages: readonly { seq: number; raw: unknown }[],
    edge: 'newest' | 'older',
    loadedThrough = 0,
): SessionLifecycle | undefined {
    if (edge === 'older') return previous;
    let lifecycle = previous;
    for (const message of [...messages].sort((a, b) => a.seq - b.seq)) {
        lifecycle = resolveSessionLifecycle(lifecycle, message.raw, message.seq, loadedThrough);
    }
    return lifecycle;
}
