import type { SwitchableEngine } from '@/daemon/sessionRefresh';
import { refreshErrorKind, tagRefreshError, type RefreshErrorKind } from './refreshErrors';

type RefreshDependencies = {
    isIdle(): boolean;
    /**
     * Why `isIdle` said no, in a few words. Only the runtime knows which of its
     * conditions is the one holding the refresh, and without it a session that
     * has been queued for hours is indistinguishable from one that is merely
     * busy — the operator is left guessing at a predicate they cannot see.
     */
    idleBlocker?(): string | null;
    pause(): number;
    drain(): Promise<void>;
    resume(seq: number): void;
    /** `target` names the engine being switched to, so the checks are run
     *  against the engine the session is going to rather than the one it is
     *  leaving — a switch to an engine that is not logged in has to fail while
     *  the current one is still running. */
    preflight(target?: SwitchableEngine): Promise<void>;
    prepare(seq: number, target?: SwitchableEngine): Promise<void>;
    exit(): Promise<void>;
    /** `applied` is the state after a cancellation: nothing pending, nothing wrong. */
    state(state: 'queued' | 'refreshing' | 'error' | 'applied', error?: string, kind?: RefreshErrorKind): Promise<void>;
    /** Marks the stretch spent on the login check, so it can be shown as its own step. */
    stage?(stage: 'preflight' | null): Promise<void>;
};

/**
 * How often a queued refresh looks for a boundary it may have missed.
 *
 * `drain` is called at the points a turn is known to end, which is correct and
 * not quite enough: a turn that ends abnormally can skip them, leaving a
 * session that looks idle to everyone but never satisfies `isIdle` again. The
 * refresh then waits forever, and so does whatever queued it. This costs one
 * predicate a minute and turns "never" into "a minute late".
 */
const BOUNDARY_RECHECK_MS = 60_000;

/** Only the runtime knows a real turn boundary. Never infer it from a UI heartbeat. */
export class SafeSessionRefresh {
    pending = false;
    private applying = false;
    private handedOff = false;
    /** Set when the queued refresh is a switch; the relaunch reads it. */
    private target: SwitchableEngine | undefined;
    /** Cursor taken early by `hold`, so `drain` does not take a later one. */
    private held: number | undefined;
    private recheck: ReturnType<typeof setInterval> | undefined;
    private published: string | null | undefined;
    constructor(private readonly deps: RefreshDependencies, private readonly recheckMs = BOUNDARY_RECHECK_MS) {}

    private watchForBoundary() {
        if (this.recheck || !this.pending || this.recheckMs <= 0) return;
        this.recheck = setInterval(() => { void this.drain(); }, this.recheckMs);
        this.recheck.unref?.();
    }

    private stopWatching() {
        if (!this.recheck) return;
        clearInterval(this.recheck);
        this.recheck = undefined;
    }

    async request(target?: SwitchableEngine) {
        if (this.pending || this.applying || this.handedOff) return;
        this.pending = true;
        this.target = target;
        try { await this.publishWait(); }
        catch (error) { this.pending = false; throw error; }
        await this.drain();
        this.watchForBoundary();
    }

    /** Republishes the queued state when what it is waiting on changes. */
    private async publishWait() {
        const blocker = this.deps.isIdle() ? null : (this.deps.idleBlocker?.() ?? null);
        if (this.published !== undefined && this.published === blocker) return;
        this.published = blocker;
        await this.deps.state('queued', blocker ?? undefined);
    }

    /**
     * Stop taking new work now, without waiting for the boundary.
     *
     * Called when the engine has written its handoff: from that moment its
     * notes describe a session it must not keep changing. Pausing here freezes
     * the cursor, so anything sent afterwards is replayed to the engine taking
     * over rather than answered by the one on its way out — which would leave
     * the new engine reading notes that predate work it never heard about.
     *
     * Messages already delivered are still answered; the queue is drained, not
     * discarded. This closes the open-ended tail, not the last turn.
     */
    hold() {
        if (!this.pending || this.applying || this.handedOff || this.held !== undefined) return;
        this.held = this.deps.pause();
    }

    /**
     * Call the queued refresh off, if it has not started leaving.
     *
     * Possible only while the request is still a request: once `drain` has
     * begun the boundary work, the daemon may already hold a reservation and
     * the cursor is mid-handover, and the honest answer is that it is too late.
     * Returns the engine the cancelled request was going to, `null` for a
     * plain refresh, or `undefined` when there was nothing to cancel.
     */
    async cancel(): Promise<SwitchableEngine | null | undefined> {
        if (!this.pending || this.applying || this.handedOff) return undefined;
        const target = this.target ?? null;
        this.pending = false;
        this.target = undefined;
        this.published = undefined;
        this.stopWatching();
        if (this.held !== undefined) { this.deps.resume(this.held); this.held = undefined; }
        await this.deps.state('applied');
        return target;
    }

    async drain() {
        if (!this.pending || this.applying || this.handedOff) return;
        if (!this.deps.isIdle()) { await this.publishWait(); return; }
        this.applying = true;
        const seq = this.held ?? this.deps.pause();
        this.held = undefined;
        try {
            await this.deps.drain();
            if (!this.deps.isIdle()) return;
            await this.deps.stage?.('preflight');
            try { await this.deps.preflight(this.target); }
            catch (error) { throw tagRefreshError(error, 'preflight'); }
            finally { await this.deps.stage?.(null); }
            if (!this.deps.isIdle()) return;
            // Publish before prepare; after prepare no fallible metadata writes may
            // keep the old process alive until the daemon's reservation expires.
            await this.deps.state('refreshing');
            if (!this.deps.isIdle()) { await this.deps.state('queued'); return; }
            try { await this.deps.prepare(seq, this.target); }
            catch (error) { throw tagRefreshError(error, 'relaunch'); }
            this.handedOff = true;
            this.pending = false;
            this.stopWatching();
            await this.deps.exit();
        } catch (error) {
            this.pending = false;
            this.target = undefined;
            this.held = undefined;
            this.stopWatching();
            const message = error instanceof Error ? error.message : '刷新检查失败，原会话已保留';
            const kind = refreshErrorKind(error);
            await (kind ? this.deps.state('error', message, kind) : this.deps.state('error', message));
        } finally {
            if (!this.handedOff) this.deps.resume(seq);
            this.applying = false;
        }
    }
}
