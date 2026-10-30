import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionRegistration } from './sessionRegistration';

afterEach(() => vi.useRealTimers());
describe('session startup registration', () => {
    it.each(['codex', 'claude', 'agy', 'tmux'])('accepts the observed 38.242s startup for %s', async () => {
        vi.useFakeTimers();
        const registration = new SessionRegistration();
        const received = vi.fn();
        const pending = registration.wait(34780).then(received);
        await vi.advanceTimersByTimeAsync(38_242);
        expect(received).not.toHaveBeenCalled();
        registration.complete(34780, 'created-session');
        await pending;
        expect(received).toHaveBeenCalledWith({ type: 'success', sessionId: 'created-session' });
        expect(vi.getTimerCount()).toBe(0);
    });
    it('reports an actual exit immediately and ignores a subsequent notification', async () => {
        vi.useFakeTimers();
        const registration = new SessionRegistration();
        const pending = registration.wait(1);
        registration.exited(1);
        registration.complete(1, 'too-late');
        expect(await pending).toMatchObject({ type: 'error', errorMessage: expect.stringContaining('已退出') });
        expect(vi.getTimerCount()).toBe(0);
    });
    it('bounds an unresponsive startup without claiming the process has stopped', async () => {
        vi.useFakeTimers();
        const registration = new SessionRegistration();
        const pending = registration.wait(1);
        await vi.advanceTimersByTimeAsync(90_000);
        expect(await pending).toMatchObject({ type: 'error', errorMessage: expect.stringContaining('可能仍在启动') });
        registration.complete(1, 'late-session');
        expect(vi.getTimerCount()).toBe(0);
    });
    it('does not resolve a different process', async () => {
        vi.useFakeTimers();
        const registration = new SessionRegistration();
        const first = registration.wait(1);
        const secondResult = vi.fn();
        const second = registration.wait(2).then(secondResult);
        registration.complete(1, 'one');
        expect(await first).toEqual({ type: 'success', sessionId: 'one' });
        expect(secondResult).not.toHaveBeenCalled();
        registration.exited(2);
        await second;
    });
});
