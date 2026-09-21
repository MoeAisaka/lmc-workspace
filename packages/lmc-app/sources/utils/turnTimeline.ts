import type { Message, ToolCall, ToolCallMessage } from '@/sync/typesMessage';

export type TimelineStatus = 'running' | 'waiting' | 'completed' | 'error' | 'stopped' | 'unknown';
export type TimelineStep = {
    type: 'step';
    id: string;
    message: ToolCallMessage;
    status: TimelineStatus;
    startedAt: number | null;
    endedAt: number | null;
    durationMs: number | null;
    offsetMs: number | null;
};
export type TimelineItem = TimelineStep | {
    type: 'parallel'; id: string; steps: TimelineStep[]; durationMs: number; offsetMs: number;
} | { type: 'message'; id: string; message: Message };

export function validTimestamp(value: number | null | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function isCurrentTurnMessage(messages: Message[], id: string): boolean {
    for (const message of messages) {
        if (message.kind === 'user-text') return false;
        if (message.id === id) return true;
    }
    return false;
}

/** Missing completion records must never look like a tool still running days later. */
export function getTimelineStatus(tool: ToolCall, active: boolean): TimelineStatus {
    if (tool.permission?.status === 'denied' || tool.permission?.status === 'canceled') return 'stopped';
    if (tool.state === 'error') return 'error';
    if (tool.state === 'completed') return 'completed';
    if (!active) return 'unknown';
    return tool.permission?.status === 'pending' ? 'waiting' : 'running';
}

export function getToolTiming(tool: ToolCall, active: boolean, now: number) {
    const status = getTimelineStatus(tool, active);
    const startedAt = validTimestamp(tool.startedAt) ? tool.startedAt : null;
    const endedAt = validTimestamp(tool.completedAt) && startedAt !== null && tool.completedAt >= startedAt
        ? tool.completedAt : null;
    const durationMs = status === 'waiting'
        ? (validTimestamp(tool.createdAt) ? Math.max(0, now - tool.createdAt) : null)
        : startedAt !== null && endedAt !== null
            ? endedAt - startedAt
            : status === 'running' && startedAt !== null ? Math.max(0, now - startedAt) : null;
    return { status, startedAt, endedAt, durationMs };
}

/** Input follows the transcript's newest-first order. Only measured overlapping
 * execution intervals establish concurrency; adjacent calls alone do not. */
export function buildTurnTimeline(messages: Message[], turnStart: number, active: boolean, now: number): TimelineItem[] {
    const items: TimelineItem[] = [];
    let pending: TimelineStep[] = [];
    let start = 0;
    let end = 0;
    const flush = () => {
        if (pending.length === 1) items.push(pending[0]);
        if (pending.length > 1) items.push({
            type: 'parallel', id: `parallel-${pending[0].id}`, steps: pending,
            durationMs: end - start, offsetMs: Math.max(0, start - turnStart),
        });
        pending = [];
    };
    for (const message of [...messages].reverse()) {
        if (message.kind !== 'tool-call') {
            flush();
            // Thinking/internal tools were already filtered by the message grouper.
            if (!(message.kind === 'agent-text' && message.isThinking)) items.push({ type: 'message', id: message.id, message });
            continue;
        }
        const timing = getToolTiming(message.tool, active, now);
        const step: TimelineStep = {
            type: 'step', id: message.id, message, ...timing,
            offsetMs: timing.startedAt === null ? null : Math.max(0, timing.startedAt - turnStart),
        };
        const intervalEnd = timing.endedAt ?? (timing.status === 'running' ? now : null);
        const measurable = timing.startedAt !== null && intervalEnd !== null && intervalEnd > timing.startedAt
            && timing.status !== 'waiting' && timing.status !== 'stopped';
        if (!measurable) {
            flush(); items.push(step); continue;
        }
        const s = timing.startedAt!;
        const e = intervalEnd!;
        if (pending.length && s < end && e > start) {
            pending.push(step); start = Math.min(start, s); end = Math.max(end, e);
        } else {
            flush(); pending = [step]; start = s; end = e;
        }
    }
    flush();
    return items;
}

export function formatTimelineOffset(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `+${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
