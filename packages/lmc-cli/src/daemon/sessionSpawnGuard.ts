import type { TrackedSession } from './types';

/**
 * A LMC session must have exactly one CLI process behind it.
 *
 * `thinking` is a per-process flag pushed on a 2s keepAlive (claude/session.ts,
 * codex/runCodex.ts). Two processes on one session id start their turns together
 * but finish tens of seconds apart, so for the whole gap the app receives
 * alternating thinking:true / thinking:false for the same session and flips the
 * status on every heartbeat — the chat flickers, replies land twice, and both
 * processes answer the same RPC. Observed on 2026-09-04: two `resume-happy-session`
 * RPCs 17s apart, the first already resolved, both webhooks landing on session
 * cmtl1m9ag67eiyu0ua709r58x.
 *
 * So resume is idempotent: if a live process already owns the session, hand back
 * the session instead of spawning a second one.
 */
export function findLiveSessionProcess(
    pidToTrackedSession: Map<number, TrackedSession>,
    happySessionId: string,
    isAlive: (pid: number) => boolean,
    onReap?: (pid: number) => void,
): TrackedSession | undefined {
    for (const [pid, session] of Array.from(pidToTrackedSession.entries())) {
        if (session.happySessionId !== happySessionId) continue;
        if (isAlive(pid)) return session;
        // Map membership is not proof of life: sessions registered from the
        // webhook (started outside the daemon) carry no childProcess and so get
        // no exit handler, and would otherwise block their own resume forever.
        pidToTrackedSession.delete(pid);
        onReap?.(pid);
    }
    return undefined;
}

export interface RunningProcess {
    pid: number;
    name?: string;
    cmd?: string;
}

/**
 * Sessions are spawned detached, so they outlive the daemon that started them —
 * a daemon self-restart (it replaces itself when dist/index.mjs changes) leaves
 * every running session orphaned and absent from the new pidToTrackedSession.
 * The liveness check above would then find nothing and let a resume spawn the
 * duplicate this whole guard exists to prevent.
 *
 * What survives a restart is the persisted webhook metadata, which carries the
 * session's hostPid. Matching that pid against the process table — and against
 * the command line, so a recycled pid cannot masquerade as a live session —
 * recovers the orphan.
 */
export async function findOrphanedSessionPid(
    session: TrackedSession | undefined,
    listProcesses: () => Promise<RunningProcess[]>,
): Promise<number | undefined> {
    const hostPid = session?.happySessionMetadataFromLocalWebhook?.hostPid;
    if (!hostPid) return undefined;

    let processes: RunningProcess[];
    try {
        processes = await listProcesses();
    } catch {
        // Unknown ownership is not proof that the old wrapper has exited.
        throw new Error('Cannot verify existing session process; refusing to start a duplicate. Retry when process discovery is available.');
    }

    const match = processes.find(p => p.pid === hostPid);
    if (match && !match.cmd?.trim()) {
        throw new Error('Cannot verify existing session process command; refusing to start a duplicate.');
    }
    return match && looksLikeHappyCli(match) ? hostPid : undefined;
}

/**
 * Last line of defence against a second wrapper.
 *
 * The two guards above find a session by pid: the tracking map, and the pid the
 * webhook persisted. A replacement spawned through a different path — an upgrade
 * refresh while the daemon is being replaced, say — is in neither, so both miss
 * it and the resume spawns a duplicate. Observed repeatedly on 2026-09-07: the
 * second wrapper cannot take the engine's thread lock and dies reporting
 * "thread already has an active writer", after writing its own pid over the
 * session's owner record.
 *
 * What a wrapper cannot hide is the conversation it resumes, which is on its
 * command line. A live CLI resuming this session's provider id owns the session,
 * whoever started it.
 */
export function findProviderSessionPid(
    processes: RunningProcess[],
    providerSessionId: string | undefined,
    ownsAnotherSession: (pid: number) => boolean = () => false,
): number | undefined {
    // Provider ids are opaque; anything shorter or looser is not one and must
    // never be turned into a pattern that matches unrelated command lines.
    if (!providerSessionId || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(providerSessionId)) return undefined;
    const resumes = new RegExp(`--resume(?:\\s+|=)["']?${providerSessionId}(?:["']?(?:\\s|$))`);
    const match = processes.find(process =>
        looksLikeHappyCli(process) && resumes.test(process.cmd ?? '') && !ownsAnotherSession(process.pid));
    return match?.pid;
}

/** Only the session entrypoint owns heartbeats; engines, MCP helpers and the daemon do not. */
function looksLikeHappyCli(proc: RunningProcess): boolean {
    const cmd = (proc.cmd ?? '').trim();
    // ps-list may omit the interpreter or flatten spaces in a script path.
    // Consume the first script, never an LMC path appearing in its arguments.
    const withoutNode = cmd.replace(/^(?:\S*\/)?node(?:\s+--(?:no-warnings|no-deprecation|enable-source-maps))*\s+/, '');
    const entry = withoutNode.match(/^["']?(.+?\.[cm]?js)["']?(?:\s+(.*))?$/);
    if (!entry) return false;
    const installedHappy = /(?:^|\/)(?:happy|happy-cli|happy-coder)\/dist\/index\.[cm]?js$/.test(entry[1]);
    const installedLmc = /\/\.lmc\/agent-releases\/[a-zA-Z0-9_-]+\/dist\/index\.[cm]?js$/.test(entry[1]);
    if (!installedHappy && !installedLmc) return false;
    const args = (entry[2] ?? '').trim();
    return args === '' || /^(?:codex|claude)(?:\s|$)/.test(args)
        || /^--(?:happy-starting-mode|resume|started-by)(?:\s|=)/.test(args);
}

/** Probes a pid without signalling it. */
export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Collapses concurrent calls for the same key onto one in-flight promise.
 *
 * The liveness check alone is not enough: a second resume RPC arriving before
 * the first webhook lands finds nothing in the tracking map yet.
 */
export class SingleFlight<T> {
    private inFlight = new Map<string, Promise<T>>();

    run(key: string, task: () => Promise<T>, onJoin?: () => void): Promise<T> {
        const existing = this.inFlight.get(key);
        if (existing) {
            onJoin?.();
            return existing;
        }
        const started = task();
        this.inFlight.set(key, started);
        // Settled either way — a failed resume must not wedge the key.
        const clear = () => {
            if (this.inFlight.get(key) === started) {
                this.inFlight.delete(key);
            }
        };
        started.then(clear, clear);
        return started;
    }

    get size(): number {
        return this.inFlight.size;
    }
}
