export type SessionLifecycle = {
    seq: number; turnId?: string; thinking: boolean;
    /** Provider turn boundaries, never heartbeat or session creation timestamps. */
    timing?: {
        startedAt: number | null; endedAt: number | null; startSeq: number | null;
        approximate: boolean; status: 'running' | 'completed' | 'stopped' | 'error';
    };
};
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

function parseMainLifecycleBoundary(raw: unknown, receivedAt?: number) {
    const message = raw as any;
    const content = message?.content;
    const envelope = content?.type === 'session' ? content.data : message?.role === 'session' ? content : undefined;
    const legacy = message?.role === 'agent' && ['codex', 'acp'].includes(content?.type) ? content.data : undefined;
    const data = envelope ?? legacy;
    if (!data || data.isSidechain || ['subagent', 'parent_call_id', 'parentCallId', 'agent_thread_id', 'agentThreadId'].some(key => Boolean(data[key]))) return null;
    const type = envelope ? data.ev?.t : data.type;
    const start = type === 'turn-start' || type === 'task_started';
    const end = type === 'turn-end' || type === 'task_complete' || type === 'turn_aborted';
    if (!start && !end) return null;
    const turnId = data.turn ?? data.turn_id ?? data.turnId;
    const hasEnvelopeTime = timestamp(envelope?.time);
    const time = hasEnvelopeTime ? envelope.time : timestamp(receivedAt) ? receivedAt : null;
    return {
        start,
        end,
        type,
        status: data.ev?.status,
        turnId: typeof turnId === 'string' ? turnId : undefined,
        hasEnvelopeTime,
        time,
    };
}

/** Message sequence numbers share one server clock; never compare them with heartbeat timestamps. */
export function resolveSessionLifecycle(previous: SessionLifecycle | undefined, raw: unknown, seq: number, loadedThrough = 0, receivedAt?: number): SessionLifecycle | undefined {
    if (!Number.isSafeInteger(seq) || seq <= Math.max(previous?.seq ?? 0, loadedThrough)) return previous;
    const boundary = parseMainLifecycleBoundary(raw, receivedAt);
    if (!boundary) return previous;
    const { start, end, type, status, turnId, hasEnvelopeTime, time } = boundary;
    if (end && previous?.thinking && previous.turnId && turnId !== previous.turnId) return previous;
    const sameTurn = previous?.turnId === turnId;
    const matching = previous?.thinking && sameTurn ? previous.timing : undefined;
    const finished = end && turnId !== undefined && sameTurn && previous?.timing?.endedAt != null ? previous.timing : undefined;
    // Duplicate starts for the same turn must not reset the clock.
    const timing = finished ?? (start && matching ? matching : time === null ? undefined : {
        startedAt: start ? time : matching?.startedAt ?? null,
        endedAt: start ? null : time,
        startSeq: start ? seq : matching?.startSeq ?? null,
        approximate: !hasEnvelopeTime || (!start && (matching?.approximate ?? true)),
        status: start ? 'running' as const : type === 'turn_aborted' || status === 'cancelled'
            ? 'stopped' as const : status === 'failed' ? 'error' as const : 'completed' as const,
    });
    return { seq, turnId, thinking: start, ...(timing ? { timing } : {}) };
}


/** Forward history repairs turn ownership only; callers must not replay its state over live heartbeats. */
export function resolveFetchedSessionLifecycle(
    previous: SessionLifecycle | undefined,
    messages: readonly { seq: number; raw: unknown; receivedAt?: number }[],
    edge: 'newest' | 'older',
    loadedThrough = 0,
): SessionLifecycle | undefined {
    const ordered = [...messages].sort((a, b) => a.seq - b.seq);
    if (edge === 'older') {
        if (!previous) {
            let seeded: SessionLifecycle | undefined;
            for (const message of ordered) {
                seeded = resolveSessionLifecycle(seeded, message.raw, message.seq, 0, message.receivedAt);
            }
            return seeded?.thinking ? seeded : undefined;
        }
        if (previous.turnId && previous.timing && previous.timing.startedAt === null) {
            for (const message of ordered) {
                if (!Number.isSafeInteger(message.seq) || message.seq >= previous.seq) continue;
                const boundary = parseMainLifecycleBoundary(message.raw, message.receivedAt);
                if (!boundary?.start || boundary.turnId !== previous.turnId || boundary.time === null) continue;
                return {
                    ...previous,
                    timing: {
                        ...previous.timing,
                        startedAt: boundary.time,
                        startSeq: message.seq,
                        approximate: !boundary.hasEnvelopeTime,
                    },
                };
            }
        }
        return previous;
    }
    let lifecycle = previous;
    for (const message of ordered) {
        lifecycle = resolveSessionLifecycle(lifecycle, message.raw, message.seq, loadedThrough, message.receivedAt);
    }
    return lifecycle;
}
