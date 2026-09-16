import { describe, expect, it } from 'vitest';
import { releaseForegroundTasks, trackBackgroundTask, type BackgroundTasks } from './backgroundTasks';

const started = (id: string, type = 'local_bash', backgrounded = false) =>
    ({ type: 'system', subtype: 'task_started', task_id: id, task_type: type, is_backgrounded: backgrounded });

describe('background task tracking', () => {
    it('releases a local_bash task that only reports a terminal task_updated patch', () => {
        const tasks: BackgroundTasks = new Map();
        trackBackgroundTask(tasks, started('bsrt4veku'));
        expect(tasks.size).toBe(1);
        expect(trackBackgroundTask(tasks, { type: 'system', subtype: 'task_updated', task_id: 'bsrt4veku', patch: { status: 'running' } })).toBe(false);
        expect(tasks.size).toBe(1);
        expect(trackBackgroundTask(tasks, { type: 'system', subtype: 'task_updated', task_id: 'bsrt4veku', patch: { status: 'completed', end_time: 1 } })).toBe(true);
        expect(tasks.size).toBe(0);
    });

    it('releases an agent task through task_notification', () => {
        const tasks: BackgroundTasks = new Map();
        trackBackgroundTask(tasks, started('brnsgwowq', 'agent'));
        expect(trackBackgroundTask(tasks, { type: 'system', subtype: 'task_notification', task_id: 'brnsgwowq', status: 'completed' })).toBe(true);
        expect(tasks.size).toBe(0);
    });

    it('keeps a paused task and ignores unrelated messages', () => {
        const tasks: BackgroundTasks = new Map();
        trackBackgroundTask(tasks, started('bdo3yh6j5'));
        trackBackgroundTask(tasks, { type: 'system', subtype: 'task_updated', task_id: 'bdo3yh6j5', patch: { status: 'paused' } });
        expect(trackBackgroundTask(tasks, { type: 'assistant', task_id: 'bdo3yh6j5' })).toBe(false);
        expect(trackBackgroundTask(tasks, { type: 'system', subtype: 'task_updated', patch: { status: 'completed' } })).toBe(false);
        expect([...tasks.keys()]).toEqual(['bdo3yh6j5']);
    });

    it('releases a foreground task whose terminal message never arrives when the turn ends', () => {
        // The real incident: a local_bash task ("Wait for the archive job to
        // release the lock") announced itself and never reported again, so the
        // session answered every refresh request with 等 1 个后台任务结束 for
        // two Agent rollouts and could not be upgraded.
        const tasks: BackgroundTasks = new Map();
        trackBackgroundTask(tasks, started('bzck7s1jk'));
        expect(tasks.size).toBe(1);
        expect(releaseForegroundTasks(tasks)).toBe(true);
        expect(tasks.size).toBe(0);
        // Nothing left to release is not an event.
        expect(releaseForegroundTasks(tasks)).toBe(false);
    });

    it('keeps a backgrounded task across the turn that started it', () => {
        const tasks: BackgroundTasks = new Map();
        trackBackgroundTask(tasks, started('bkeepme01', 'local_bash', true));
        trackBackgroundTask(tasks, started('bdropme02'));
        expect(releaseForegroundTasks(tasks)).toBe(true);
        expect([...tasks.keys()]).toEqual(['bkeepme01']);
        // It still leaves the normal way.
        expect(trackBackgroundTask(tasks, { type: 'system', subtype: 'task_notification', task_id: 'bkeepme01', status: 'completed' })).toBe(true);
        expect(tasks.size).toBe(0);
    });

    it('reports failed and killed tasks as finished so a refresh is not stranded', () => {
        for (const status of ['failed', 'killed', 'stopped']) {
            const tasks: BackgroundTasks = new Map();
            trackBackgroundTask(tasks, started('b1v1u9bwt'));
            expect(trackBackgroundTask(tasks, { type: 'system', subtype: 'task_updated', task_id: 'b1v1u9bwt', patch: { status } })).toBe(true);
            expect(tasks.size).toBe(0);
        }
    });
});
