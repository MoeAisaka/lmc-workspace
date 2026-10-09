import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeExitGuard, NATIVE_EXIT_REFUSED, NATIVE_EXIT_UNCONFIRMED, nativeExitBlockedWork, nativeExitConfirmation, NativeExitRefusedError } from './exitGuard';

const menu = ['Background work is running', 'The following will stop when you exit:',
    'scheduled task · reminder', '1. Exit and stop tasks', '2. Move to background and exit',
    '3. Stay', 'Select with numbers [1-3]. Then Enter to submit:'];
let guard: NativeExitGuard;
beforeEach(() => vi.useFakeTimers());
afterEach(() => { guard?.exited(0); vi.useRealTimers(); });
function setup(choice: 'stay' | 'stop' = 'stay') {
    let screen = { lines: ['$'], cursor: { x: 1, y: 0 }, composer: true, revision: 1 };
    const write = vi.fn(), retained = vi.fn(), uncertain = vi.fn();
    guard = new NativeExitGuard({ snapshot: () => screen, settled: async () => {}, write, retained, uncertain });
    const show = (lines: string[], composer = false, y = lines.length - 1) => {
        screen = { lines, cursor: { x: 1, y }, composer, revision: screen.revision + 1 };
    };
    const result = guard.leave(choice).then(() => 'exited', error => error.message);
    return { result, show, write, retained, uncertain };
}
const realMenu = ['you: /exit', 'Background work is running', 'The following will stop when you exit:', 'scheduled task  · Runs once in 1h · reminder',
    '1. Exit and stop tasks', '2. Move to background and exit', '3. Stay', 'Select with numbers [1-3]. Then Enter to submit:'];

describe('native exit menu', () => {
    it('names the work Claude would stop and finds each option by its label, not its number', () => {
        expect(nativeExitBlockedWork(realMenu)).toEqual(['scheduled task · Runs once in 1h · reminder']);
        expect(nativeExitBlockedWork(['Background work is running', '1. Stay'])).toEqual([]);
        expect(nativeExitConfirmation(realMenu, 'stop')).toBe(1);
        expect(nativeExitConfirmation(['Background work is running', '1. Stay', '2. Exit and stop tasks'], 'stop')).toBe(2);
        expect(nativeExitConfirmation(['Background work is running', '1. Stay'], 'stop')).toBeNull();
    });
    it('reports the refused exit with the work it kept', async () => {
        const f = setup(); await vi.advanceTimersByTimeAsync(600);
        f.show(realMenu); await vi.advanceTimersByTimeAsync(500);
        f.show([...realMenu, '$'], true); await vi.advanceTimersByTimeAsync(500);
        expect(await f.result).toContain('scheduled task · Runs once in 1h · reminder');
        expect(f.retained).toHaveBeenCalledWith(['scheduled task · Runs once in 1h · reminder']);
        expect(new NativeExitRefusedError([]).message).toBe(NATIVE_EXIT_REFUSED);
    });
    it('answers "Exit and stop" only when asked to stop, and only counts the real exit as success', async () => {
        const f = setup('stop'); await vi.advanceTimersByTimeAsync(600);
        f.show(realMenu); await vi.advanceTimersByTimeAsync(500);
        expect(f.write.mock.calls.map(c => c[0])).toEqual(['\x1b[200~/exit\x1b[201~', '\x1b[13;1u', '1\r']);
        expect(f.retained).not.toHaveBeenCalled(); expect(guard.active).toBe(true);
        guard.exited(0); expect(await f.result).toBe('exited');
    });
    it('keeps the work when asked to stop but Claude offers no such option', async () => {
        const f = setup('stop'); await vi.advanceTimersByTimeAsync(600);
        f.show(['Background work is running', 'The following will stop when you exit:', 'reminder', '1. Stay', 'Select with numbers [1-1]. Then Enter to submit:']);
        await vi.advanceTimersByTimeAsync(500);
        expect(f.write.mock.calls.map(c => c[0])).toEqual(['\x1b[200~/exit\x1b[201~', '\x1b[13;1u', '1\r']);
        f.show(['$'], true); await vi.advanceTimersByTimeAsync(500);
        expect(await f.result).toContain('reminder'); expect(f.retained).toHaveBeenCalledWith(['reminder']);
    });
});
describe('native exit receipts', () => {
    it('does not report success just because the terminal stayed quiet for 2.5 seconds', async () => {
        const f = setup(); let done = false; void f.result.then(() => { done = true; });
        await vi.advanceTimersByTimeAsync(6000);
        expect(done).toBe(false); expect(guard.active).toBe(true); expect(guard.writing).toBe(false);
        guard.exited(0); expect(await f.result).toBe('exited');
    });
    it('cancels one late menu, verifies its dismissal and keeps the background task intact', async () => {
        const f = setup(); await vi.advanceTimersByTimeAsync(6000);
        f.show(menu); await vi.advanceTimersByTimeAsync(2000);
        expect(f.write.mock.calls.map(c => c[0])).toEqual(['\x1b[200~/exit\x1b[201~', '\x1b[13;1u', '3\r']);
        expect(guard.active).toBe(true); expect(f.retained).not.toHaveBeenCalled();
        f.show([...menu, '$'], true); await vi.advanceTimersByTimeAsync(500);
        expect(await f.result).toBe(new NativeExitRefusedError(['scheduled task · reminder']).message); expect(guard.active).toBe(false);
        expect(f.retained).toHaveBeenCalledTimes(1);
    });
    it('reports a bounded failure but still rescues a menu arriving after the deadline', async () => {
        const f = setup(); await vi.advanceTimersByTimeAsync(31_000);
        expect(await f.result).toBe(NATIVE_EXIT_UNCONFIRMED); expect(f.uncertain).toHaveBeenCalledTimes(1);
        expect(guard.active).toBe(true); expect(guard.writing).toBe(false);
        f.show(menu); await vi.advanceTimersByTimeAsync(500);
        f.show(['$'], true); await vi.advanceTimersByTimeAsync(500);
        expect(guard.active).toBe(false); expect(f.retained).toHaveBeenCalledTimes(1);
        expect(f.write.mock.calls.filter(c => c[0] === '3\r')).toHaveLength(1);
    });
    it('leaves an unknown prompt to the person and observes their manual cancellation', async () => {
        const f = setup(); f.show(['Unfamiliar prompt', 'Choose:']); await vi.advanceTimersByTimeAsync(31_000);
        expect(await f.result).toBe(NATIVE_EXIT_UNCONFIRMED); expect(f.write).toHaveBeenCalledTimes(2);
        guard.cancelledManually(2); await vi.advanceTimersByTimeAsync(1000);
        expect(guard.active).toBe(true);
        f.show(['$'], true); await vi.advanceTimersByTimeAsync(500);
        expect(guard.active).toBe(false);
    });
    it('does not answer exit text left above another active prompt or an idle composer', async () => {
        const f = setup(); await vi.advanceTimersByTimeAsync(500);
        f.show([...menu, 'Different menu:']); await vi.advanceTimersByTimeAsync(500);
        f.show([...menu, 'Different menu:', '1. Allow', '2. Deny', 'Select with numbers [1-2]. Then Enter to submit:']); await vi.advanceTimersByTimeAsync(500);
        f.show([...menu, '$'], true); await vi.advanceTimersByTimeAsync(500);
        expect(f.write).toHaveBeenCalledTimes(2); expect(guard.active).toBe(true);
    });
    it('does not call a repeated leave successful or write a second exit command', async () => {
        const f = setup(); await vi.advanceTimersByTimeAsync(500);
        await expect(guard.leave()).rejects.toThrow(NATIVE_EXIT_UNCONFIRMED);
        expect(f.write).toHaveBeenCalledTimes(2);
    });
});
