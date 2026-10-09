import type { Session } from './storageTypes';

export type NativeApprovalScreen = {
    active?: boolean; epoch: string; revision: number; ownsInput?: boolean;
    exited?: boolean; composer?: boolean; phase: string; lines: string[];
};
export type NativeAppApproval = {
    epoch: string; raw: string; apps: string[]; reason: string; hiddenApps: number | null;
    choices: { allow: number; deny: number } | null;
};

export function supportsNativeAppApproval(session: Session | null | undefined): boolean {
    return session?.metadata?.flavor === 'claude' && session.metadata.claudeNativeActive === true
        && session.metadata.sessionCapabilities?.nativeComputer === true;
}

/** Only the live, complete, known menu gets one-click choices. Unknown variants
 * remain inspectable in the native controls; terminal history is never a grant. */
export function nativeAppApproval(screen: NativeApprovalScreen): NativeAppApproval | null {
    if (screen.active === false || screen.exited || screen.composer || screen.phase !== 'busy'
        || !screen.epoch || !Number.isInteger(screen.revision) || !Array.isArray(screen.lines)) return null;
    const lines = screen.lines.map(line => line.trim()).filter(Boolean);
    const start = lines.lastIndexOf('Computer Use wants to control these apps');
    if (start < 0) return null;
    const menu = lines.slice(start);
    // After a selection Claude can leave the old menu in the visible history.
    if (menu.at(-1) !== 'Enter to confirm · Esc to cancel') return null;
    const rows = menu.filter(line => /^[◉○]\s+/.test(line));
    const apps = rows.filter(line => line.startsWith('◉')).map(line => line.replace(/^◉\s+/, ''));
    const firstApp = menu.findIndex(line => /^[◉○]\s+/.test(line));
    const reasonLines = firstApp > 1 ? menu.slice(1, firstApp) : [];
    const hidden = menu.find(line => /^\d+ other apps? will be hidden while Claude works\.$/.test(line));
    const allowIndex = menu.findIndex(line => /^[1-9]\. Allow for this session \(\d+ apps?\)$/.test(line));
    const denyIndex = menu.findIndex(line => /^[1-9]\. Deny, and tell Claude what to do differently \(esc\)$/.test(line));
    const allow = menu[allowIndex]?.match(/^([1-9])\. Allow for this session \((\d+) apps?\)$/);
    const deny = menu[denyIndex]?.match(/^([1-9])\./);
    const optionStart = Math.min(allowIndex, denyIndex);
    const scopes = firstApp >= 0 ? menu.slice(firstApp, optionStart) : [];
    const knownScope = scopes.length > 0 && scopes.every(line => /^◉\s+\S/.test(line)
        || /^\d+ other apps? will be hidden while Claude works\.$/.test(line));
    const knownMenu = allow && deny && allow[1] !== deny[1] && Math.abs(allowIndex - denyIndex) === 1
        && menu.length === optionStart + 4
        && menu[optionStart + 2] === `Select with numbers [${Math.min(+allow[1], +deny[1])}-${Math.max(+allow[1], +deny[1])}]. Then Enter to submit or Escape to cancel:`;
    const complete = knownMenu && knownScope && reasonLines[0]?.startsWith('>')
        && apps.length > 0 && apps.length === Number(allow[2]) && apps.length === rows.length
        && new Set(apps).size === apps.length;
    return {
        epoch: screen.epoch, raw: menu.join('\n'), apps,
        reason: reasonLines.join('\n').replace(/^>\s*/, ''),
        hiddenApps: hidden ? Number(hidden.split(' ')[0]) : null,
        choices: complete ? { allow: Number(allow[1]), deny: Number(deny[1]) } : null,
    };
}

export type NativeApprovalState = {
    prompt: NativeAppApproval | null; busy: boolean; unavailable: boolean; submitted: boolean;
    issue: 'changed' | 'unavailable' | 'unconfirmed' | null;
};
export type NativeApprovalRPC = (params: Record<string, unknown>) => Promise<any>;
type ReceiptStore = { read(): string | null; write(value: string | null): void };

// A reload must not offer the same possibly delivered choice again. Persist only
// an opaque marker, never the app names/reason or terminal contents. A collision
// could only disable a button; this hash is not an authorization check.
function receiptKey(prompt: NativeAppApproval): string {
    let hash = 2166136261;
    for (const char of prompt.raw) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return `${prompt.epoch}:${hash >>> 0}`;
}
export function nativeApprovalReceiptStore(sessionId: string): ReceiptStore {
    const key = `lmc.native-approval.${sessionId}`;
    let memory: string | null = null;
    let memoryOnly = false;
    return {
        read() {
            if (memoryOnly) return memory;
            try { return typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(key) ?? memory : memory; } catch { return memory; }
        },
        write(value) {
            memory = value;
            try {
                if (typeof sessionStorage !== 'undefined') { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); }
                memoryOnly = false;
            } catch { memoryOnly = true; }
        },
    };
}

export class NativeAppApprovalController {
    state: NativeApprovalState = { prompt: null, busy: false, unavailable: false, submitted: false, issue: null };
    private reading: Promise<void> | null = null;
    private stopped = false;
    private readonly clientId = `approval_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    constructor(private readonly rpc: NativeApprovalRPC, private readonly available: () => boolean,
        private readonly changed: (state: NativeApprovalState) => void, private readonly receipt: ReceiptStore) {}
    stop() { this.stopped = true; }
    private update(value: Partial<NativeApprovalState>) {
        this.state = { ...this.state, ...value };
        if (!this.stopped) this.changed(this.state);
    }
    private ready() { return !this.stopped && this.available(); }
    connectionChanged() { if (!this.ready()) this.update({ unavailable: true }); }
    private async call(params: Record<string, unknown>) {
        const result = await this.rpc({ ...params, clientId: this.clientId });
        if (result?.error) throw new Error(result.error);
        return result;
    }
    private observe(screen: NativeApprovalScreen) {
        if (this.stopped) return;
        const prompt = nativeAppApproval(screen);
        const submitted = !!prompt && this.receipt.read() === receiptKey(prompt);
        if (!submitted) this.receipt.write(null);
        this.update({ prompt, submitted, unavailable: !this.ready(),
            issue: submitted ? this.state.issue : null });
    }
    poll(): Promise<void> {
        if (!this.ready() || this.state.busy) return Promise.resolve();
        if (this.reading) return this.reading;
        this.reading = (async () => {
            try { this.observe(await this.call({ action: 'screen' })); }
            catch { this.update({ unavailable: true }); }
            finally { this.reading = null; }
        })();
        return this.reading;
    }
    async respond(choice: 'allow' | 'deny'): Promise<void> {
        const displayed = this.state.prompt;
        if (!this.ready() || !displayed?.choices || this.state.busy || this.state.unavailable || this.state.submitted) return;
        this.update({ busy: true, issue: null });
        let claimed = false, attempted = false;
        try {
            await this.reading;
            if (!this.ready()) throw new Error('Unavailable');
            // Claim returns a fresh screen. Compare the entire displayed scope,
            // not just the app count, then send its exact epoch and revision.
            claimed = true;
            const screen: NativeApprovalScreen = await this.call({ action: 'claim' });
            const current = nativeAppApproval(screen);
            if (!current?.choices || current.epoch !== displayed.epoch || current.raw !== displayed.raw) {
                this.observe(screen); this.update({ issue: 'changed' }); return;
            }
            if (!screen.ownsInput || !this.ready()) throw new Error('Unavailable');
            this.receipt.write(receiptKey(current));
            attempted = true;
            this.update({ submitted: true });
            await this.call({ action: 'input', epoch: screen.epoch, revision: screen.revision,
                requestId: `approval_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                input: { type: 'choice', choice: current.choices[choice] } });
            if (this.ready()) this.observe(await this.call({ action: 'screen' }));
        } catch {
            this.update({ issue: attempted ? 'unconfirmed' : 'unavailable', unavailable: !this.ready() });
        } finally {
            // Release only this panel's lease; never exit, restart, or take over
            // a different native window. A lost release expires after 15 s.
            this.update({ busy: false });
            if (claimed) void this.call({ action: 'release' }).catch(() => {});
        }
    }
}
