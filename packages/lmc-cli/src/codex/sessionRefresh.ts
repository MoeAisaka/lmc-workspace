import { validateCodexContextLimits, type CodexContextLimits } from './contextLimits';
import { validateCodexServiceTier, type CodexServiceTier } from './serviceTier';
export type SessionConfiguration = { contextLimits: CodexContextLimits; serviceTier?: CodexServiceTier; refreshCli?: boolean };
export class SessionRefreshQueue {
    private pending: SessionConfiguration | null = null;
    private applying = false;
    get hasPending() { return this.pending !== null; }
    get hasPendingRefresh() { return this.pending?.refreshCli === true; }
    /** True while `drain` is inside `apply`: too late to take the request back. */
    get isApplying() { return this.applying; }
    /** Drops a request that has not started applying. Returns whether one was dropped. */
    clear() {
        if (this.applying || !this.pending) return false;
        this.pending = null;
        return true;
    }
    request(limits: unknown, tier: unknown, refreshCli = false) {
        const contextLimits = validateCodexContextLimits(limits);
        const serviceTier = validateCodexServiceTier(tier);
        this.pending = { contextLimits, serviceTier, ...((refreshCli || this.pending?.refreshCli) ? { refreshCli: true } : {}) };
    }
    async drain(busy: boolean, queueSize: number, apply: (config: SessionConfiguration) => Promise<void>): Promise<boolean> {
        if (busy || queueSize || this.applying || !this.pending) return false;
        const pending = this.pending; this.applying = true;
        try { await apply(pending); if (this.pending === pending) this.pending = null; return true; }
        finally { this.applying = false; }
    }
}
