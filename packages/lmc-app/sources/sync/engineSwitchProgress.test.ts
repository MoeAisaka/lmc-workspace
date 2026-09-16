import { describe, expect, it } from 'vitest';
import { engineSwitchProgress, latestSwitchRequest, switchDurationEndingAt, switchRequestTarget } from './engineSwitchProgress';
import type { Message, UserTextMessage } from './typesMessage';

const REQUEST_TEXT = '[engine switch requested]\nYour user is moving this session to Codex. Before that happens, write a handoff by calling the submit_handoff tool.\nCall submit_handoff and stop.';

function request(createdAt = 1000, id = 'req'): UserTextMessage {
    return { kind: 'user-text', id, localId: null, createdAt, text: REQUEST_TEXT };
}
function arrival(createdAt: number, source: 'engine' | 'compiled' = 'engine'): Message {
    return { kind: 'agent-event', id: `ev-${createdAt}`, createdAt, event: { type: 'engine-handoff', from: 'Claude Code', fromFlavor: 'claude', source, briefing: '## Goal' } };
}
const idle = { thinking: false, agentState: null };
const run = (meta: any, messages: Message[] = [], now = 5000, session: any = idle) =>
    engineSwitchProgress({ request: request(), messages: [request(), ...messages], metadata: meta, session, now });

describe('switchRequestTarget', () => {
    it('reads the engine the request names', () => {
        expect(switchRequestTarget(REQUEST_TEXT)).toBe('codex');
        expect(switchRequestTarget('hello')).toBeNull();
    });
});

describe('engineSwitchProgress', () => {
    it('starts on the handoff step before the runner has armed anything', () => {
        const p = run({ flavor: 'claude', sessionConfigState: 'applied' });
        expect(p?.phase).toBe('running');
        if (p?.phase !== 'running') return;
        expect(p.steps.map((s) => s.state)).toEqual(['active', 'todo', 'todo', 'todo', 'todo']);
        expect(p.from).toBe('claude');
        expect(p.to).toBe('codex');
    });

    it('moves to the turn step once the engine has written its own briefing', () => {
        const p = run({ flavor: 'claude', sessionConfigState: 'queued', pendingHandoff: { from: 'Claude Code', source: 'engine', briefing: 'x' } }, [], 5000, { thinking: true });
        if (p?.phase !== 'running') throw new Error(p?.phase);
        expect(p.steps[0]).toMatchObject({ state: 'done', detail: { kind: 'engine' } });
        expect(p.steps[1]).toMatchObject({ state: 'active', detail: { kind: 'wait', reason: 'thinking' } });
    });

    it('prefers the reason the runner reported over the guess', () => {
        const p = run({ flavor: 'claude', sessionConfigState: 'queued', sessionConfigError: '等 1 个后台任务结束', pendingHandoff: { from: 'Claude Code', source: 'engine', briefing: 'x' } });
        if (p?.phase !== 'running') throw new Error(p?.phase);
        expect(p.steps[1].detail).toEqual({ kind: 'runner', text: '等 1 个后台任务结束' });
    });

    it('stays on the handoff step while only the compiled fallback is armed', () => {
        const p = run({ flavor: 'claude', sessionConfigState: 'queued', pendingHandoff: { from: 'Claude Code', source: 'compiled', briefing: 'x' } });
        if (p?.phase !== 'running') throw new Error(p?.phase);
        expect(p.steps[0].state).toBe('active');
    });

    it('is restarting while the refresh is in flight, and notes the fallback was used', () => {
        const p = run({ flavor: 'claude', sessionConfigState: 'refreshing', pendingHandoff: { from: 'Claude Code', source: 'compiled', briefing: 'x' } });
        if (p?.phase !== 'running') throw new Error(p?.phase);
        expect(p.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'active', 'todo']);
        expect(p.steps[0].detail).toEqual({ kind: 'compiled' });
        expect(p.steps[3].detail).toEqual({ kind: 'restarting' });
    });

    it('is on the read step once the flavor has flipped and no event has landed', () => {
        const p = run({ flavor: 'codex', sessionConfigState: 'verifying' });
        if (p?.phase !== 'running') throw new Error(p?.phase);
        expect(p.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'active']);
    });

    it('completes at the handoff event, with the time it took and who wrote it', () => {
        const p = run({ flavor: 'codex', sessionConfigState: 'applied' }, [arrival(22_000, 'compiled')], 99_000);
        expect(p).toMatchObject({ phase: 'complete', elapsedMs: 21_000, source: 'compiled' });
    });

    it('ignores a handoff event that belongs to a later switch', () => {
        const later = { ...request(50_000, 'req2') };
        const p = run({ flavor: 'codex', sessionConfigState: 'applied' }, [later, arrival(60_000)], 99_000);
        expect(p?.phase).toBe('superseded');
    });

    it('fails on the step it was on when the runner reported an error', () => {
        const p = run({ flavor: 'claude', sessionConfigState: 'error', sessionConfigError: 'Original Codex session has not resumed' });
        if (p?.phase !== 'failed') throw new Error(p?.phase);
        expect(p.steps[3].state).toBe('failed');   // nothing armed any more → the relaunch is what failed
        expect(p.error).toContain('not resumed');
        expect(p.afterRestart).toBe(false);
    });

    it('treats an error from the arriving runner as the restart failing, not the read', () => {
        const p = run({ flavor: 'codex', sessionConfigState: 'error', sessionConfigError: 'Claude 刷新后认证或恢复记录核验失败' });
        if (p?.phase !== 'failed') throw new Error(p?.phase);
        expect(p.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'failed', 'todo']);
    });

    it('fails on the turn step when the switch is called off while the briefing is armed', () => {
        const p = run({ flavor: 'claude', sessionConfigState: 'error', sessionConfigError: '已切换至本地终端，取消待执行刷新', pendingHandoff: { from: 'Claude Code', source: 'engine', briefing: 'x' } });
        if (p?.phase !== 'failed') throw new Error(p?.phase);
        expect(p.steps.map((s) => s.state)).toEqual(['done', 'failed', 'todo', 'todo', 'todo']);
    });

    it('fails without a reason when nothing was ever armed', () => {
        const p = run({ flavor: 'claude', sessionConfigState: 'applied' }, [], 1000 + 25_000);
        expect(p).toMatchObject({ phase: 'failed', error: null, afterRestart: false });
    });

    it('does not give up during the moment between the request and the arming RPC', () => {
        const p = run({ flavor: 'claude', sessionConfigState: 'applied' }, [], 1000 + 5_000);
        expect(p?.phase).toBe('running');
    });

    it('fails after arrival when the new engine never delivers the handoff', () => {
        const p = run({ flavor: 'codex', sessionConfigState: 'applied', sessionConfigUpdatedAt: 10_000 }, [], 10_000 + 95_000);
        expect(p).toMatchObject({ phase: 'failed', afterRestart: true });
    });
});

describe('engineSwitchProgress · login check and cancellation', () => {
    it('shows the login check as its own step while the runner is on it', () => {
        const p = run({ flavor: 'claude', sessionConfigState: 'queued', sessionConfigStage: 'preflight', pendingHandoff: { from: 'Claude Code', source: 'engine', briefing: 'x' } });
        if (p?.phase !== 'running') throw new Error(p?.phase);
        expect(p.steps.map((s) => s.state)).toEqual(['done', 'done', 'active', 'todo', 'todo']);
        expect(p.steps[2].detail).toEqual({ kind: 'checking' });
        expect(p.cancellable).toBe(false);
    });

    it('fails on the login step, with the fix, when the runner says the target is not logged in', () => {
        const p = run({ flavor: 'claude', sessionConfigState: 'error', sessionConfigErrorKind: 'auth', sessionConfigError: 'codex 尚未登录。' });
        if (p?.phase !== 'failed') throw new Error(p?.phase);
        expect(p.steps.map((s) => s.state)).toEqual(['done', 'done', 'failed', 'todo', 'todo']);
        expect(p.steps[2].detail).toEqual({ kind: 'not-logged-in' });
    });

    it('is cancellable only while queued on an Agent that can cancel', () => {
        const caps = { sessionCapabilities: { refresh: true, authentication: true, runtimeConfiguration: false, cancelRefresh: true } };
        const queued = run({ flavor: 'claude', sessionConfigState: 'queued', ...caps, pendingHandoff: { from: 'Claude Code', source: 'compiled', briefing: 'x' } });
        expect(queued).toMatchObject({ phase: 'running', cancellable: true });
        const restarting = run({ flavor: 'claude', sessionConfigState: 'refreshing', ...caps });
        expect(restarting).toMatchObject({ phase: 'running', cancellable: false });
        const oldAgent = run({ flavor: 'claude', sessionConfigState: 'queued', pendingHandoff: { from: 'Claude Code', source: 'compiled', briefing: 'x' } });
        expect(oldAgent).toMatchObject({ phase: 'running', cancellable: false });
    });

    it('is cancelled once the runner says so, whatever the metadata looks like afterwards', () => {
        const cancelled: Message = { kind: 'agent-event', id: 'c', createdAt: 3000, event: { type: 'engine-switch-cancelled', target: 'codex' } };
        const p = run({ flavor: 'claude', sessionConfigState: 'applied' }, [cancelled], 60_000);
        expect(p?.phase).toBe('cancelled');
    });
});

describe('transcript helpers', () => {
    it('finds the latest request and the duration ending at a handoff', () => {
        const messages: Message[] = [request(1000, 'a'), arrival(4000), request(9000, 'b')];
        expect(latestSwitchRequest(messages)?.id).toBe('b');
        expect(switchDurationEndingAt(messages, 4000)).toBe(3000);
        expect(switchDurationEndingAt([arrival(4000)], 4000)).toBeNull();
    });
});
