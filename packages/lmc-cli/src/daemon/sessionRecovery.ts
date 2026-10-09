import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Metadata } from '@/api/types';
import type { SessionRefreshOptions } from './sessionRefresh';

type ActiveSession = { sessionId: string; pid: number };
const valid = (entry: ActiveSession) => entry && /^[a-zA-Z0-9_-]{1,128}$/.test(entry.sessionId)
    && Number.isSafeInteger(entry.pid) && entry.pid > 0;

/** Single daemon writer (under the daemon lock). No keys or conversation data.
 * A normal exit removes its PID; daemon/OS shutdown keeps the recovery intent. */
export class ActiveSessionJournal {
    constructor(private file: string) {}
    list(): ActiveSession[] {
        if (!existsSync(this.file)) return [];
        const data = JSON.parse(readFileSync(this.file, 'utf8'));
        if (data.version !== 1 || !Array.isArray(data.sessions) || !data.sessions.every(valid)) throw new Error('Invalid active session journal');
        return data.sessions;
    }
    remember(sessionId: string, pid: number) {
        if (!valid({ sessionId, pid })) throw new Error('Invalid running session');
        const entries = this.list();
        if (entries.some(entry => entry.sessionId === sessionId && entry.pid === pid)) return;
        this.save([...entries.filter(entry => entry.sessionId !== sessionId), { sessionId, pid }]);
    }
    forget(sessionId: string, pid?: number) {
        const entries = this.list();
        const next = entries.filter(entry => entry.sessionId !== sessionId || (pid !== undefined && entry.pid !== pid));
        if (next.length !== entries.length) this.save(next);
    }
    private save(sessions: ActiveSession[]) {
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        const temp = this.file + '.' + randomUUID() + '.tmp';
        const fd = openSync(temp, 'wx', 0o600);
        try { writeFileSync(fd, JSON.stringify({ version: 1, sessions })); fsyncSync(fd); }
        finally { closeSync(fd); }
        renameSync(temp, this.file);
        // Persist the rename before a machine power cycle. Windows cannot open
        // directories through this API; its file flush above still applies.
        if (process.platform !== 'win32') {
            const directory = openSync(dirname(this.file), 'r');
            try { fsyncSync(directory); } finally { closeSync(directory); }
        }
    }
}

type Ports = {
    journal: ActiveSessionJournal;
    machineId: string;
    live(id: string): Promise<boolean>;
    busy(id: string): boolean;
    stopping(): boolean;
    metadata(id: string): Promise<Metadata | null>;
    resume(id: string, metadata: Metadata, options: SessionRefreshOptions, canStart: () => boolean): Promise<void>;
    error(id: string, error: unknown): void;
};

/** Recover the startup snapshot only. Newly closed sessions are never polled
 * back to life. Existing resume guards serialize browser/daemon races. */
export class StartupSessionRecovery {
    private pending = new Map<string, number>();
    private running = false;
    constructor(private ports: Ports) {
        try { ports.journal.list().forEach(entry => this.pending.set(entry.sessionId, 0)); }
        catch (error) { ports.error('journal', error); }
    }
    async run() {
        if (this.running || this.ports.stopping() || this.pending.size === 0) return;
        this.running = true;
        try {
            for (const [id, attempts] of this.pending) {
                if (this.ports.stopping()) return;
                try {
                    if (!this.ports.journal.list().some(entry => entry.sessionId === id)) { this.pending.delete(id); continue; }
                    if (this.ports.busy(id)) continue;
                    if (await this.ports.live(id)) { this.pending.delete(id); continue; }
                    const metadata = await this.ports.metadata(id);
                    if (this.ports.stopping() || this.ports.busy(id)) continue;
                    if (!this.ports.journal.list().some(entry => entry.sessionId === id)) { this.pending.delete(id); continue; }
                    if (!metadata) throw new Error('Session metadata unavailable');
                    if (['archived', 'archiveRequested'].includes(metadata.lifecycleState ?? '')) {
                        this.ports.journal.forget(id); this.pending.delete(id); continue;
                    }
                    const engine = metadata.flavor;
                    if (metadata.machineId !== this.ports.machineId || metadata.lifecycleState !== 'running'
                        || !((engine === 'codex' && metadata.codexThreadId) || (engine === 'claude' && metadata.claudeSessionId))) {
                        this.pending.delete(id);
                        throw new Error('Session ownership or original provider identity unavailable');
                    }
                    const options: SessionRefreshOptions = {
                        ...(metadata.modelMode ? { model: metadata.modelMode } : {}),
                        ...(metadata.effortLevel ? { effort: metadata.effortLevel } : {}),
                        ...(metadata.permissionMode ? { permissionMode: metadata.permissionMode } : {}),
                        ...(engine === 'codex' ? { codexServiceTier: metadata.codexServiceTier, codexContextLimits: metadata.codexContextLimits } : {}),
                    };
                    await this.ports.resume(id, metadata, options, () => !this.ports.stopping() && !this.ports.busy(id)
                        && this.ports.journal.list().some(entry => entry.sessionId === id));
                    this.pending.delete(id);
                } catch (error) {
                    this.ports.error(id, error);
                    if (this.pending.has(id)) {
                        if (attempts >= 2) this.pending.delete(id);
                        else this.pending.set(id, attempts + 1);
                    }
                }
            }
        } finally { this.running = false; }
    }
}
