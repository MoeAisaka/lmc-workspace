import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineLoginManager, type EngineLoginDependencies } from './engineLoginManager';
import type { LoginEvents } from './nativeEngineLogin';
import { parseLoginOutput } from './nativeEngineLogin';
import { recoveryProgress } from './registerEngineLogin';
import { isEngineLoginUrl, type EngineLoginContext, type LoginRecovery } from 'lmc-wire';
import type { Metadata } from '@/api/types';

const ctx: EngineLoginContext = { engine: 'claude', cwd: '/work', homeDir: '/home/user', configDir: '/home/user/.claude', key: 'same-scope', supported: true };
const job: LoginRecovery = { sessionId: 'session', requestedAt: 100, previousPid: 7, state: 'waiting' };
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const managers: EngineLoginManager[] = [];
function setup(overrides: Partial<EngineLoginDependencies> = {}) {
    let events!: LoginEvents;
    const child = { submit: vi.fn(() => true), cancel: vi.fn() };
    const deps: EngineLoginDependencies = {
        context: vi.fn(async () => ctx), check: vi.fn(async () => 'ready' as const),
        launch: vi.fn((_context, callbacks) => { events = callbacks; return child; }),
        recover: vi.fn(async () => [{ ...job }]), inspect: vi.fn(async input => input), ...overrides,
    };
    const manager = new EngineLoginManager(deps, 60_000); managers.push(manager);
    return { manager, deps, child, events: () => events };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { managers.splice(0).forEach(m => m.dispose()); vi.useRealTimers(); });

describe('device-owned engine login', () => {
    it('reserves the singleton before asynchronous context discovery; two clients join one attempt', async () => {
        const s = setup();
        const first = s.manager.start('claude', 'session');
        const second = s.manager.start('claude', 'session');
        expect(second.flow?.id).toBe(first.flow?.id);
        await flush(); expect(s.deps.launch).toHaveBeenCalledTimes(1);
        s.events().ready('https://claude.com/oauth/authorize?state=ephemeral');
        expect(s.manager.status('claude').flow?.state).toBe('waiting');
        expect(s.manager.start('claude', 'another-session').flow?.id).toBe(first.flow?.id);
    });
    it('never accepts control characters or sends a Claude code to Codex', async () => {
        const s = setup(); const id = s.manager.start('claude', 'session').flow!.id;
        await flush(); s.events().ready('https://claude.com/oauth/authorize');
        expect(s.manager.submit('claude', id, 'code\n/command').error).toBe('invalidCode');
        expect(s.child.submit).not.toHaveBeenCalled();
        expect(s.manager.submit('claude', id, 'one_time#state').flow?.state).toBe('submitting');
        expect(s.child.submit).toHaveBeenCalledWith('one_time#state');
        expect(JSON.stringify(s.manager.status('claude'))).not.toContain('one_time#state');
        const c = setup({ context: async () => ({ ...ctx, engine: 'codex' }) });
        const cid = c.manager.start('codex', 'codex-session').flow!.id; await flush();
        expect(c.manager.submit('codex', cid, 'one_time_code').error).toBe('unsupported');
        expect(c.child.submit).not.toHaveBeenCalled();
    });
    it('only recovers after successful native exit and credential check; retains real boundary waiting', async () => {
        const s = setup(); s.manager.start('claude', 'session'); await flush();
        s.events().ready('https://claude.com/oauth/authorize?state=secret');
        expect(s.deps.recover).not.toHaveBeenCalled();
        s.events().exit(true); await flush();
        expect(s.manager.status('claude').flow).toMatchObject({ state: 'recovering', authorizationUrl: undefined, sessions: [{ state: 'waiting' }] });
        await vi.advanceTimersByTimeAsync(120_000);
        expect(s.manager.status('claude').flow?.state).toBe('recovering');
        expect(s.child.cancel).not.toHaveBeenCalled();
        expect(s.deps.recover).toHaveBeenCalledTimes(1);
    });
    it('automatically checks external sign-in without launching OAuth or resending any task', async () => {
        const s = setup({ inspect: async j => ({ ...j, state: 'restored' }) });
        s.manager.start('claude', 'session', true); await flush();
        expect(s.deps.launch).not.toHaveBeenCalled();
        expect(s.manager.status('claude').flow?.state).toBe('complete');
    });
    it('bounds automatic checks across clients but lets the person explicitly retry', async () => {
        const s = setup({ check: async () => 'required' });
        const first = s.manager.autoCheck('claude', 'session').flow!.id; await flush();
        expect(s.manager.autoCheck('claude', 'session').flow!.id).toBe(first);
        expect(s.manager.recheck('claude', 'session').flow!.id).not.toBe(first);
    });
    it('accepts a terminal login while a remote attempt is waiting, cancelling only the login child', async () => {
        const s = setup(); s.manager.start('claude', 'session'); await flush();
        s.events().ready('https://claude.com/oauth/authorize');
        s.manager.recheck('claude', 'session'); await flush();
        expect(s.child.cancel).toHaveBeenCalledOnce();
        expect(s.manager.status('claude').flow?.state).toBe('recovering');
        expect(s.deps.recover).toHaveBeenCalledOnce();
    });
    it.each(['unknown', 'required'] as const)('keeps %s distinct and never refreshes without configured authentication', async status => {
        const s = setup({ check: async () => status });
        s.manager.start('claude', 'session', true); await flush();
        expect(s.manager.status('claude').flow).toMatchObject({ state: 'failed', error: status });
        expect(s.deps.recover).not.toHaveBeenCalled();
    });
    it('expires only the login child; removes ephemeral URL and device code', async () => {
        const s = setup(); s.manager.start('claude', 'session'); await flush();
        s.events().ready('https://claude.com/oauth/authorize?state=secret', 'DEMO-CODE');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(s.child.cancel).toHaveBeenCalledOnce();
        expect(s.manager.status('claude').flow).toMatchObject({ state: 'expired', authorizationUrl: undefined, userCode: undefined });
        s.events().exit(true); await flush(); expect(s.deps.recover).not.toHaveBeenCalled();
    });
    it('cancellation during context lookup prevents launch; stale cancellation cannot stop a replacement', async () => {
        let resolve!: (context: EngineLoginContext) => void;
        const s = setup({ context: () => new Promise(r => { resolve = r; }) });
        const old = s.manager.start('claude', 'session').flow!.id;
        s.manager.cancel('claude', old); resolve(ctx); await flush();
        expect(s.deps.launch).not.toHaveBeenCalled();
        const next = s.manager.start('claude', 'session').flow!.id;
        expect(next).not.toBe(old);
        expect(s.manager.cancel('claude', old).error).toBe('stale');
        expect(s.manager.status('claude').flow?.state).toBe('checking');
    });
    it('cancellation during verification prevents a later promise from refreshing sessions', async () => {
        let resolve!: (value: 'ready') => void;
        const s = setup({ check: () => new Promise(r => { resolve = r; }) });
        const id = s.manager.start('claude', 'session').flow!.id; await flush();
        s.events().exit(true); s.manager.cancel('claude', id); resolve('ready'); await flush();
        expect(s.deps.recover).not.toHaveBeenCalled();
    });
    it('does not misreport partial recovery as all restored', async () => {
        const s = setup({ recover: async () => [{ ...job, state: 'restored' }, { ...job, sessionId: 'other', state: 'failed' }] });
        s.manager.start('claude', 'session', true); await flush();
        expect(s.manager.status('claude').flow?.sessions.map(j => j.state)).toEqual(['restored', 'failed']);
        expect(s.manager.status('claude').flow?.state).toBe('complete');
    });
    it('fails closed for older sessions and custom credential scopes without raw exception leakage', async () => {
        for (const [context, error] of [[async () => { throw new Error('upgrade'); }, 'upgrade'], [async () => ({ ...ctx, supported: false }), 'unsupported'], [async () => { throw new Error('secret output'); }, 'offline']] as const) {
            const s = setup({ context }); s.manager.start('claude', 'session'); await flush();
            expect(s.manager.status('claude').flow?.error).toBe(error);
            expect(s.deps.launch).not.toHaveBeenCalled();
            expect(JSON.stringify(s.manager.status('claude'))).not.toContain('secret output');
        }
    });
});

it('parses only complete allowlisted native URLs, including ANSI and chunked output', () => {
    const prefix = '\u001b[32mOpen https://claude.com/oauth/author';
    expect(parseLoginOutput('claude', prefix)).toBeUndefined();
    expect(parseLoginOutput('claude', prefix + 'ize?state=demo\n\u001b[0mPaste code >')).toEqual({ url: 'https://claude.com/oauth/authorize?state=demo' });
    expect(parseLoginOutput('claude', 'Opening browser\nhttps://claude.com/cai/oauth/authorize?state=demo\nPaste code >')).toEqual({ url: 'https://claude.com/cai/oauth/authorize?state=demo' });
    expect(parseLoginOutput('codex', 'Open https://auth.openai.com/codex/device\nABCD-12345\n')).toEqual({ url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-12345' });
    expect(parseLoginOutput('codex', 'Open https://auth.openai.com/codex/device\n')).toBeUndefined();
    for (const url of ['http://claude.com/oauth/authorize', 'https://claude.com.evil.test/oauth/authorize', 'https://x@claude.com/oauth/authorize', 'https://claude.com:8443/oauth/authorize', 'https://claude.com/not-login', 'https://claude.com/oauth/authorize#fragment']) expect(isEngineLoginUrl('claude', url)).toBe(false);
});

it('requires a fresh process, fresh applied state and fresh auth before marking restored', () => {
    const metadata = { hostPid: 8, sessionConfigState: 'applied', sessionConfigUpdatedAt: 101, engineAuth: { status: 'ready', checkedAt: 101 } } as Metadata;
    expect(recoveryProgress(job, metadata).state).toBe('restored');
    expect(recoveryProgress(job, { ...metadata, hostPid: 7 }).state).toBe('waiting');
    expect(recoveryProgress(job, { ...metadata, sessionConfigUpdatedAt: 99 }).state).toBe('waiting');
    expect(recoveryProgress(job, { ...metadata, engineAuth: { status: 'ready', checkedAt: 99 } }).state).toBe('waiting');
    expect(recoveryProgress(job, { ...metadata, sessionConfigState: 'queued' }).state).toBe('waiting');
    expect(recoveryProgress(job, { ...metadata, sessionConfigState: 'error' }).state).toBe('failed');
    expect(recoveryProgress(job, metadata, false, 200).state).toBe('waiting');
    expect(recoveryProgress(job, metadata, false, 121_000).state).toBe('failed');
});
