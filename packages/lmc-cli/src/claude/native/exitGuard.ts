import { encodeNativeInput, type NativeScreen } from './terminalRelay';

export const NATIVE_EXIT_REFUSED = '原生 Claude 里有定时任务或后台工作在运行，退出会停掉它；已保留原会话，没有退出。';
export const NATIVE_EXIT_UNCONFIRMED = '原生退出尚未完成，排队消息已保留。请打开原生窗口处理提示；取消退出后会自动继续收件。';

/** What to answer when Claude asks before an exit that would stop its own
 * work. `stay` keeps the work and the session; `stop` is the person's explicit
 * choice to end that work so the refresh can go through. */
export type NativeExitChoice = 'stay' | 'stop';

/** A refusal that names the work it protected, so the person can decide. */
export class NativeExitRefusedError extends Error {
    readonly kind = 'background-work' as const;
    constructor(readonly work: string[]) {
        super(work.length ? `原生 Claude 里有后台工作在运行（${work.join('；')}），退出会停掉它；已保留原会话，没有退出。` : NATIVE_EXIT_REFUSED);
        this.name = 'NativeExitRefusedError';
    }
}

const OPTION = /^\s*(?:[❯>]\s*)?([1-9])\.\s*(.+?)\s*$/;
const CHOICES: Record<NativeExitChoice, RegExp> = { stay: /^Stay\b/i, stop: /^Exit and stop\b/i };

export function nativeExitConfirmation(lines: string[], choice: NativeExitChoice = 'stay'): number | null {
    if (!lines.some(line => /Background work is running|will stop when you exit/i.test(line))) return null;
    for (const line of lines) {
        const match = OPTION.exec(line);
        if (match && CHOICES[choice].test(match[2])) return Number(match[1]);
    }
    return null;
}

/** The work Claude lists under "The following will stop when you exit:". */
export function nativeExitBlockedWork(lines: string[]): string[] {
    const start = lines.findIndex(line => /will stop when you exit/i.test(line));
    if (start < 0) return [];
    const work: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (OPTION.test(line) || /Select with numbers/i.test(line)) break;
        const text = line.replace(/\s+/g, ' ').replace(/^[\s·•\-]+|[\s·•\-]+$/g, '').trim();
        if (text) work.push(text);
    }
    return work;
}

/** An exit write is not an exit receipt. Keep observing even after its caller
 * times out, so a late confirmation cannot strand the session behind a lock. */
export class NativeExitGuard {
    private attempt?: {
        since: number; revision: number; cancelRevision?: number; submitted: boolean; choice: NativeExitChoice; work: string[];
        resolve(): void; reject(error: Error): void; timedOut: boolean;
    };
    private timer?: ReturnType<typeof setInterval>;
    private deadline?: ReturnType<typeof setTimeout>;
    private checking = false;
    private closed = false;
    writing = false;
    get active() { return !!this.attempt; }

    constructor(private readonly ports: {
        snapshot(): NativeScreen & { revision: number }; settled(): Promise<void>; write(bytes: string): void;
        retained(work: string[]): void; uncertain(since: number): void;
    }, private readonly timeoutMs = 30_000) {}

    async leave(choice: NativeExitChoice = 'stay'): Promise<void> {
        if (this.active || this.closed) throw new Error(NATIVE_EXIT_UNCONFIRMED);
        let resolve!: () => void, reject!: (error: Error) => void;
        const receipt = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
        // A write can fail synchronously; attach the consumer before any write.
        void receipt.catch(() => {});
        const attempt: NonNullable<NativeExitGuard['attempt']> = { since: Date.now(), revision: this.ports.snapshot().revision,
            submitted: false, timedOut: false, choice, work: [], resolve, reject };
        this.attempt = attempt;
        this.writing = true;
        this.timer = setInterval(() => { void this.observe(); }, 250);
        this.timer.unref?.();
        this.deadline = setTimeout(() => this.uncertain(attempt), this.timeoutMs);
        try {
            this.ports.write(encodeNativeInput({ type: 'text', text: '/exit' }));
            await new Promise(r => setTimeout(r, 120));
            if (!this.closed && this.attempt === attempt) {
                this.ports.write(encodeNativeInput({ type: 'key', key: 'enter' }));
                attempt.submitted = true;
            }
        } catch { this.uncertain(attempt); }
        finally { this.writing = false; }
        return receipt;
    }

    private uncertain(attempt: NonNullable<NativeExitGuard['attempt']>) {
        if (this.attempt !== attempt || attempt.timedOut) return;
        attempt.timedOut = true;
        attempt.reject(new Error(NATIVE_EXIT_UNCONFIRMED));
        this.ports.uncertain(attempt.since);
        // Retain the guard against new automatic writes, not against manual
        // recovery. Never re-send /exit or assume a timeout cancelled it.
    }

    async observe(): Promise<void> {
        if (this.checking || !this.attempt || this.writing || this.closed) return;
        this.checking = true;
        try {
            await this.ports.settled();
            const attempt = this.attempt;
            if (!attempt || this.closed) return;
            const screen = this.ports.snapshot();
            if (attempt.cancelRevision !== undefined) {
                if (screen.revision > attempt.cancelRevision && screen.composer) {
                    this.clear();
                    this.ports.retained(attempt.work);
                    attempt.reject(new NativeExitRefusedError(attempt.work));
                }
                return;
            }
            // Only the current menu is actionable. Old confirmation text can
            // remain in the terminal history after it has already been closed.
            if (!attempt.submitted || screen.revision <= attempt.revision || screen.composer
                || !/Select with numbers.*Then Enter to submit/i.test(screen.lines[screen.cursor.y] ?? '')) return;
            const beforeCursor = screen.lines.slice(0, screen.cursor.y);
            let heading = beforeCursor.length - 1;
            while (heading >= 0 && !/Background work is running/i.test(beforeCursor[heading])) heading--;
            if (heading < 0 || beforeCursor.slice(heading).some(line => /Select with numbers.*Then Enter to submit/i.test(line))) return;
            const menu = beforeCursor.slice(heading);
            attempt.work = nativeExitBlockedWork(menu);
            // Stopping the work is only ever the person's explicit choice, and
            // only when Claude offers it on this menu; otherwise keep the work.
            const stop = attempt.choice === 'stop' ? nativeExitConfirmation(menu, 'stop') : null;
            if (stop !== null) {
                // Answered once. Until the screen moves on, this same menu is
                // not a new question; a later one gets the protective answer.
                attempt.choice = 'stay';
                attempt.revision = screen.revision;
                this.ports.write(encodeNativeInput({ type: 'choice', choice: stop }));
                return;
            }
            const stay = nativeExitConfirmation(menu);
            if (stay === null) return;
            attempt.cancelRevision = screen.revision;
            this.ports.write(encodeNativeInput({ type: 'choice', choice: stay }));
        } catch { if (this.attempt) this.uncertain(this.attempt); }
        finally { this.checking = false; }
    }

    /** Called after a version-checked manual cancel, never before the write. */
    cancelledManually(revision: number) {
        if (this.attempt) this.attempt.cancelRevision = revision;
    }

    exited(exitCode: number) {
        this.closed = true;
        const attempt = this.attempt;
        this.clear();
        if (exitCode === 0) attempt?.resolve();
        else attempt?.reject(new Error(`原生 Claude 已退出（${exitCode}）`));
    }

    private clear() {
        if (this.timer) clearInterval(this.timer);
        if (this.deadline) clearTimeout(this.deadline);
        this.timer = undefined; this.deadline = undefined; this.attempt = undefined;
    }
}
