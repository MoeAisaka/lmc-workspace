import { releaseForegroundTasks, trackBackgroundTask, type BackgroundTasks } from '../utils/backgroundTasks';
import type { NativeTaskNotification } from '../utils/nativeTaskNotification';

/** Native transcripts report starts through tool results and ends through their internal queue. */
export class NativeBackgroundTasks {
    private tasks: BackgroundTasks = new Map();
    private starting = new Set<string>();
    private untracked = new Set<string>();

    get active(): boolean { return !!(this.tasks.size || this.starting.size || this.untracked.size); }

    observe(raw: any): void {
        trackBackgroundTask(this.tasks, raw);
        const content = raw?.message?.content;
        const blocks = Array.isArray(content) ? content : [];
        if (raw?.type === 'assistant') {
            for (const block of blocks) {
                if (block.type === 'tool_use' && block.input?.run_in_background === true) this.starting.add(block.id ?? 'unknown');
            }
        }
        if (raw?.type !== 'user') return;
        const result = raw.toolUseResult;
        const toolUseId = blocks.find((block: any) => block.type === 'tool_result')?.tool_use_id;
        if (toolUseId) this.starting.delete(toolUseId);
        if (typeof result?.backgroundTaskId === 'string') this.tasks.set(result.backgroundTaskId, true);
        else if (result?.isAsync === true) this.untracked.add(toolUseId ?? 'unknown');
    }

    complete(event: NativeTaskNotification): void {
        this.tasks.delete(event.taskId);
        if (event.toolUseId) {
            this.starting.delete(event.toolUseId);
            this.untracked.delete(event.toolUseId);
        }
    }

    endTurn(): void { releaseForegroundTasks(this.tasks); }
}
