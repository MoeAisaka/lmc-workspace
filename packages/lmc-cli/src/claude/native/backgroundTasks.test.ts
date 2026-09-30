import { describe, expect, it } from 'vitest';
import { NativeBackgroundTasks } from './backgroundTasks';
import { parseNativeTaskNotification } from '../utils/nativeTaskNotification';

describe('native background lifecycle', () => {
    it('keeps real background work across Stop and releases only the matching completion', () => {
        const tasks = new NativeBackgroundTasks();
        tasks.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', input: { run_in_background: true } }] } });
        expect(tasks.active).toBe(true);
        tasks.observe({ type: 'user', toolUseResult: { backgroundTaskId: 'task-1' }, message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1' }] } });
        tasks.endTurn(); tasks.complete({ taskId: 'other' }); expect(tasks.active).toBe(true);
        tasks.complete({ taskId: 'task-1', toolUseId: 'tool-1' }); expect(tasks.active).toBe(false);
    });
    it('does not pin a failed background launch or mistake a foreground turn end for background completion', () => {
        const tasks = new NativeBackgroundTasks();
        tasks.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', input: { run_in_background: true } }] } });
        tasks.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: true }] } });
        expect(tasks.active).toBe(false);
        tasks.observe({ type: 'user', toolUseResult: { isAsync: true }, message: { content: [{ type: 'tool_result', tool_use_id: 'tool-2' }] } });
        tasks.endTurn(); expect(tasks.active).toBe(true);
        tasks.complete({ taskId: 'agent-2', toolUseId: 'tool-2' }); expect(tasks.active).toBe(false);
    });
    it('accepts terminal internal notifications but never quoted chat or still-running status', () => {
        const content = '<task-notification>\n<task-id>b123</task-id>\n<tool-use-id>tool-1</tool-use-id>\n<status>completed</status>\n</task-notification>';
        expect(parseNativeTaskNotification({ type: 'queue-operation', operation: 'enqueue', content })).toEqual({ taskId: 'b123', toolUseId: 'tool-1' });
        expect(parseNativeTaskNotification({ type: 'user', content })).toBeNull();
        expect(parseNativeTaskNotification({ type: 'queue-operation', operation: 'remove', content })).toBeNull();
        expect(parseNativeTaskNotification({ type: 'queue-operation', operation: 'enqueue', content: content.replace('completed', 'running') })).toBeNull();
    });
});
