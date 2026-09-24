import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('cross-spawn', () => ({ spawn }));
vi.mock('node:child_process', async original => ({
    ...await original<typeof import('node:child_process')>(),
    execFileSync: () => 'codex-cli 0.156.1',
    execSync: () => 'codex-cli 0.156.1',
}));
vi.mock('@/runtime/managedRuntime', () => ({ codexExecutable: () => 'codex-test', runtimeRelease: () => null }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import { CodexAppServerClient } from './codexAppServerClient';
import { MessageQueue2 } from '@/utils/MessageQueue2';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
    for (let i = 0; i < 100 && !predicate(); i++) await pause(5);
    expect(predicate()).toBe(true);
}

function fixture(opts: { interruptCompletes?: boolean; exitDelay?: number; resumeError?: string } = {}) {
    const requests: Array<{ generation: number; method: string; params: any }> = [];
    const processes: any[] = [];
    let turn = 0;
    let resumed = false;
    let resumeError = opts.resumeError;
    spawn.mockImplementation(() => {
        const generation = processes.length;
        const proc: any = Object.assign(new EventEmitter(), {
            pid: 900001 + generation, stdout: new PassThrough(), stderr: new PassThrough(),
            exitCode: null, signalCode: null, closed: false,
        });
        const emit = (payload: unknown) => proc.stdout.write(JSON.stringify(payload) + '\n');
        proc.stdin = new Writable({ write(chunk, _encoding, callback) {
            const msg = JSON.parse(String(chunk));
            requests.push({ generation, method: msg.method, params: msg.params });
            if (msg.method === 'initialize') emit({ id: msg.id, result: { userAgent: 'test' } });
            if (msg.method === 'thread/start') emit({ id: msg.id, result: { thread: { id: 'original' }, model: 'test' } });
            if (msg.method === 'thread/resume') {
                const error = !processes[0].closed ? 'thread original already has an active writer' : resumeError;
                if (error) emit({ id: msg.id, error: { code: -32600, message: error } });
                else {
                    resumed = true;
                    emit({ id: msg.id, result: { thread: { id: 'original' }, model: 'test' } });
                }
            }
            if (msg.method === 'turn/start') {
                const id = `turn-${++turn}`;
                emit({ id: msg.id, result: { turn: { id } } });
                emit({ method: 'turn/started', params: { threadId: 'original', turn: { id } } });
                if (turn > 1) setTimeout(() => emit({ method: 'turn/completed', params: { threadId: 'original', turn: { id, status: 'completed' } } }), 120);
            }
            if (msg.method === 'turn/interrupt') {
                emit({ id: msg.id, result: {} });
                if (opts.interruptCompletes) setTimeout(() => emit({ method: 'turn/completed', params: { threadId: 'original', turn: { id: msg.params.turnId, status: 'interrupted' } } }), 5);
            }
            if (msg.method === 'turn/steer') emit({ id: msg.id, result: { turnId: msg.params.expectedTurnId } });
            callback();
        } });
        proc.stop = () => {
            if (proc.stopping) return;
            proc.stopping = true;
            setTimeout(() => {
                proc.exitCode = 0;
                proc.closed = true;
                proc.emit('exit', 0, null);
                proc.emit('close', 0, null);
            }, opts.exitDelay ?? 0);
        };
        proc.kill = proc.stop;
        processes.push(proc);
        return proc;
    });
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        const proc = processes.find(item => item.pid === Math.abs(pid));
        if (!proc || proc.closed) throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
        if (signal !== 0) proc.stop();
        return true;
    });
    return { requests, processes, get resumed() { return resumed; }, allowResume() { resumeError = undefined; } };
}

afterEach(() => { vi.restoreAllMocks(); spawn.mockReset(); });

describe('Codex insert interruption recovery', () => {
    it.each(['caption', ''])('serializes image steering with caption %j and refuses a changed turn', async text => {
        const f = fixture();
        const client = new CodexAppServerClient();
        await client.connect();
        await client.startThread({});
        const first = client.sendTurnAndWait('first');
        try {
            await until(() => client.turnId === 'turn-1');
            const image = { type: 'localImage' as const, path: '/synthetic/image.png' };
            expect(await client.steerTurn(text, { expectedTurnId: 'previous-turn', extraInputItems: [image] })).toBe(false);
            expect(f.requests.some(r => r.method === 'turn/steer')).toBe(false);
            expect(await client.steerTurn(text, { expectedTurnId: 'turn-1', extraInputItems: [image] })).toBe(true);
            expect(f.requests.find(r => r.method === 'turn/steer')?.params).toEqual({
                threadId: 'original', expectedTurnId: 'turn-1',
                input: [...(text ? [{ type: 'text', text }] : []), image],
            });
        } finally { await client.disconnect(); await first; }
    });

    it('does not mistake the immediately following turn for the interrupted turn', async () => {
        const f = fixture({ interruptCompletes: true });
        const client = new CodexAppServerClient();
        await client.connect();
        await client.startThread({});
        try {
            const first = client.sendTurnAndWait('first');
            await until(() => f.requests.some(r => r.method === 'turn/start'));
            const followUp = first.then(() => client.sendTurnAndWait('inserted'));
            const result = await client.abortTurnWithFallback({ gracePeriodMs: 40 });
            expect(result.forcedRestart).toBe(false);
            await expect(followUp).resolves.toEqual({ aborted: false });
            expect(f.processes).toHaveLength(1);
            expect(client.threadId).toBe('original');
        } finally { await client.disconnect(); }
    });

    it('waits for the old writer to exit and resume to finish before the inserted turn', async () => {
        const f = fixture({ exitDelay: 60 });
        const client = new CodexAppServerClient();
        await client.connect();
        await client.startThread({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
        try {
            const first = client.sendTurnAndWait('first');
            await until(() => f.requests.some(r => r.method === 'turn/start'));
            const followUp = first.then(() => client.sendTurnAndWait('inserted')).catch(error => error);
            const result = await client.abortTurnWithFallback({ gracePeriodMs: 1 });
            expect(result.resumedThread).toBe(true);
            expect(f.resumed).toBe(true);
            await expect(followUp).resolves.toEqual({ aborted: false });
            const next = f.requests.filter(r => r.generation === 1).map(r => r.method);
            expect(next.indexOf('turn/start')).toBeGreaterThan(next.indexOf('thread/resume'));
            expect(f.requests.filter(r => r.method === 'thread/start')).toHaveLength(1);
            expect(client.threadId).toBe('original');
        } finally { await client.disconnect(); }
    });

    it('preserves resume identity and queued input when recovery fails', async () => {
        const f = fixture({ resumeError: 'temporary resume failure' });
        const client = new CodexAppServerClient();
        const queue = new MessageQueue2(() => 'same');
        queue.push('inserted', {}, [{ name: 'a.png', mimeType: 'image/png', data: new Uint8Array([1]) }], { key: 'user-key' });
        await client.connect();
        await client.startThread({ model: 'test', approvalPolicy: 'never' });
        try {
            const first = client.sendTurnAndWait('first');
            await until(() => f.requests.some(r => r.method === 'turn/start'));
            expect((await client.abortTurnWithFallback({ gracePeriodMs: 1 })).resumedThread).toBe(false);
            await first;
            expect(client.threadId).toBe('original');
            // The runner performs this check BEFORE consuming the queue.
            await expect(client.ensureThreadReady()).rejects.toThrow('temporary resume failure');
            expect(queue.snapshot().map(item => item.key)).toEqual(['user-key']);
            f.allowResume();
            await client.ensureThreadReady();
            expect(f.requests.filter(r => r.method === 'thread/resume').at(-1)?.params).toMatchObject({ threadId: 'original', model: 'test', approvalPolicy: 'never' });
            expect(f.requests.filter(r => r.method === 'thread/start')).toHaveLength(1);
        } finally { await client.disconnect(); }
    });
});
