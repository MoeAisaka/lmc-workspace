import { describe, expect, it } from 'vitest';
import { decideRefresh, isTransientRefreshError, REFRESH_MAX_ATTEMPTS, REFRESH_REASK_MS } from './refreshDecision';

const now = 1_000_000_000;
const base = { matched: false, refreshSupported: true };
const stale = (extra: object = {}) => ({ ...base, sessionConfigState: 'queued', sessionConfigUpdatedAt: now - REFRESH_REASK_MS - 1, ...extra });

describe('decideRefresh', () => {
    it('is done when the running build is the release and the session says applied', () => {
        expect(decideRefresh({ id: 's', state: 'waiting' }, { ...base, matched: true, sessionConfigState: 'applied' }, true, now)).toEqual({ kind: 'complete' });
    });

    it('waits quietly while a pending state is still fresh', () => {
        expect(decideRefresh({ id: 's', state: 'waiting' }, { ...base, sessionConfigState: 'queued', sessionConfigUpdatedAt: now - 1000 }, true, now)).toEqual({ kind: 'waiting' });
    });

    it('does not hold a session against its own work', () => {
        // Nine minutes into a turn, the runner has said so every two. That is
        // not a session failing to respond; it is one responding with "busy".
        const session = { id: 's', state: 'waiting' as const, attempts: REFRESH_MAX_ATTEMPTS };
        const decision = decideRefresh(session, stale({ sessionConfigError: '等当前回合结束' }), true, now);
        expect(decision).toEqual({ kind: 'ask', attempts: REFRESH_MAX_ATTEMPTS });
    });

    it('names a process that is gone rather than asking it anything', () => {
        const decision = decideRefresh({ id: 's', state: 'waiting' }, stale(), false, now);
        expect(decision.kind).toBe('blocked');
        expect((decision as any).error).toContain('进程已不在');
    });

    it('counts silence, and gives up on it after a few tries', () => {
        expect(decideRefresh({ id: 's', state: 'waiting', attempts: 0 }, stale(), true, now)).toEqual({ kind: 'ask', attempts: 1 });
        const last = decideRefresh({ id: 's', state: 'waiting', attempts: REFRESH_MAX_ATTEMPTS }, stale(), true, now);
        expect(last.kind).toBe('blocked');
        expect((last as any).error).toContain('多次未响应');
    });

    it('lets a pre-existing error through once, so a leftover failure does not block a fresh job', () => {
        const meta = { ...base, sessionConfigState: 'error', sessionConfigError: '上一轮的错' };
        expect(decideRefresh({ id: 's', state: 'pending' }, meta, true, now).kind).toBe('ask');
        expect(decideRefresh({ id: 's', state: 'waiting' }, meta, true, now)).toEqual({ kind: 'blocked', error: '上一轮的错' });
    });

    it('re-asks instead of blocking when a session hit a transient daemon-handoff absence', () => {
        for (const transient of [
            'No daemon running, no state file found',
            'Daemon is not running, file is stale',
            'Request failed: /prepare-session-refresh, fetch failed',
            'Request failed: /prepare-session-refresh, HTTP 503',
        ]) {
            expect(isTransientRefreshError(transient)).toBe(true);
            const meta = { ...base, sessionConfigState: 'error', sessionConfigError: transient };
            expect(decideRefresh({ id: 's', state: 'waiting', attempts: 1 }, meta, true, now)).toEqual({ kind: 'ask', attempts: 2 });
        }
    });

    it('still blocks transient daemon errors once max attempts are exhausted and never treats 4xx or auth errors as transient', () => {
        expect(isTransientRefreshError('Request failed: /prepare-session-refresh, HTTP 400')).toBe(false);
        expect(isTransientRefreshError('Claude 不支持 Codex 专属配置')).toBe(false);
        const meta = { ...base, sessionConfigState: 'error', sessionConfigError: 'No daemon running, no state file found' };
        expect(decideRefresh({ id: 's', state: 'waiting', attempts: REFRESH_MAX_ATTEMPTS }, meta, true, now)).toEqual({
            kind: 'blocked',
            error: 'No daemon running, no state file found',
        });
    });
});
