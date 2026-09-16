import { describe, expect, it } from 'vitest';
import { sessionRefreshSteps } from './sessionRefreshSteps';

const idle = { thinking: false, agentState: null };
const run = (meta: any, now = 50_000, session: any = idle, observedAt?: number) =>
    sessionRefreshSteps({ metadata: meta, session, now, observedAt });
const tones = (p: any) => p.steps.map((s: any) => s.tone);

describe('sessionRefreshSteps', () => {
    it('is idle with nothing pending and nothing recent', () => {
        expect(run({ sessionConfigState: 'applied' })).toEqual({ phase: 'idle' });
        expect(run({})).toEqual({ phase: 'idle' });
        expect(run({ sessionConfigState: 'applied', sessionConfigUpdatedAt: 10_000 }, 50_000)).toEqual({ phase: 'idle' });
    });

    it('waits on the turn first, with the runner\'s reason when it gave one', () => {
        const p = run({ sessionConfigState: 'queued', sessionConfigRequestedAt: 40_000, sessionConfigError: '等 2 条排队消息', sessionCapabilities: { refresh: true, authentication: true, runtimeConfiguration: false, cancelRefresh: true } });
        expect(p).toMatchObject({ phase: 'running', elapsedMs: 10_000, cancellable: true, slow: false });
        expect(tones(p)).toEqual(['active', 'todo', 'todo', 'todo']);
        expect((p as any).steps[0].detail).toEqual({ kind: 'runner', text: '等 2 条排队消息' });
    });

    it('guesses the wait reason when the runner said nothing', () => {
        const p = run({ sessionConfigState: 'queued', sessionConfigRequestedAt: 40_000 }, 50_000, { thinking: true });
        expect((p as any).steps[0].detail).toEqual({ kind: 'wait', reason: 'thinking' });
        expect((p as any).cancellable).toBe(false);
    });

    it('walks preflight, restart and verify off the stage and state', () => {
        expect(tones(run({ sessionConfigState: 'queued', sessionConfigStage: 'preflight', sessionConfigRequestedAt: 40_000 }))).toEqual(['done', 'active', 'todo', 'todo']);
        expect(tones(run({ sessionConfigState: 'refreshing', sessionConfigRequestedAt: 40_000, sessionConfigUpdatedAt: 45_000 }))).toEqual(['done', 'done', 'active', 'todo']);
        expect(tones(run({ sessionConfigState: 'verifying', sessionConfigRequestedAt: 40_000, sessionConfigUpdatedAt: 45_000 }))).toEqual(['done', 'done', 'done', 'active']);
    });

    it('completes for ten seconds with the duration the runner\'s stamp allows', () => {
        expect(run({ sessionConfigState: 'applied', sessionConfigRequestedAt: 30_000, sessionConfigUpdatedAt: 42_000 }, 45_000))
            .toEqual({ phase: 'complete', tookMs: 12_000, finishedAt: 42_000 });
        expect(run({ sessionConfigState: 'applied', sessionConfigUpdatedAt: 42_000 }, 45_000, idle, 41_000))
            .toEqual({ phase: 'complete', tookMs: null, finishedAt: 42_000 });
        expect(run({ sessionConfigState: 'applied', sessionConfigRequestedAt: 30_000, sessionConfigUpdatedAt: 42_000 }, 53_000)).toEqual({ phase: 'idle' });
    });

    it('falls back to when this device first saw it, for runners that do not stamp', () => {
        const p = run({ sessionConfigState: 'queued' }, 50_000, idle, 44_000);
        expect(p).toMatchObject({ phase: 'running', elapsedMs: 6_000 });
    });

    it('stops on the step the runner names', () => {
        expect(tones(run({ sessionConfigState: 'error', sessionConfigErrorKind: 'auth', sessionConfigError: 'Codex 尚未登录' }))).toEqual(['done', 'failed', 'todo', 'todo']);
        expect(run({ sessionConfigState: 'error', sessionConfigErrorKind: 'auth', sessionConfigError: 'x' })).toMatchObject({ notLoggedIn: true });
        expect(tones(run({ sessionConfigState: 'error', sessionConfigErrorKind: 'preflight', sessionConfigError: '缺少恢复记录' }))).toEqual(['done', 'failed', 'todo', 'todo']);
        expect(tones(run({ sessionConfigState: 'error', sessionConfigErrorKind: 'relaunch', sessionConfigError: 'daemon offline' }))).toEqual(['done', 'done', 'failed', 'todo']);
        expect(tones(run({ sessionConfigState: 'error', sessionConfigErrorKind: 'verify', sessionConfigError: 'thread missing' }))).toEqual(['done', 'done', 'done', 'failed']);
        // An older runner names no step; the relaunch is the likeliest.
        expect(tones(run({ sessionConfigState: 'error', sessionConfigError: 'old agent' }))).toEqual(['done', 'done', 'failed', 'todo']);
    });

    it('treats a long silence after leaving as a stall on the current step', () => {
        const p = run({ sessionConfigState: 'refreshing', sessionConfigRequestedAt: 0, sessionConfigUpdatedAt: 1_000 }, 100_000);
        expect(p).toMatchObject({ phase: 'failed', stalled: true, error: null });
        expect(tones(p)).toEqual(['done', 'done', 'failed', 'todo']);
        expect((p as any).steps[2].detail).toEqual({ kind: 'stalled' });
    });

    it('flags a slow refresh without calling it failed', () => {
        expect(run({ sessionConfigState: 'queued', sessionConfigRequestedAt: 0 }, 40_000)).toMatchObject({ phase: 'running', slow: true });
    });
});
