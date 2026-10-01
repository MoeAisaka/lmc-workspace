import { releaseForegroundTasks, trackBackgroundTask, type BackgroundTasks } from '../utils/backgroundTasks';
import type { NativeTaskNotification } from '../utils/nativeTaskNotification';
import { isFinishedTaskStatus } from '../utils/backgroundTasks';

/** Native transcripts report starts through tool results and ends through their internal queue. */
export class NativeBackgroundTasks {
    private tasks: BackgroundTasks = new Map();
    private starting = new Set<string>();
    private untracked = new Set<string>();
    private taskTools = new Map<string, string>();
    private controls = new Map<string, { name: string; taskId: string }>();

    get active(): boolean { return !!(this.tasks.size || this.starting.size || this.untracked.size); }

    observe(raw: any): void {
        trackBackgroundTask(this.tasks, raw);
        const content = raw?.message?.content;
        const blocks = Array.isArray(content) ? content : [];
        if (raw?.type === 'assistant') {
            for (const block of blocks) {
                if (block.type === 'tool_use' && block.input?.run_in_background === true) this.starting.add(block.id ?? 'unknown');
                if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.input?.task_id === 'string'
                    && (block.name === 'TaskStop' || block.name === 'TaskOutput')) this.controls.set(block.id, { name: block.name, taskId: block.input.task_id });
            }
        }
        if (raw?.type !== 'user') return;
        const result = raw.toolUseResult;
        const toolResult = blocks.find((block: any) => block.type === 'tool_result');
        const toolUseId = toolResult?.tool_use_id;
        if (toolUseId) this.starting.delete(toolUseId);
        const taskId = result?.backgroundTaskId ?? (result?.isAsync === true ? result.agentId : undefined);
        if (typeof taskId === 'string') {
            this.tasks.set(taskId, true);
            if (toolUseId) this.taskTools.set(taskId, toolUseId);
        }
        else if (result?.isAsync === true) this.untracked.add(toolUseId ?? 'unknown');
        const control = this.controls.get(toolUseId);
        this.controls.delete(toolUseId);
        // TaskStop can succeed without emitting queue-operation notification.
        // Trust a correlated, successful native tool result, never chat text.
        if (control && toolResult?.is_error !== true) {
            const stopped = control.name === 'TaskStop' && result?.task_id === control.taskId
                && typeof result.message === 'string' && result.message.startsWith('Successfully stopped task:');
            const finished = control.name === 'TaskOutput' && result?.retrieval_status === 'success'
                && (result.task?.task_id ?? result.task?.id) === control.taskId && isFinishedTaskStatus(result.task?.status);
            if (stopped || finished) this.complete({ taskId: control.taskId });
        }
    }

    complete(event: NativeTaskNotification): void {
        this.tasks.delete(event.taskId);
        const originalTool = this.taskTools.get(event.taskId);
        this.taskTools.delete(event.taskId);
        if (originalTool) { this.starting.delete(originalTool); this.untracked.delete(originalTool); }
        if (event.toolUseId) {
            this.starting.delete(event.toolUseId);
            this.untracked.delete(event.toolUseId);
        }
    }

    endTurn(): void { releaseForegroundTasks(this.tasks); }
}
