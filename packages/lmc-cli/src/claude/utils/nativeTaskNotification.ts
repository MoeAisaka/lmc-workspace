import { isFinishedTaskStatus } from './backgroundTasks';

export type NativeTaskNotification = { taskId: string; toolUseId?: string };

/** Only Claude's internal queue record is authoritative, never quoted chat text. */
export function parseNativeTaskNotification(raw: any): NativeTaskNotification | null {
    if (raw?.type !== 'queue-operation' || raw.operation !== 'enqueue' || typeof raw.content !== 'string') return null;
    const text = raw.content.trim();
    if (!text.startsWith('<task-notification>') || !text.endsWith('</task-notification>')) return null;
    const field = (name: string) => text.match(new RegExp(`<${name}>([^<>]+)</${name}>`))?.[1].trim();
    const taskId = field('task-id');
    if (!taskId || !isFinishedTaskStatus(field('status'))) return null;
    return { taskId, toolUseId: field('tool-use-id') };
}
