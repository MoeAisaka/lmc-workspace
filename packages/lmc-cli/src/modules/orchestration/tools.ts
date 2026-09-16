import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { BoardEntry, Metadata, SpawnRequest } from '@/api/types';
import type { TranscriptEntry } from '@/utils/sessionTranscript';
import type { TaskMeter } from './meter';
import { renderTranscript } from '@/utils/sessionTranscript';
import { ENVELOPE_LIMITS, formatReportEnvelope, formatReviewEnvelope, formatTaskEnvelope, parseEnvelope, type ReportStatus, type ReviewStatus, type TaskEnvelope } from './envelope';
import { boardUpdate, boardOf } from './board';
import { relationTo } from './roles';
import { formatConfigMail, hasConfig, type WorkerConfig } from './workerConfig';

/**
 * The hub-and-workers tools, behind a port so they can run in either engine's
 * runner and be tested without one.
 *
 * What a runner can and cannot do shapes these: it holds its own session key
 * and the account token, not the account's secret. So it can write its own
 * metadata and mail any session, but it cannot read another session's
 * transcript (the worker's evidence therefore travels inside the report) and
 * it cannot call another machine's daemon (a remote spawn is a request the
 * app fulfils). Same-machine spawns go through the daemon's local socket.
 */
export interface SpawnLocalOptions {
    directory: string;
    agent: 'claude' | 'codex';
    modelMode?: string;
    effortLevel?: string;
    permissionMode?: string;
    hubSessionId: string;
    title: string;
}
export interface OrchestrationPort {
    selfId: string;
    metadata: () => Metadata | null;
    updateMetadata: (update: (metadata: Metadata) => Metadata) => Promise<void>;
    /** Working directory of this session, the default place for workers. */
    cwd: string;
    machineId: string;
    /** How this machine is named in list_sessions, so `machine` can match either. */
    machineName: () => string;
    spawnLocal: (options: SpawnLocalOptions) => Promise<{ success: boolean; sessionId?: string; error?: string }>;
    sendMail: (sessionId: string, text: string) => Promise<{ ok: true } | { ok: false; error: string }>;
    transcript: (opts: { limit: number }) => Promise<{ entries: TranscriptEntry[] }>;
    /** The live sessions on the account, to tell a standing worker from a dead one. */
    listPeers?: () => Promise<{ sessionId: string; title: string }[]>;
    /** Turn-by-turn usage, so a report can say what the task cost. */
    meter?: TaskMeter;
    now?: () => number;
}

export type ToolResult = { text: string; isError: boolean };
const ok = (text: string): ToolResult => ({ text, isError: false });
const fail = (text: string): ToolResult => ({ text, isError: true });

const entryOf = (metadata: Metadata | null, id: string): BoardEntry | undefined => boardOf(metadata?.orchestration ?? undefined).find((e) => e.id === id);

async function recordOnBoard(port: OrchestrationPort, text: string, counterpart: string | null): Promise<void> {
    const update = boardUpdate(text, counterpart, port.now?.() ?? Date.now());
    if (update) await port.updateMetadata(update);
}

// ---------------------------------------------------------------- spawn_worker

export interface SpawnWorkerArgs {
    duty: string; name?: string; directory?: string; agent?: 'claude' | 'codex'; model?: string; effort?: string; permission_mode?: string; machine?: string; force?: boolean;
}

/** The hub's live workers whose title carries this duty. */
export async function standingWorkers(port: OrchestrationPort, duty: string): Promise<{ sessionId: string; title: string }[]> {
    const orchestration = port.metadata()?.orchestration;
    if (orchestration?.role !== 'hub' || !port.listPeers) return [];
    const clean = duty.replace(/^【|】$/g, '').trim();
    const mine = new Set(orchestration.workers.map((w) => w.sessionId));
    try {
        return (await port.listPeers()).filter((p) => mine.has(p.sessionId) && p.title.startsWith(`【${clean}】`));
    } catch {
        return [];
    }
}

export function workerTitle(duty: string, name: string | undefined, directory: string): string {
    const clean = duty.replace(/^【|】$/g, '').trim();
    return `【${clean}】${(name ?? basename(directory)).trim()}`.slice(0, 120);
}

export async function spawnWorker(port: OrchestrationPort, args: SpawnWorkerArgs): Promise<ToolResult> {
    if (!args.model || /\s|·/.test(args.model) || args.model === 'default' || !args.effort || /\s|·/.test(args.effort)) return fail('DIRECT is the default. Delegation requires an explicit model and effort; no inherited model.');
    const metadata = port.metadata();
    if (metadata?.orchestration?.role === 'worker') return fail('You are a worker, not a hub; workers do not start workers. Ask your hub.');
    // A standing team, not a worker per task: with a live worker of this duty
    // the answer is to assign, not to hire.
    if (!args.force) {
        const existing = await standingWorkers(port, args.duty);
        if (existing.length) {
            return fail(`You already have a live 【${args.duty.replace(/^【|】$/g, '').trim()}】 worker: ${existing.map((w) => `${w.sessionId} (${w.title})`).join(', ')}. Reuse it — assign_task to it, or configure_worker to change its model or effort. Workers are a standing team; start another only if this one is out of quota or must run on a different machine, and then pass force: true.`);
        }
    }
    const directory = args.directory?.trim() || port.cwd;
    const agent = args.agent ?? 'claude';
    const title = workerTitle(args.duty, args.name, directory);
    const machine = args.machine?.trim();
    const isLocal = !machine || machine === port.machineId || machine.toLowerCase() === port.machineName().toLowerCase();
    // Becoming a hub by hiring: a session that starts a worker is one.
    const becomeHub = (m: Metadata): Metadata => m.orchestration?.role === 'hub' ? m : { ...m, orchestration: { role: 'hub', workers: [] } };

    if (isLocal) {
        const result = await port.spawnLocal({ directory, agent, modelMode: args.model, effortLevel: args.effort, permissionMode: args.permission_mode, hubSessionId: port.selfId, title });
        if (!result.success || !result.sessionId) return fail(`Could not start the worker: ${result.error ?? 'the daemon gave no session id'}.`);
        const sessionId = result.sessionId;
        const boundAt = port.now?.() ?? Date.now();
        try { await port.updateMetadata((m) => {
            const hub = becomeHub(m);
            const o = hub.orchestration!;
            if (o.role !== 'hub') return hub;
            return { ...hub, orchestration: { ...o, workers: [...o.workers.filter((w) => w.sessionId !== sessionId), { sessionId, boundAt, by: 'auto' as const }] } };
        }); } catch {
            return fail(`Worker ${sessionId} was started, but its hub binding was not confirmed. No default permission grant was sent. Preserve this SID; do not repeat spawn_worker to recover the binding.`);
        }
        const configured = await port.sendMail(sessionId, formatConfigMail(sessionId, { workerDefault: true }));
        if (!configured.ok) return fail(`Worker ${sessionId} is bound, but its default permission notice was not delivered. Reuse this SID with assign_task; do not spawn a replacement.`);
        return ok(`Worker ${sessionId} started on this machine as ${title} (${agent}${args.model ? ` · ${args.model}` : ''}) in ${directory}, and bound to you. Give it a moment to come up, then dispatch with assign_task.`);
    }

    const request: SpawnRequest = {
        id: randomUUID().slice(0, 8), machine, directory, agent, model: args.model, effort: args.effort, permissionMode: args.permission_mode, title,
        requestedAt: port.now?.() ?? Date.now(), state: 'pending',
    };
    await port.updateMetadata((m) => {
        const hub = becomeHub(m);
        const o = hub.orchestration!;
        if (o.role !== 'hub') return hub;
        const rest = (o.spawnRequests ?? []).filter((r) => r.state === 'pending' || r.state === 'claimed' || (r.requestedAt > request.requestedAt - 24 * 3600_000)).slice(-19);
        return { ...hub, orchestration: { ...o, spawnRequests: [...rest, request] } };
    });
    return ok(`Requested a worker on machine "${machine}" as ${title} (request ${request.id}). This machine cannot reach that one directly: an app on the account will start it and bind it to you, then you will receive a message with the worker's id. Continue with other work; do not repeat the request.`);
}

// ---------------------------------------------------------------- assign_task

export interface AssignTaskArgs {
    budget_minutes?: number;
    dispatch_id?: string;
    sessionId: string; id: string; attempt?: number; stage?: string; goal: string; scope?: string; acceptance: string; constraints?: string; deliver?: string; run?: string;
    model?: string; effort?: string; permission_mode?: string;
}

export function nextAttempt(existing: BoardEntry | undefined): number {
    if (!existing) return 1;
    return existing.state === 'rejected' || existing.state === 'failed' || existing.state === 'blocked' ? existing.attempt + 1 : existing.attempt;
}

export async function assignTask(port: OrchestrationPort, args: AssignTaskArgs): Promise<ToolResult> {
    for (const field of ['model', 'effort', 'scope', 'goal', 'acceptance'] as const) {
        if (!args[field]?.trim()) return fail(`Delegation requires explicit ${field}. Continue DIRECT until the execution contract is ready.`);
    }
    if (args.model === 'default' || /\s|·/.test(args.model!) || /\s|·/.test(args.effort!) || !Number.isSafeInteger(args.budget_minutes) || args.budget_minutes! <= 0 || args.budget_minutes! > 1440) {
        return fail('Specify a non-default model and budget_minutes (integer 1–1440). Budget bounds future dispatch, not active processes or subscription quota.');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(args.id)) return fail('Invalid stable task id.');
    const metadata = port.metadata();
    if (relationTo(metadata?.orchestration, args.sessionId) !== 'worker') {
        return fail(`${args.sessionId} is not one of your workers. Bind it first (spawn_worker, or your user binds it in the app), or check list_sessions for the [your worker] mark.`);
    }
    const previous = metadata?.delegationLedger?.[args.id];
    const boardEntry = entryOf(metadata, args.id);
    const state = boardEntry && boardEntry.attempt === previous?.attempt && boardEntry.dispatchId === previous?.dispatch ? boardEntry.state : previous?.state;
    const attempt = args.attempt ?? (previous
        ? (['rejected', 'failed', 'blocked'].includes(state!) ? previous.attempt + 1 : previous.attempt)
        : nextAttempt(boardEntry));
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > 2) return fail('Delegation exhausted: at most one return (two attempts). Preserve work and let the hub take over DIRECT.');
    // Model and effort ride in the run line as directives; the worker's runner
    // applies them when it delivers the task.
    const directives = [args.model && `model=${args.model}`, args.effort && `effort=${args.effort}`, args.permission_mode && `permission=${args.permission_mode}`].filter(Boolean).join(' ');
    const run = [args.run?.trim(), directives, 'worker_default=full'].filter(Boolean).join(' · ');
    const task: Omit<TaskEnvelope, 'kind'> = { id: args.id, attempt, fields: { stage: args.stage, goal: args.goal, scope: args.scope, acceptance: args.acceptance, constraints: args.constraints, deliver: args.deliver, run } };
    // Stable for a retry, new for a changed phase/spec. An explicit dispatch ID
    // permits intentionally repeating an otherwise identical assignment.
    task.fields.dispatch = createHash('sha256').update(JSON.stringify([args.dispatch_id ?? null, task])).digest('hex');
    // Persist the reservation before mail. Strict CAS re-runs these checks on
    // the latest metadata; unknown delivery can retry only the same identity.
    try {
        await port.updateMetadata(m => {
            if (relationTo(m.orchestration, args.sessionId) !== 'worker') throw new Error('Worker binding changed.');
            const ledger = m.delegationLedger ?? {};
            const old = ledger[args.id];
            const row = entryOf(m, args.id);
            const lastAttempt = Math.max(old?.attempt ?? 0, row?.attempt ?? 0);
            const lastState = row && row.attempt === lastAttempt && (!old || row.dispatchId === old.dispatch) ? row.state : old?.state;
            const retry = ['rejected', 'failed', 'blocked'].includes(lastState ?? '');
            const expected = lastAttempt ? lastAttempt + (retry ? 1 : 0) : 1;
            if (attempt !== expected || expected > 2) throw new Error('Attempt cannot reset or skip; after one return the hub must take over DIRECT.');
            if ((old?.worker ?? row?.counterpart ?? args.sessionId) !== args.sessionId) throw new Error('One task has one worker. Hub takeover required; do not replace the executor.');
            if (old && old.budgetMinutes !== args.budget_minutes) throw new Error('The original task budget cannot be extended on retry.');
            if (!old && Object.keys(ledger).length >= 256) throw new Error('Delegation ledger full; continue DIRECT. Limits are not silently evicted.');
            const now = port.now?.() ?? Date.now();
            const deadline = old?.deadline ?? now + args.budget_minutes! * 60000;
            if (now >= deadline) throw new Error('Task budget expired; preserve work and continue DIRECT. No active process is stopped.');
            if (old && attempt === old.attempt && old.dispatch !== task.fields.dispatch
                && !['done', 'accepted'].includes(lastState ?? '')) throw new Error('A different assignment is already pending for this task. Do not start duplicate work.');
            return { ...m, delegationLedger: { ...ledger, [args.id]: {
                worker: args.sessionId, attempt, deadline, budgetMinutes: args.budget_minutes!, dispatch: task.fields.dispatch!,
                state: old?.dispatch === task.fields.dispatch && old.attempt === attempt ? (lastState ?? old.state) : 'dispatched',
            } } };
        });
    } catch (error) { return fail(error instanceof Error ? error.message : 'Could not reserve delegation; no task sent.'); }
    const reservation = port.metadata()?.delegationLedger?.[args.id];
    if (!reservation || reservation.dispatch !== task.fields.dispatch) return fail('Reservation not confirmed; no task sent.');
    task.fields.budget = `${args.budget_minutes! * 60000} ms total; deadline=${reservation.deadline}; one return maximum; report once at a safe boundary, never kill active work.`;
    const text = formatTaskEnvelope(task);
    const sent = await port.sendMail(args.sessionId, text);
    if (!sent.ok) return fail(`Could not deliver the task: ${sent.error}`);
    await recordOnBoard(port, text, args.sessionId);
    return ok(`Task ${args.id} (attempt ${attempt}) dispatched to ${args.sessionId} and recorded on the board. The worker's report will arrive as [from your worker …] mail; review it with review_report.`);
}

// ---------------------------------------------------------------- configure_worker

export interface ConfigureWorkerArgs { sessionId: string; model?: string; effort?: string; permission_mode?: string }

export async function configureWorker(port: OrchestrationPort, args: ConfigureWorkerArgs): Promise<ToolResult> {
    if (relationTo(port.metadata()?.orchestration, args.sessionId) !== 'worker') return fail(`${args.sessionId} is not one of your workers.`);
    const config: WorkerConfig = { model: args.model, effort: args.effort, permissionMode: args.permission_mode };
    if (!hasConfig(config)) return fail('Nothing to change: give a model, an effort, or a permission mode.');
    const sent = await port.sendMail(args.sessionId, formatConfigMail(args.sessionId, config));
    if (!sent.ok) return fail(`Could not reach the worker: ${sent.error}`);
    return ok(`Configuration delivered to worker ${args.sessionId}: ${[config.model && `model ${config.model}`, config.effort && `effort ${config.effort}`, config.permissionMode && `permission ${config.permissionMode}`].filter(Boolean).join(', ')}. Delivery is not provider confirmation. No acknowledgement turn is needed; runtime failures are reported separately.`);
}

// ---------------------------------------------------------------- report_task

export interface ReportTaskArgs {
    id: string; attempt?: number; dispatch_id?: string; status: ReportStatus; summary: string; changes?: string; verification?: string; questions?: string; blocked?: string; evidence?: string; evidence_count?: number;
}

export async function reportTask(port: OrchestrationPort, args: ReportTaskArgs): Promise<ToolResult> {
    const metadata = port.metadata();
    const orchestration = metadata?.orchestration;
    if (orchestration?.role !== 'worker') return fail('You have no hub to report to. This session is not bound as a worker; if a person gave you the task, answer them directly.');
    const hubId = orchestration.hub.sessionId;
    const entry = entryOf(metadata, args.id);
    const attempt = args.attempt ?? entry?.attempt ?? 1;
    // Cost since this attempt was dispatched: the board's updatedAt moved when the task arrived.
    const cost = entry && port.meter ? port.meter.since(entry.updatedAt) ?? undefined : undefined;
    const model = metadata?.modelMode && metadata.modelMode !== 'default' ? [metadata.modelMode, metadata.effortLevel].filter(Boolean).join(' · ') : undefined;
    const status: ReportStatus = args.blocked && args.status === 'done' ? 'blocked' : args.status;
    // The hub is the expensive model and reads every word of a report: a clean
    // 'done' costs it nothing to skip by default. blocked/failed is where the
    // hub actually needs to look, so evidence attaches unless told otherwise.
    const count = args.evidence_count ?? (status === 'done' ? 0 : 12);
    let evidence: string | undefined;
    if (count > 0) {
        try {
            const page = await port.transcript({ limit: count });
            const rendered = renderTranscript(page.entries, ENVELOPE_LIMITS.evidence);
            if (rendered.text) evidence = rendered.text;
        } catch {
            // Evidence is a courtesy to the reviewer; the report still goes.
        }
    }
    const business = { summary: args.summary, changes: args.changes, verification: args.verification, questions: args.questions, blocked: args.blocked, evidence: args.evidence };
    const digest = createHash('sha256').update(JSON.stringify(business)).digest('hex');
    const text = formatReportEnvelope({ id: args.id, attempt, status, fields: {
        dispatch: args.dispatch_id ?? entry?.dispatchId, digest, ...business, cost, model, trace: evidence,
    } });
    const sent = await port.sendMail(hubId, text);
    if (!sent.ok) return fail(`Could not deliver the report to your hub: ${sent.error}`);
    await recordOnBoard(port, text, hubId);
    return ok(`Report for ${args.id} (attempt ${attempt}, ${status}) delivered to your hub${evidence ? ' with transcript evidence attached' : ''}. Wait for its verdict or its next task; do not start further work on this task unasked.`);
}

// ---------------------------------------------------------------- review_report

export interface ReviewReportArgs {
    id: string; branch?: string; base?: string; repo?: string; scope?: string[]; run?: string[]; verdict?: ReviewStatus; reasons?: string;
}

/** A path matches a scope entry: a directory prefix, an exact path, or a glob with * and **. */
export function inScope(file: string, scope: string[]): boolean {
    return scope.some((raw) => {
        const pattern = raw.trim().replace(/^\.\//, '');
        if (!pattern) return false;
        if (pattern.endsWith('/')) return file.startsWith(pattern);
        if (!pattern.includes('*')) return file === pattern || file.startsWith(pattern + '/');
        const re = new RegExp('^' + pattern.split('**').map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*') + '$');
        return re.test(file);
    });
}

const sh = (cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; out: string; spawnFailed: boolean }> => new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
        const errCode = error ? (error as NodeJS.ErrnoException & { code?: number | string }).code : undefined;
        const numericCode = typeof errCode === 'number' ? errCode : undefined;
        // A spawn-level failure (bad binary, EACCES, killed by timeout/signal)
        // has no exit code of its own — the command never really ran, which is
        // a different, worse fact than "ran and exited non-zero".
        const spawnFailed = !!error && numericCode === undefined;
        resolve({ code: numericCode ?? (error ? 1 : 0), out: `${stdout ?? ''}${stderr ?? ''}`, spawnFailed });
    });
});
const tail = (text: string, lines = 40, chars = 2500) => text.trim().split('\n').slice(-lines).join('\n').slice(-chars);

async function isGitRepo(cwd: string): Promise<boolean> {
    return (await sh('git', ['rev-parse', '--is-inside-work-tree'], cwd, 15_000)).code === 0;
}

export interface ReviewChecks {
    /** The commit the branch stood at when checked, when a branch was given. */
    tip?: string;
    /** What the diff was taken from. */
    base?: string;
    files: string[];
    outOfScope: string[];
    runs: { command: string; code: number; tail: string; spawnFailed: boolean }[];
    notes: string[];
    /** Reasons an automatic pass cannot be trusted here — forces the verdict to rejected unless the hub gives one itself. */
    unverifiable: string[];
}

export async function runReviewChecks(cwd: string, args: ReviewReportArgs, taskScope: string[] | null, defaultBase: string | null = null, skipFileChecks = false): Promise<ReviewChecks> {
    const checks: ReviewChecks = { files: [], outOfScope: [], runs: [], notes: [], unverifiable: [] };
    let workDir = cwd;
    let worktree: string | null = null;
    let skipRuns = false;
    try {
        if (!skipFileChecks) {
            if (args.branch) {
                const fetched = await sh('git', ['fetch', '--all', '--prune', '--quiet'], cwd, 180_000);
                if (fetched.code !== 0) checks.notes.push(`fetch: ${tail(fetched.out, 3, 300)}`);
                const ref = (await sh('git', ['rev-parse', '--verify', '--quiet', args.branch], cwd, 20_000)).code === 0 ? args.branch
                    : (await sh('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/${args.branch}`], cwd, 20_000)).code === 0 ? `refs/remotes/${args.branch}`
                    : null;
                const remoteRef = ref ?? (await (async () => {
                    const remotes = (await sh('git', ['remote'], cwd, 20_000)).out.trim().split('\n').filter(Boolean);
                    for (const remote of remotes) if ((await sh('git', ['rev-parse', '--verify', '--quiet', `${remote}/${args.branch}`], cwd, 20_000)).code === 0) return `${remote}/${args.branch}`;
                    return null;
                })());
                if (!remoteRef) {
                    const msg = `branch ${args.branch} not found locally or on any remote`;
                    checks.notes.push(msg);
                    checks.unverifiable.push(msg);
                    return checks;
                }
                // A branch that carried an earlier accepted task is diffed from
                // where that task left it, not from the merge-base — otherwise the
                // earlier task's files show up out of scope for this one.
                const base = args.base ?? defaultBase ?? (await sh('git', ['merge-base', 'HEAD', remoteRef], cwd, 20_000)).out.trim();
                checks.base = base;
                checks.tip = (await sh('git', ['rev-parse', remoteRef], cwd, 20_000)).out.trim() || undefined;
                const diff = await sh('git', ['diff', '--name-only', `${base}...${remoteRef}`], cwd, 60_000);
                checks.files = diff.out.trim().split('\n').filter(Boolean);
                checks.notes.push(`${remoteRef} @ ${(checks.tip ?? '').slice(0, 10)} vs ${base.slice(0, 10)}: ${checks.files.length} file(s)`);
                if (args.run?.length) {
                    worktree = await mkdtemp(join(tmpdir(), 'lmc-review-'));
                    const added = await sh('git', ['worktree', 'add', '--detach', worktree, remoteRef], cwd, 120_000);
                    if (added.code !== 0) {
                        // The run commands would otherwise execute against cwd's own
                        // checkout, silently checking the wrong code — skip them
                        // entirely rather than report a pass that proves nothing.
                        const msg = `worktree for ${remoteRef} failed: run checks skipped`;
                        checks.notes.push(msg);
                        checks.unverifiable.push(msg);
                        await rm(worktree, { recursive: true, force: true });
                        worktree = null;
                        skipRuns = true;
                    } else workDir = worktree;
                }
            } else if (await isGitRepo(cwd)) {
                const diff = await sh('git', ['diff', '--name-only', 'HEAD'], cwd, 60_000);
                const untracked = await sh('git', ['ls-files', '--others', '--exclude-standard'], cwd, 60_000);
                checks.files = [...diff.out.trim().split('\n'), ...untracked.out.trim().split('\n')].filter(Boolean);
                checks.notes.push(`working tree here: ${checks.files.length} file(s)`);
            } else {
                // A review/deploy task whose work never touched a git checkout at
                // all: nothing to diff, so nothing here says the scope was kept.
                checks.notes.push(`not a git checkout at ${cwd}: skipping file/scope checks`);
                if (!args.run?.length) checks.unverifiable.push('no git checkout and no run commands: nothing to verify automatically');
            }
            const scope = args.scope?.length ? args.scope : taskScope;
            if (scope?.length) checks.outOfScope = checks.files.filter((f) => !inScope(f, scope));
            else if (checks.files.length) checks.notes.push('no scope on record: scope not checked');
        }
        if (!skipRuns) {
            for (const command of args.run ?? []) {
                const result = await sh('/bin/sh', ['-lc', command], workDir, 600_000);
                checks.runs.push({ command, code: result.code, tail: tail(result.out, 3, 400), spawnFailed: result.spawnFailed });
                if (result.spawnFailed) checks.unverifiable.push(`could not execute: ${command}`);
            }
        }
    } finally {
        if (worktree) {
            await sh('git', ['worktree', 'remove', '--force', worktree], cwd, 60_000);
            await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
        }
    }
    return checks;
}

export function checksPass(checks: ReviewChecks): boolean {
    return checks.unverifiable.length === 0 && checks.outOfScope.length === 0 && checks.runs.every((r) => r.code === 0);
}

export async function reviewReport(port: OrchestrationPort, args: ReviewReportArgs): Promise<ToolResult> {
    const metadata = port.metadata();
    if (metadata?.orchestration?.role !== 'hub') return fail('Only a hub reviews reports. This session is not a hub.');
    const entry = entryOf(metadata, args.id);
    if (!entry) return fail(`No task ${args.id} on the board. Dispatch it with assign_task first, or check the id.`);
    if (entry.state === 'dispatched') return fail(`Task ${args.id} has no report yet (attempt ${entry.attempt} is still dispatched). Wait for the worker's [report …].`);
    if (args.verdict === 'rejected' && !args.reasons?.trim()) return fail('A rejection needs reasons: the worker has to know what to change.');
    const skipFileChecks = !args.branch && (entry.stage === 'review' || entry.stage === 'deploy');
    const verdictOnly = skipFileChecks && !args.run?.length;
    if (verdictOnly && !args.verdict) return fail('A review or deploy task needs run commands or an explicit verdict when no branch is given');
    const repoDir = args.repo?.trim() || port.cwd;
    // A branch review needs a real checkout to fetch and diff against — with
    // none here, fail loudly with no verdict rather than run git commands
    // that can only report a false "not found".
    if (args.branch && !(await isGitRepo(repoDir))) {
        return fail(`${repoDir} is not a git checkout; pass repo pointing at it (e.g. repo: "/path/to/the/repo") so ${args.branch} can be fetched and diffed.`);
    }
    // The last accepted task on the same branch says where this one's changes begin.
    const previous = args.branch ? boardOf(metadata.orchestration).find((e) => e.id !== args.id && e.branch === args.branch && e.state === 'accepted' && !!e.sha) : undefined;
    const checks: ReviewChecks = verdictOnly
        ? { files: [], outOfScope: [], runs: [], notes: [], unverifiable: [] }
        : await runReviewChecks(repoDir, args, entry.scope ? entry.scope.split('\n').map((s) => s.trim()).filter(Boolean) : null, previous?.sha ?? null, skipFileChecks);
    const automatic = checksPass(checks);
    const verdict: ReviewStatus = args.verdict ?? (automatic ? 'accepted' : 'rejected');
    const assessment = verdictOnly ? "by the hub's judgement; automatic checks skipped"
        : `${automatic ? 'checks passed' : 'checks failed'}${args.verdict ? ', by the hub\'s judgement' : ''}`;
    const lines: string[] = [...checks.notes];
    if (entry.stage === 'build' && !args.branch) lines.push("no branch: scanned the working tree, which may include other in-flight tasks' edits");
    if (checks.outOfScope.length) lines.push(`out of scope: ${checks.outOfScope.slice(0, 5).join(', ')}${checks.outOfScope.length > 5 ? ` +${checks.outOfScope.length - 5} more` : ''}`);
    for (const run of checks.runs) lines.push(`$ ${run.command} → exit ${run.code}${run.code !== 0 && run.tail ? `\n${run.tail}` : ''}`);
    const reasons = [args.reasons?.trim(), ...lines].filter(Boolean).join('\n');
    const text = formatReviewEnvelope({ id: args.id, attempt: entry.attempt, status: verdict, fields: { dispatch: entry.dispatchId, summary: `${verdict} (${assessment})`, reasons } });
    if (entry.counterpart) {
        const sent = await port.sendMail(entry.counterpart, text);
        if (!sent.ok) lines.push(`(the worker could not be told: ${sent.error})`);
    }
    await recordOnBoard(port, text, entry.counterpart);
    if (args.branch && checks.tip) {
        const branch = args.branch; const sha = checks.tip;
        await port.updateMetadata((m) => {
            const o = m.orchestration; if (!o) return m;
            return { ...m, orchestration: { ...o, board: boardOf(o).map((e) => (e.id === args.id ? { ...e, branch, sha } : e)) } };
        }).catch(() => undefined);
    }
    const next = verdict === 'accepted'
        ? 'Closed.'
        : entry.attempt >= 2
                ? 'One return exhausted. Preserve work; hub takes over DIRECT. Do not replace the worker or reset the task ID.'
                : `assign_task attempt ${entry.attempt + 1} with these reasons.`;
    // Unverifiable and no explicit verdict: the headline says so up front,
    // rather than reading like an ordinary rejection with unrelated notes.
    const headline = checks.unverifiable.length && !args.verdict
        ? `无法验证 — ${checks.unverifiable[0]}${checks.unverifiable.length > 1 ? ` (+${checks.unverifiable.length - 1} more)` : ''}`
        : `${verdict} ${args.id} attempt ${entry.attempt} (${assessment})`;
    return ok([headline, ...lines, next].join('\n'));
}
