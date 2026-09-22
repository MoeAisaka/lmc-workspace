import { randomUUID } from 'node:crypto';
import { loginIsTerminal, type EngineLoginContext, type EngineLoginError, type EngineLoginReply, type EngineLoginSnapshot, type LoginEngine, type LoginRecovery } from 'lmc-wire';
import type { EngineAuthStatus } from '@/utils/engineAuth';
import type { LoginChild, LoginEvents } from './nativeEngineLogin';

export type EngineLoginDependencies = {
    context(sessionId: string): Promise<EngineLoginContext>;
    check(context: EngineLoginContext): Promise<EngineAuthStatus>;
    launch(context: EngineLoginContext, events: LoginEvents): LoginChild;
    recover(context: EngineLoginContext, sourceId: string): Promise<LoginRecovery[]>;
    inspect(recovery: LoginRecovery): Promise<LoginRecovery>;
};
type Entry = { flow: EngineLoginSnapshot; sourceId: string; context?: EngineLoginContext; child?: LoginChild; timer?: ReturnType<typeof setTimeout>; polling?: boolean; rechecking?: boolean };

/** One transient job per device/engine, independent of whichever UI opened it. */
export class EngineLoginManager {
    private entries = new Map<LoginEngine, Entry>();
    private automaticChecks = new Map<string, number>();
    private timer: ReturnType<typeof setInterval>;
    constructor(private deps: EngineLoginDependencies, private lifetimeMs = 10 * 60_000) {
        this.timer = setInterval(() => { for (const entry of this.entries.values()) void this.poll(entry); }, 5000);
        this.timer.unref();
    }
    private snapshot(entry?: Entry): EngineLoginReply { return { flow: entry ? structuredClone(entry.flow) : null }; }
    status(engine: LoginEngine) { return this.snapshot(this.entries.get(engine)); }
    autoCheck(engine: LoginEngine, sourceId: string): EngineLoginReply {
        // Different browsers must not repeatedly refresh the same failed session.
        const key = `${engine}:${sourceId}`;
        const last = this.automaticChecks.get(key);
        if (last !== undefined && Date.now() - last < 5 * 60_000) return this.status(engine);
        if (this.automaticChecks.size >= 512) this.automaticChecks.delete(this.automaticChecks.keys().next().value!);
        this.automaticChecks.set(key, Date.now());
        return this.start(engine, sourceId, true);
    }
    recheck(engine: LoginEngine, sourceId: string): EngineLoginReply {
        const entry = this.entries.get(engine);
        if (!entry || loginIsTerminal(entry.flow.state)) return this.start(engine, sourceId, true);
        if (entry.flow.state === 'waiting' && entry.context && !entry.rechecking) {
            entry.rechecking = true;
            void (async () => {
                try {
                    const status = await this.deps.check(entry.context!);
                    if (!this.active(entry) || entry.flow.state !== 'waiting') return;
                    if (status !== 'ready') { entry.flow.error = status; return; }
                    entry.flow.state = 'verifying';
                    entry.child?.cancel(); entry.child = undefined;
                    entry.flow.authorizationUrl = undefined; entry.flow.userCode = undefined; entry.flow.error = undefined;
                    await this.recover(entry);
                } catch { this.end(entry, 'unknown'); }
                finally { entry.rechecking = false; }
            })();
        }
        return this.snapshot(entry);
    }
    start(engine: LoginEngine, sourceId: string, checkOnly = false): EngineLoginReply {
        const previous = this.entries.get(engine);
        if (previous && !loginIsTerminal(previous.flow.state)) return this.snapshot(previous);
        const entry: Entry = { sourceId, flow: { id: randomUUID(), sourceSessionId: sourceId, engine, method: engine === 'claude' ? 'authorizationCode' : 'deviceCode', state: 'checking', expiresAt: Date.now() + this.lifetimeMs, sessions: [] } };
        this.entries.set(engine, entry); // Reserve synchronously, before context RPC.
        entry.timer = setTimeout(() => this.end(entry, 'expired'), this.lifetimeMs);
        entry.timer.unref();
        void this.initialize(entry, checkOnly);
        return this.snapshot(entry);
    }
    private active(entry: Entry) { return this.entries.get(entry.flow.engine) === entry && !loginIsTerminal(entry.flow.state); }
    private end(entry: Entry, error: EngineLoginError) {
        if (!this.active(entry)) return;
        if (entry.timer) clearTimeout(entry.timer);
        entry.child?.cancel();
        entry.child = undefined;
        entry.flow.authorizationUrl = undefined;
        entry.flow.userCode = undefined;
        entry.flow.error = error;
        entry.flow.state = error === 'expired' || error === 'cancelled' ? error : 'failed';
    }
    private async initialize(entry: Entry, checkOnly: boolean) {
        try {
            const context = await this.deps.context(entry.sourceId);
            if (!this.active(entry)) return;
            if (context.engine !== entry.flow.engine || !context.supported) return this.end(entry, 'unsupported');
            entry.context = context;
            if (checkOnly) {
                const status = await this.deps.check(context);
                if (!this.active(entry)) return;
                if (status !== 'ready') return this.end(entry, status);
                await this.recover(entry);
                return;
            }
            entry.flow.state = 'starting';
            entry.child = this.deps.launch(context, {
                ready: (url, userCode) => {
                    if (!this.active(entry) || entry.flow.state !== 'starting') return;
                    Object.assign(entry.flow, { authorizationUrl: url, userCode, state: 'waiting' });
                },
                exit: success => { void this.onExit(entry, success); },
            });
        } catch (error) {
            // Only our fixed error codes may cross RPC, never native error output.
            this.end(entry, error instanceof Error && error.message === 'upgrade' ? 'upgrade' : 'offline');
        }
    }
    private async onExit(entry: Entry, success: boolean) {
        if (!this.active(entry)) return;
        entry.child = undefined;
        if (!success) return this.end(entry, entry.flow.state === 'submitting' ? 'invalidCode' : 'loginFailed');
        entry.flow.authorizationUrl = undefined;
        entry.flow.userCode = undefined;
        entry.flow.error = undefined;
        entry.flow.state = 'verifying';
        try {
            const status = await this.deps.check(entry.context!);
            if (!this.active(entry)) return;
            if (status !== 'ready') return this.end(entry, status);
            await this.recover(entry);
        } catch { this.end(entry, 'unknown'); }
    }
    private async recover(entry: Entry) {
        if (!this.active(entry)) return;
        // Login succeeded. A busy session may legitimately wait longer than OAuth.
        if (entry.timer) clearTimeout(entry.timer);
        entry.flow.state = 'recovering';
        const sessions = await this.deps.recover(entry.context!, entry.sourceId);
        if (!this.active(entry)) return;
        entry.flow.sessions = sessions;
        if (!sessions.length) return this.end(entry, 'offline');
        await this.poll(entry);
    }
    private async poll(entry: Entry) {
        if (entry.flow.state !== 'recovering' || entry.polling) return;
        // Do not mark an empty list complete while recover() is still running.
        if (!entry.flow.sessions.length) return;
        entry.polling = true;
        try {
            const sessions = await Promise.all(entry.flow.sessions.map(job => job.state === 'waiting' ? this.deps.inspect(job).catch(() => job) : job));
            if (!this.active(entry)) return;
            entry.flow.sessions = sessions;
            if (sessions.every(job => job.state !== 'waiting')) entry.flow.state = 'complete';
        } finally { entry.polling = false; }
    }
    submit(engine: LoginEngine, id: string, code: unknown): EngineLoginReply {
        const entry = this.entries.get(engine);
        if (!entry || entry.flow.id !== id) return { flow: null, error: 'stale' };
        if (engine !== 'claude') return { ...this.snapshot(entry), error: 'unsupported' };
        // Codes are a single opaque line. Never send control characters to a CLI.
        if (typeof code !== 'string' || !/^[A-Za-z0-9_#\.~+\/=:-]{8,4096}$/.test(code.trim())) return { ...this.snapshot(entry), error: 'invalidCode' };
        if (entry.flow.state !== 'waiting') return { ...this.snapshot(entry), error: 'busy' };
        entry.flow.state = 'submitting';
        if (!entry.child?.submit(code.trim())) this.end(entry, 'loginFailed');
        return this.snapshot(entry);
    }
    cancel(engine: LoginEngine, id: string): EngineLoginReply {
        const entry = this.entries.get(engine);
        if (!entry || entry.flow.id !== id) return { flow: null, error: 'stale' };
        // Once handed off, refresh waits at the real boundary; closing is harmless.
        if (entry.flow.state === 'recovering') return { ...this.snapshot(entry), error: 'busy' };
        this.end(entry, 'cancelled');
        return this.snapshot(entry);
    }
    dispose() { clearInterval(this.timer); for (const entry of this.entries.values()) this.end(entry, 'cancelled'); }
}
