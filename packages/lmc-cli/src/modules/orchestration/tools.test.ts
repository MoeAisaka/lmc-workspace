import * as childProcess from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { Metadata } from '@/api/types';
import { parseEnvelope, formatReviewEnvelope } from './envelope';
import { boardUpdate } from './board';
import { mailIdempotencyKey } from '../agentMail/agentMail';
import { assignTask, inScope, nextAttempt, reportTask, spawnWorker, workerTitle, checksPass, type OrchestrationPort } from './tools';

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, execFile: vi.fn(actual.execFile) };
});

function port(initial: Metadata, extra: Partial<OrchestrationPort> = {}): OrchestrationPort & { metadataNow: () => Metadata; mails: { to: string; text: string }[] } {
    let metadata = initial;
    const mails: { to: string; text: string }[] = [];
    return {
        selfId: 'SELF', cwd: '/repo', machineId: 'M1', machineName: () => 'MacMini',
        metadata: () => metadata, metadataNow: () => metadata, mails,
        updateMetadata: async (u) => { metadata = u(metadata); },
        spawnLocal: vi.fn(async () => ({ success: true, sessionId: 'W9' })),
        sendMail: async (to, text) => { mails.push({ to, text }); return { ok: true as const }; },
        transcript: async () => ({ entries: [{ seq: 1, body: { role: 'user', content: { type: 'text', text: 'hello from the worker' } } }] }),
        now: () => 1000,
        ...extra,
    };
}

describe('orchestration tools', () => {
    const contract = { model: 'claude-sonnet-5', effort: 'medium', scope: 'src/task.ts', budget_minutes: 10 };
    const taskArgs = { ...contract, sessionId: 'W', id: 'bounded', goal: 'fix', acceptance: 'test passes' };
    const hub = () => ({ orchestration: { role: 'hub', workers: [{ sessionId: 'W', by: 'auto', boundAt: 1 }, { sessionId: 'W2', by: 'auto', boundAt: 1 }] } } as Metadata);

    it.each(['model', 'effort', 'scope', 'goal', 'acceptance', 'budget_minutes'] as const)('refuses missing %s before dispatch', async (field) => {
        const p = port(hub());
        const args = { ...taskArgs, [field]: undefined };
        expect((await assignTask(p, args as typeof taskArgs)).isError).toBe(true);
        expect(p.mails).toEqual([]);
    });

    it('requires explicit birth model and effort before spawning', async () => {
        const p = port({} as Metadata);
        expect((await spawnWorker(p, { duty: 'coding' })).isError).toBe(true);
        expect(p.spawnLocal).not.toHaveBeenCalled();
    });

    it('keeps worker subdelegation forbidden with an otherwise valid configuration', async () => {
        const p = port({ orchestration: { role: 'worker', hub: { sessionId: 'H', by: 'auto', boundAt: 1 } } } as Metadata);
        expect((await spawnWorker(p, { ...contract, duty: 'coding' })).isError).toBe(true);
        expect((await assignTask(p, taskArgs)).isError).toBe(true);
        expect(p.spawnLocal).not.toHaveBeenCalled();
        expect(p.mails).toEqual([]);
    });

    it('persists rejection independently of the display board and does not extend the deadline', async () => {
        const p = port(hub());
        await assignTask(p, taskArgs);
        const dispatch = parseEnvelope(p.mails[0].text)!.fields.dispatch;
        await p.updateMetadata(boardUpdate(formatReviewEnvelope({ id: taskArgs.id, attempt: 1, status: 'rejected', fields: { dispatch } }), 'W')!);
        const saved = JSON.parse(JSON.stringify(p.metadataNow()));
        saved.orchestration.board = [];
        const later = port(saved, { now: () => 500000 });
        expect((await assignTask(later, { ...taskArgs, budget_minutes: 20 })).isError).toBe(true);
        expect((await assignTask(later, taskArgs)).isError).toBe(false);
        expect(parseEnvelope(later.mails[0].text)?.attempt).toBe(2);
        expect(later.metadataNow().delegationLedger?.bounded.deadline).toBe(601000);
        const dispatch2 = parseEnvelope(later.mails[0].text)!.fields.dispatch;
        await later.updateMetadata(boardUpdate(formatReviewEnvelope({ id: taskArgs.id, attempt: 2, status: 'rejected', fields: { dispatch: dispatch2 } }), 'W')!);
        expect((await assignTask(later, taskArgs)).isError).toBe(true);
        expect(later.mails).toHaveLength(1);
    });

    it('does not send after a CAS replay discovers an unbound worker or after a failed write', async () => {
        const p = port(hub());
        const initial = p.metadataNow();
        p.updateMetadata = async update => {
            update(initial); // first proposal loses a version conflict
            update({ ...initial, orchestration: { role: 'hub', workers: [] } });
        };
        expect((await assignTask(p, taskArgs)).isError).toBe(true);
        expect(p.mails).toEqual([]);
        p.updateMetadata = async () => { throw new Error('write failed'); };
        expect((await assignTask(p, taskArgs)).isError).toBe(true);
        expect(p.mails).toEqual([]);
    });

    it('keeps delivery retry identity but rejects different work under an in-flight task', async () => {
        const p = port(hub());
        await assignTask(p, { ...taskArgs, dispatch_id: 'stable' });
        await assignTask(p, { ...taskArgs, dispatch_id: 'stable' });
        expect((await assignTask(p, { ...taskArgs, dispatch_id: 'stable', goal: 'different' })).isError).toBe(true);
        expect(p.mails).toHaveLength(2);
        expect(p.mails[1].text).toBe(p.mails[0].text);
    });

    it.each(['claude-sonnet-5', 'gpt-6-astra'])('dispatches explicit %s without inheriting the hub model', async model => {
        const p = port({ ...hub(), modelMode: 'hub-custom' });
        expect((await assignTask(p, { ...taskArgs, model })).isError).toBe(false);
        const envelope = parseEnvelope(p.mails[0].text);
        if (envelope?.kind !== 'task') throw new Error('Expected task');
        expect(envelope.fields.run).toContain(`model=${model}`);
    });

    it.each([0, -1, 1.5, 1441, NaN])('rejects invalid budget %s without sending work', async budget_minutes => {
        const p = port(hub());
        expect((await assignTask(p, { ...taskArgs, budget_minutes })).isError).toBe(true);
        expect(p.mails).toEqual([]);
    });

    it('never silently evicts durable limits when the ledger is full', async () => {
        const delegationLedger: NonNullable<Metadata['delegationLedger']> = {};
        for (let i = 0; i < 256; i++) delegationLedger[`t-${i}`] = { worker: 'W', attempt: 2, deadline: 10, budgetMinutes: 1, dispatch: `d-${i}`, state: 'rejected' };
        const p = port({ ...hub(), delegationLedger });
        expect((await assignTask(p, taskArgs)).isError).toBe(true);
        expect(p.mails).toEqual([]);
        expect(p.metadataNow().delegationLedger).toEqual(delegationLedger);
    });

    it('persists a shared deadline and prevents retry reset, worker replacement and a third attempt', async () => {
        const p = port(hub());
        expect((await assignTask(p, taskArgs)).isError).toBe(false);
        expect(parseEnvelope(p.mails[0].text)?.fields).toMatchObject({ budget: expect.stringContaining('600000') });
        await p.updateMetadata(m => ({ ...m, orchestration: { ...m.orchestration!, board: m.orchestration!.board!.map(e => ({ ...e, state: 'rejected' as const })) } }));
        expect((await assignTask(p, { ...taskArgs, attempt: 1 })).isError).toBe(true);
        expect((await assignTask(p, { ...taskArgs, sessionId: 'W2' })).isError).toBe(true);
        expect((await assignTask(p, taskArgs)).isError).toBe(false);
        // Restart and loss of the bounded display board must not reset the ledger.
        const saved = JSON.parse(JSON.stringify(p.metadataNow()));
        saved.orchestration.board = [];
        const restarted = port(saved);
        expect((await assignTask(restarted, { ...taskArgs, attempt: 3 })).isError).toBe(true);
        expect((await assignTask(restarted, { ...taskArgs, attempt: 1 })).isError).toBe(true);
        const expired = port(saved, { now: () => 601001 });
        expect((await assignTask(expired, { ...taskArgs, attempt: 2 })).isError).toBe(true);
        expect(expired.mails).toEqual([]);
        expect(restarted.mails).toEqual([]);
    });

    it('gives dispatch retries a stable identity, and a changed stage a new identity', async () => {
        const p = port({ orchestration: { role: 'hub', workers: [{ sessionId: 'W', by: 'auto', boundAt: 1 }] } } as Metadata);
        const args = { ...contract, sessionId: 'W', id: 'same', goal: 'work', acceptance: 'tests', stage: 'build' };
        await assignTask(p, args);
        await assignTask(p, args);
        await p.updateMetadata(m => ({ ...m, orchestration: { ...m.orchestration!, board: m.orchestration!.board!.map(e => ({ ...e, state: 'done' as const })) } }));
        await assignTask(p, { ...args, stage: 'review' });
        const envelopes = p.mails.map(m => parseEnvelope(m.text));
        expect(envelopes[0]?.fields.dispatch).toBeTruthy();
        expect(envelopes[1]?.fields.dispatch).toBe(envelopes[0]?.fields.dispatch);
        expect(envelopes[2]?.fields.dispatch).not.toBe(envelopes[0]?.fields.dispatch);
        expect(p.metadataNow().orchestration?.board?.[0].dispatchId).toBe(envelopes[2]?.fields.dispatch);
    });

    it('keeps the report retry key across changing transcript tails, but not changed full business content', async () => {
        let tail = 0;
        const p = port({ orchestration: { role: 'worker', hub: { sessionId: 'H', by: 'auto', boundAt: 1 } } } as Metadata, {
            transcript: async () => ({ entries: [{ seq: ++tail, body: { role: 'user', content: { type: 'text', text: 'tail ' + tail } } }] }),
        });
        const args = { id: 'long', status: 'done' as const, summary: 'x'.repeat(13000), verification: 'A', evidence_count: 1 };
        await reportTask(p, args);
        await reportTask(p, args);
        await reportTask(p, { ...args, verification: 'B' });
        const keys = p.mails.map(m => mailIdempotencyKey(p.selfId, m.to, m.text));
        expect(keys[1]).toBe(keys[0]);
        expect(keys[2]).not.toBe(keys[0]);
        // Short summaries exercise the automatic tail too (not hidden by the display limit).
        await reportTask(p, { ...args, summary: 'fixed' });
        await reportTask(p, { ...args, summary: 'fixed' });
        expect(mailIdempotencyKey(p.selfId, 'H', p.mails[3].text)).toBe(mailIdempotencyKey(p.selfId, 'H', p.mails[4].text));
    });

    it('spawns a local worker, binds it and becomes a hub', async () => {
        const p = port({ path: '/repo' } as unknown as Metadata);
        const r = await spawnWorker(p, { duty: '编码', model: 'claude-sonnet-5', effort: 'medium' });
        expect(r.isError).toBe(false);
        expect(p.spawnLocal).toHaveBeenCalledWith(expect.objectContaining({ hubSessionId: 'SELF', title: '【编码】repo', modelMode: 'claude-sonnet-5', directory: '/repo' }));
        expect(p.metadataNow().orchestration).toMatchObject({ role: 'hub', workers: [{ sessionId: 'W9', by: 'auto' }] });
        expect(p.mails[0].text).toContain('worker_default=full');
        expect(p.spawnLocal).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: undefined }));
        expect(workerTitle('【评审】', 'LMC', '/x')).toBe('【评审】LMC');
    });

    it('never authorizes an unconfirmed birth when the hub binding write fails', async () => {
        const p = port({ path: '/repo' } as Metadata);
        p.updateMetadata = async () => { throw new Error('binding rejected'); };
        const result = await spawnWorker(p, { duty: 'coding', model: 'claude-sonnet-5', effort: 'medium' });
        expect(result.isError).toBe(true);
        expect(result.text).toContain('W9');
        expect(p.mails).toEqual([]);
    });

    it('queues a request for a worker on another machine instead of failing', async () => {
        const p = port({ path: '/repo', orchestration: { role: 'hub', workers: [] } } as unknown as Metadata);
        const r = await spawnWorker(p, { ...contract, duty: '回归', machine: 'MacBook', directory: '/Users/x/repo' });
        expect(r.isError).toBe(false);
        expect(p.spawnLocal).not.toHaveBeenCalled();
        const o = p.metadataNow().orchestration;
        expect(o?.role === 'hub' && o.spawnRequests?.[0]).toMatchObject({ machine: 'MacBook', state: 'pending', title: '【回归】repo', agent: 'claude' });
    });

    it('dispatches only to bound workers and counts attempts from the board', async () => {
        const p = port({ orchestration: { role: 'hub', workers: [{ sessionId: 'W1', boundAt: 1, by: 'auto' }], board: [{ id: 't1', title: 'x', state: 'rejected', attempt: 1, counterpart: 'W1', firstAt: 1, updatedAt: 2 }] } } as unknown as Metadata);
        expect((await assignTask(p, { ...contract, sessionId: 'STRANGER', id: 't1', goal: 'g', acceptance: 'a' })).isError).toBe(true);
        const r = await assignTask(p, { ...contract, sessionId: 'W1', id: 't1', goal: 'g', acceptance: 'a', stage: 'build' });
        expect(r.isError).toBe(false);
        expect(p.mails[0].text.startsWith('[task t1 · attempt 2]')).toBe(true);
        expect(p.mails[0].text).toContain('worker_default=full');
        const o = p.metadataNow().orchestration;
        expect(o?.board?.[0]).toMatchObject({ id: 't1', state: 'dispatched', attempt: 2, stage: 'build' });
        expect(nextAttempt(undefined)).toBe(1);
    });

    it('reports to the hub with transcript evidence attached when something needs a look', async () => {
        const p = port({ orchestration: { role: 'worker', hub: { sessionId: 'H', boundAt: 1, by: 'auto' }, board: [{ id: 't1', title: 'x', state: 'dispatched', attempt: 3, counterpart: 'H', firstAt: 1, updatedAt: 2 }] } } as unknown as Metadata);
        const r = await reportTask(p, { id: 't1', status: 'failed', summary: 'still red' });
        expect(r.isError).toBe(false);
        expect(p.mails[0].to).toBe('H');
        expect(p.mails[0].text.startsWith('[report t1 · attempt 3 · failed]')).toBe(true);
        expect(parseEnvelope(p.mails[0].text)?.kind).toBe('report');
        expect(p.mails[0].text).toContain('trace');
        expect(p.mails[0].text).toContain('hello from the worker');
        expect(p.metadataNow().orchestration?.board?.[0].state).toBe('failed');
        expect((await reportTask(port({} as unknown as Metadata), { id: 'x', status: 'done', summary: 's' })).isError).toBe(true);
    });

    it('skips evidence by default on a clean done report, since the hub reads every word', async () => {
        const p = port({ orchestration: { role: 'worker', hub: { sessionId: 'H', boundAt: 1, by: 'auto' }, board: [{ id: 't1', title: 'x', state: 'dispatched', attempt: 1, counterpart: 'H', firstAt: 1, updatedAt: 2 }] } } as unknown as Metadata);
        const r = await reportTask(p, { id: 't1', status: 'done', summary: 'shipped it' });
        expect(r.isError).toBe(false);
        expect(p.mails[0].text).not.toContain('evidence');
        // Still available on request, even for a done report.
        const p2 = port({ orchestration: { role: 'worker', hub: { sessionId: 'H', boundAt: 1, by: 'auto' } } } as unknown as Metadata);
        await reportTask(p2, { id: 't2', status: 'done', summary: 'shipped it', evidence_count: 5 });
        expect(p2.mails[0].text).toContain('trace');
    });

    it.each([
        ['gpt-6-astra', 'high', 'gpt-6-astra · high'],
        ['claude-opus-5', 'xhigh', 'claude-opus-5 · xhigh'],
        ['gpt-6-astra', undefined, 'gpt-6-astra'],
        ['default', 'high', undefined],
        ['default', undefined, undefined],
        [undefined, 'high', undefined],
        [null, null, undefined],
    ])('reports its own model %s and effort %s on the wire and board', async (modelMode, effortLevel, expected) => {
        const p = port({ modelMode, effortLevel, orchestration: { role: 'worker', hub: { sessionId: 'H', boundAt: 1, by: 'auto' } } } as unknown as Metadata);
        const result = await reportTask(p, { id: 'model-task', status: 'done', summary: 'ready' });
        expect(result.isError).toBe(false);
        const report = parseEnvelope(p.mails[0].text);
        if (report?.kind !== 'report') throw new Error('Expected report');
        expect(report.fields.model).toBe(expected);
        expect(p.metadataNow().orchestration?.board?.[0].model).toBe(expected);
        if (!expected) expect(p.mails[0].text).not.toMatch(/^model\s/m);
    });

    it('matches scope as prefixes and globs', () => {
        expect(inScope('packages/lmc-app/sources/a.ts', ['packages/lmc-app/'])).toBe(true);
        expect(inScope('packages/lmc-app/sources/a.ts', ['packages/lmc-app'])).toBe(true);
        expect(inScope('packages/lmc-app/sources/a.ts', ['packages/lmc-app/**/*.ts'])).toBe(true);
        expect(inScope('packages/lmc-cli/src/a.ts', ['packages/lmc-app/**'])).toBe(false);
        expect(inScope('a/b.ts', ['a/*.ts'])).toBe(true);
        expect(inScope('a/c/b.ts', ['a/*.ts'])).toBe(false);
        expect(checksPass({ files: [], outOfScope: [], runs: [{ command: 'x', code: 1, tail: '', spawnFailed: false }], notes: [], unverifiable: [] })).toBe(false);
        expect(checksPass({ files: [], outOfScope: [], runs: [], notes: [], unverifiable: ['branch not found'] })).toBe(false);
    });
});

describe('review base', () => {
    it('diffs a reused branch from where the last accepted task left it', async () => {
        const { execSync } = await import('node:child_process');
        const { mkdtempSync, writeFileSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const repo = mkdtempSync(join(tmpdir(), 'lmc-review-'));
        const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: repo, stdio: 'pipe' }).toString().trim();
        git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
        writeFileSync(join(repo, 'a.txt'), 'a'); git('add .'); git('commit -q -m base');
        git('checkout -q -b task/x'); writeFileSync(join(repo, 'first.md'), '1'); git('add .'); git('commit -q -m first');
        const firstSha = git('rev-parse HEAD');
        writeFileSync(join(repo, 'second.md'), '2'); git('add .'); git('commit -q -m second');
        git('checkout -q main');
        const { runReviewChecks } = await import('./tools');
        const fromMergeBase = await runReviewChecks(repo, { id: 't', branch: 'task/x', scope: ['second.md'] }, null);
        expect(fromMergeBase.outOfScope).toEqual(['first.md']);
        const fromPrevious = await runReviewChecks(repo, { id: 't', branch: 'task/x', scope: ['second.md'] }, null, firstSha);
        expect(fromPrevious.files).toEqual(['second.md']);
        expect(fromPrevious.outOfScope).toEqual([]);
        expect(fromPrevious.tip).toBe(git('rev-parse task/x'));
    });
});

describe('reviewReport verdicts', () => {
    it.each(['review', 'deploy'] as const)('%s without branch or run requires a verdict and skips all execution', async (stage) => {
        const { reviewReport } = await import('./tools');
        const p = port({ orchestration: { role: 'hub', workers: [], board: [{ id: 't1', stage, title: 'x', state: 'done', attempt: 1, counterpart: 'W1', scope: 'only-this-file', firstAt: 1, updatedAt: 2 }] } } as unknown as Metadata);
        const execution = vi.mocked(childProcess.execFile);
        execution.mockClear();
        try {
            const missing = await reviewReport(p, { id: 't1' });
            expect(missing.isError).toBe(true);
            expect(missing.text).toContain('A review or deploy task needs run commands or an explicit verdict when no branch is given');
            expect(p.metadataNow().orchestration?.board?.[0].state).toBe('done');
            expect(p.mails).toHaveLength(0);
            const accepted = await reviewReport(p, { id: 't1', verdict: 'accepted' });
            expect(accepted.isError).toBe(false);
            expect(accepted.text).not.toMatch(/file\(s\)|out of scope|checks passed/);
            expect(p.metadataNow().orchestration?.board?.[0].state).toBe('accepted');
            expect(execution).not.toHaveBeenCalled();
        } finally {
            execution.mockClear();
        }
    });

    it.each(['review', 'deploy'] as const)('%s executes passing run commands without scanning git or scope', async (stage) => {
        const { reviewReport } = await import('./tools');
        const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const repo = mkdtempSync(join(tmpdir(), 'lmc-review-runs-'));
        const p = port({ orchestration: { role: 'hub', workers: [], board: [{ id: 't1', stage, title: 'x', state: 'done', attempt: 1, scope: 'unrelated', firstAt: 1, updatedAt: 2 }] } } as unknown as Metadata);
        vi.mocked(childProcess.execFile).mockClear();
        try {
            writeFileSync(join(repo, 'proof'), 'present');
            const result = await reviewReport(p, { id: 't1', repo, run: ['test -f proof', 'exit 0'] });
            expect(result.text).toContain('accepted');
            expect(result.text).toContain('$ test -f proof → exit 0');
            expect(result.text).not.toMatch(/file\(s\)|out of scope|git checkout/);
            expect(p.metadataNow().orchestration?.board?.[0].state).toBe('accepted');
            expect(childProcess.execFile).toHaveBeenCalledTimes(2);
            expect(vi.mocked(childProcess.execFile).mock.calls.every(call => call[0] === '/bin/sh')).toBe(true);
        } finally { rmSync(repo, { recursive: true, force: true }); }
    });

    it.each(['review', 'deploy'] as const)('%s rejects a failing run and includes its output tail', async (stage) => {
        const { reviewReport } = await import('./tools');
        const { tmpdir } = await import('node:os');
        const p = port({ orchestration: { role: 'hub', workers: [], board: [{ id: 't1', stage, title: 'x', state: 'done', attempt: 1, firstAt: 1, updatedAt: 2 }] } } as unknown as Metadata, { cwd: tmpdir() });
        const result = await reviewReport(p, { id: 't1', run: ['exit 0', 'echo deployment-check-failed; exit 7'] });
        expect(result.isError).toBe(false);
        expect(result.text).toContain('rejected');
        expect(result.text).toContain('→ exit 7\ndeployment-check-failed');
        expect(p.metadataNow().orchestration?.board?.[0].state).toBe('rejected');
    });

    it('warns that a build review without branch scans the shared working tree', async () => {
        const { reviewReport } = await import('./tools');
        const { mkdtempSync, rmSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const repo = mkdtempSync(join(tmpdir(), 'lmc-build-review-'));
        try {
            childProcess.execFileSync('git', ['init', '-q'], { cwd: repo });
            childProcess.execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'base'], { cwd: repo });
            const p = port({ orchestration: { role: 'hub', workers: [], board: [{ id: 't1', stage: 'build', title: 'x', state: 'done', attempt: 1, firstAt: 1, updatedAt: 2 }] } } as unknown as Metadata, { cwd: repo });
            const result = await reviewReport(p, { id: 't1' });
            expect(result.text).toContain("no branch: scanned the working tree, which may include other in-flight tasks' edits");
            expect(result.text).toContain('working tree here: 0 file(s)');
        } finally {
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it('cannot silently pass when the branch is not found: verdict rejected, text says unverifiable', async () => {
        const { execSync } = await import('node:child_process');
        const { mkdtempSync, writeFileSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const repo = mkdtempSync(join(tmpdir(), 'lmc-review-'));
        const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: repo, stdio: 'pipe' }).toString().trim();
        git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
        writeFileSync(join(repo, 'a.txt'), 'a'); git('add .'); git('commit -q -m base');
        const { reviewReport } = await import('./tools');
        const p = port({ orchestration: { role: 'hub', workers: [{ sessionId: 'W1', boundAt: 1, by: 'auto' }], board: [{ id: 't1', title: 'x', state: 'done', attempt: 1, counterpart: 'W1', firstAt: 1, updatedAt: 2 }] } } as unknown as Metadata, { cwd: repo });
        const r = await reviewReport(p, { id: 't1', branch: 'no-such-branch' });
        expect(r.isError).toBe(false);
        expect(r.text).toContain('无法验证');
        expect(p.metadataNow().orchestration?.board?.[0].state).toBe('rejected');
    });

    it('refuses with no verdict recorded when cwd is not a git checkout and a branch was asked for', async () => {
        const { mkdtempSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const notARepo = mkdtempSync(join(tmpdir(), 'lmc-not-a-repo-'));
        const { reviewReport } = await import('./tools');
        const p = port({ orchestration: { role: 'hub', workers: [{ sessionId: 'W1', boundAt: 1, by: 'auto' }], board: [{ id: 't1', title: 'x', state: 'done', attempt: 1, counterpart: 'W1', firstAt: 1, updatedAt: 2 }] } } as unknown as Metadata, { cwd: notARepo });
        const r = await reviewReport(p, { id: 't1', branch: 'task/x' });
        expect(r.isError).toBe(true);
        expect(r.text).toContain('repo');
        // No git command ran and no verdict landed on the board.
        expect(p.metadataNow().orchestration?.board?.[0].state).toBe('done');
        expect(p.mails.length).toBe(0);
    });
});

describe('standing team', () => {
    it('refuses to hire a second worker of a duty that is already alive', async () => {
        const { spawnWorker } = await import('./tools');
        const p = port({ orchestration: { role: 'hub', workers: [{ sessionId: 'W1', boundAt: 1, by: 'auto' }] } } as unknown as Metadata, { listPeers: async () => [{ sessionId: 'W1', title: '【编码】repo' }, { sessionId: 'X', title: '【编码】other hub\'s' }] });
        const refused = await spawnWorker(p, { duty: '编码', model: 'claude-sonnet-5', effort: 'medium' });
        expect(refused.isError).toBe(true);
        expect(refused.text).toContain('W1');
        expect(p.spawnLocal).not.toHaveBeenCalled();
        expect((await spawnWorker(p, { duty: '评审', model: 'claude-sonnet-5', effort: 'medium' })).isError).toBe(false);
        expect((await spawnWorker(p, { duty: '编码', force: true, model: 'claude-sonnet-5', effort: 'medium' })).isError).toBe(false);
    });
});
