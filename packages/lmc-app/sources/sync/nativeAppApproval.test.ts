import { describe, expect, it, vi } from 'vitest';
import { NativeAppApprovalController, nativeAppApproval, nativeApprovalReceiptStore, supportsNativeAppApproval, type NativeApprovalScreen } from './nativeAppApproval';

const lines = [
    'tool: Calling computer-use… (ctrl+o to expand)',
    'Computer Use wants to control these apps',
    '> 打开绩效系统并验证登录，不查看聊天内容。',
    '  ◉ 钉钉',
    '2 other apps will be hidden while Claude works.',
    '1. Deny, and tell Claude what to do differently (esc)',
    '2. Allow for this session (1 app)',
    'Select with numbers [1-2]. Then Enter to submit or Escape to cancel:',
    'Enter to confirm · Esc to cancel',
];
const screen = (patch: Partial<NativeApprovalScreen> = {}): NativeApprovalScreen => ({
    epoch: 'epoch-one', revision: 7, phase: 'busy', composer: false, lines, ...patch,
});
function fixture() {
    const calls: Record<string, any>[] = [];
    let current = screen(), online = true, receipt: string | null = null;
    let intercept: ((params: Record<string, any>) => Promise<void> | void) | undefined;
    const store = { read: () => receipt, write: (value: string | null) => { receipt = value; } };
    const rpc = async (params: Record<string, any>) => {
        calls.push(params); await intercept?.(params);
        if (params.action === 'claim') return { ...current, ownsInput: true };
        if (params.action === 'screen') return current;
        if (params.action === 'input') { current = screen({ lines: ['Claude is continuing'], revision: 9 }); return { revision: 8 }; }
        return {};
    };
    const create = () => new NativeAppApprovalController(rpc, () => online, () => {}, store);
    return { calls, create, monitor: create(), setScreen: (value: NativeApprovalScreen) => { current = value; },
        setOnline: (value: boolean) => { online = value; }, intercept: (fn: typeof intercept) => { intercept = fn; },
        inputs: () => calls.filter(call => call.action === 'input') };
}

describe('native app authorization screen', () => {
    it('captures the complete scope and actual numbered choices from the observed CLI menu', () => {
        expect(nativeAppApproval(screen())).toMatchObject({ apps: ['钉钉'], reason: '打开绩效系统并验证登录，不查看聊天内容。',
            hiddenApps: 2, choices: { allow: 2, deny: 1 } });
    });
    it.each([
        { phase: 'idle' }, { phase: 'sending' }, { composer: true }, { exited: true }, { active: false },
        { lines: [...lines, 'claude: Now working'] }, { lines: lines.slice(0, -1) },
    ])('ignores history or incomplete live-screen evidence: %j', patch => {
        expect(nativeAppApproval(screen(patch))).toBeNull();
    });
    it.each([
        lines.map(line => line.replace('(1 app)', '(2 apps)')),
        lines.map(line => line.replace('◉', '○')),
        [...lines.slice(0, 5), '◉ Clipboard access', ...lines.slice(5)],
        [...lines.slice(0, 5), 'Allow access to clipboard contents', ...lines.slice(5)],
        lines.map(line => line.replace('Allow for this session', 'Always allow')),
    ].map(altered => ({ altered })))('keeps unknown/incomplete scopes inspectable without one-click grants', ({ altered }) => {
        const result = nativeAppApproval(screen({ lines: altered }));
        expect(result).not.toBeNull(); expect(result?.choices).toBeNull();
        expect(result?.raw).toContain(altered[5]);
    });
    it('covers multiple selected apps without dropping reason or scope', () => {
        const result = nativeAppApproval(screen({ lines: [...lines.slice(0, 4), '◉ Calendar', ...lines.slice(4)].map(line => line.replace('(1 app)', '(2 apps)')) }));
        expect(result?.apps).toEqual(['钉钉', 'Calendar']); expect(result?.choices?.allow).toBe(2);
    });
    it('uses the actual option numbers, never a hard-coded approval keystroke', () => {
        const result = nativeAppApproval(screen({ lines: lines.map(line => line.replace('1. Deny', '2. Deny').replace('2. Allow', '1. Allow')) }));
        expect(result?.choices).toEqual({ allow: 1, deny: 2 });
    });
    it('requires explicit Claude native capability; Codex and old Agents are excluded', () => {
        const session = { metadata: { flavor: 'claude', claudeNativeActive: true, sessionCapabilities: { nativeComputer: true } } };
        expect(supportsNativeAppApproval(session as any)).toBe(true);
        expect(supportsNativeAppApproval({ metadata: { ...session.metadata, flavor: 'codex' } } as any)).toBe(false);
        expect(supportsNativeAppApproval({ metadata: { ...session.metadata, sessionCapabilities: undefined } } as any)).toBe(false);
        expect(supportsNativeAppApproval(null)).toBe(false);
    });
});

describe('explicit authorization transport', () => {
    it.each([null, 'older-marker'])('retains the in-memory marker when browser storage contains %s and cannot be written', stored => {
        vi.stubGlobal('sessionStorage', { getItem: () => stored, setItem: () => { throw new Error('Quota exceeded'); }, removeItem: () => { throw new Error('Read only'); } });
        try {
            const store = nativeApprovalReceiptStore('test'); store.write('opaque-marker');
            expect(store.read()).toBe('opaque-marker'); store.write(null); expect(store.read()).toBeNull();
        } finally { vi.unstubAllGlobals(); }
    });
    it.each(['allow', 'deny'] as const)('reading never claims or submits; %s sends one current, scoped choice', async choice => {
        const f = fixture(); await f.monitor.poll(); await f.monitor.poll();
        expect(f.calls.map(call => call.action)).toEqual(['screen', 'screen']);
        f.setScreen(screen({ revision: 12 }));
        await f.monitor.respond(choice);
        expect(f.inputs()).toHaveLength(1);
        expect(f.inputs()[0]).toMatchObject({ epoch: 'epoch-one', revision: 12, input: { type: 'choice', choice: choice === 'allow' ? 2 : 1 } });
        expect(f.inputs()[0].requestId).toMatch(/^approval_/);
        expect(f.monitor.state.prompt).toBeNull();
        expect(f.calls.at(-1)?.action).toBe('release');
        expect(f.calls.every(call => !['start', 'leave'].includes(call.action))).toBe(true);
    });
    it.each(['scope', 'epoch', 'finished'])('rejects a %s change between display and click', async change => {
        const f = fixture(); await f.monitor.poll();
        f.setScreen(change === 'scope' ? screen({ lines: lines.map(line => line.replace('钉钉', 'Mail')) })
            : change === 'epoch' ? screen({ epoch: 'epoch-two' }) : screen({ composer: true }));
        await f.monitor.respond('allow'); expect(f.inputs()).toHaveLength(0); expect(f.monitor.state.issue).toBe('changed');
    });
    it('coalesces repeated taps while the claim is in flight', async () => {
        const f = fixture(); await f.monitor.poll();
        let finish!: () => void;
        f.intercept(params => params.action === 'claim' ? new Promise<void>(resolve => { finish = resolve; }) : undefined);
        const first = f.monitor.respond('allow'); await Promise.resolve();
        await f.monitor.respond('allow'); await f.monitor.respond('deny');
        finish(); await first; expect(f.inputs()).toHaveLength(1);
    });
    it('does not steal another window’s lease', async () => {
        const f = fixture(); await f.monitor.poll();
        f.intercept(params => { if (params.action === 'claim') throw new Error('controlled on another screen'); });
        await f.monitor.respond('allow'); expect(f.inputs()).toHaveLength(0); expect(f.monitor.state.issue).toBe('unavailable');
    });
    it.each(['offline', 'stopped'])('never writes after the view becomes %s during a claim', async state => {
        const f = fixture(); await f.monitor.poll();
        f.intercept(params => { if (params.action === 'claim') { if (state === 'offline') f.setOnline(false); else f.monitor.stop(); } });
        await f.monitor.respond('allow'); expect(f.inputs()).toHaveLength(0);
    });
    it('disables a stale card on connection loss and restores it only after reading', async () => {
        const f = fixture(); await f.monitor.poll(); f.setOnline(false); f.monitor.connectionChanged();
        expect(f.monitor.state.unavailable).toBe(true); await f.monitor.respond('allow'); expect(f.inputs()).toHaveLength(0);
        f.setOnline(true); await f.monitor.poll(); expect(f.monitor.state.unavailable).toBe(false);
    });
    it('does not resend an uncertain write, including after the controller is recreated', async () => {
        const f = fixture(); await f.monitor.poll();
        f.intercept(params => { if (params.action === 'input') throw new Error('reply lost'); });
        await f.monitor.respond('allow'); expect(f.monitor.state.issue).toBe('unconfirmed');
        await f.monitor.poll(); await f.monitor.respond('allow');
        const next = f.create(); await next.poll(); expect(next.state.submitted).toBe(true);
        await next.respond('allow'); expect(f.inputs()).toHaveLength(1);
        f.setScreen(screen({ epoch: 'new-session' })); await next.poll(); expect(next.state.submitted).toBe(false);
    });
});
