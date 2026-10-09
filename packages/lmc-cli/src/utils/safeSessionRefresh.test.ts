import { expect, it, vi } from 'vitest';
import { SafeSessionRefresh } from './safeSessionRefresh';

function fixture() {
    const deps = { isIdle: vi.fn(() => true), preflight: vi.fn(async (_target?: 'claude' | 'codex') => {}),
        pause: vi.fn(() => 42), drain: vi.fn(async () => {}), resume: vi.fn(),
        prepare: vi.fn(async (_seq: number, _target?: 'claude' | 'codex') => {}), exit: vi.fn(async () => {}),
        state: vi.fn(async (_state: string, _error?: string) => {}) };
    return { deps, refresh: new SafeSessionRefresh(deps) };
}
it('queues while generating or awaiting permissions and refreshes once at a real idle boundary', async () => {
    const {deps,refresh}=fixture(); deps.isIdle.mockReturnValue(false);
    await refresh.request(); await refresh.request(); expect(deps.pause).not.toHaveBeenCalled();
    deps.isIdle.mockReturnValue(true); await refresh.drain(); await refresh.drain();
    expect(deps.prepare).toHaveBeenCalledExactlyOnceWith(42, undefined); expect(deps.exit).toHaveBeenCalledTimes(1);
});
it('allows steering during a queued plain refresh, but blocks engine handoff and boundary preparation', async () => {
    const { deps, refresh } = fixture(); deps.isIdle.mockReturnValue(false);
    await refresh.request();
    expect(refresh.blocksSteering).toBe(false);
    await refresh.cancel(); await refresh.request('codex');
    expect(refresh.blocksSteering).toBe(true);
    await refresh.cancel();
    expect(refresh.blocksSteering).toBe(false);
    await refresh.request(); refresh.hold();
    expect(refresh.blocksSteering).toBe(true);
    await refresh.cancel();
    let release!: () => void;
    deps.drain.mockImplementationOnce(() => new Promise<void>(r => { release = r; }));
    deps.isIdle.mockReturnValue(true);
    const applying = refresh.request();
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(refresh.blocksSteering).toBe(true);
    release(); await applying;
    expect(refresh.blocksSteering).toBe(true);
});
it('keeps the original process and restores input after failed auth or missing resume identity', async () => {
    for (const reason of ['Authentication required', 'Resume identity missing']) {
        const {deps,refresh}=fixture(); deps.preflight.mockRejectedValue(new Error(reason));
        await refresh.request(); expect(deps.exit).not.toHaveBeenCalled();
        expect(deps.prepare).not.toHaveBeenCalled(); expect(deps.resume).toHaveBeenCalledWith(42);
        expect(deps.state).toHaveBeenLastCalledWith('error',reason,'preflight');
    }
});
it('defers if async message delivery takes the session out of idle during preflight', async () => {
    const {deps,refresh}=fixture(); deps.preflight.mockImplementation(async()=>{deps.isIdle.mockReturnValue(false);});
    await refresh.request(); expect(deps.prepare).not.toHaveBeenCalled(); expect(deps.resume).toHaveBeenCalledWith(42);
    expect(refresh.pending).toBe(true);
});
it('restores input when daemon preparation fails', async () => {
    const {deps,refresh}=fixture(); deps.prepare.mockRejectedValue(new Error('offline'));
    await refresh.request(); expect(deps.exit).not.toHaveBeenCalled(); expect(deps.resume).toHaveBeenCalledWith(42);
});

it('carries the destination engine through to preflight and the relaunch', async () => {
    const { deps, refresh } = fixture();
    await refresh.request('codex');
    expect(deps.preflight).toHaveBeenCalledWith('codex');
    expect(deps.prepare).toHaveBeenCalledExactlyOnceWith(42, 'codex');
});
it('forgets the destination when the switch fails, so a later plain refresh stays a refresh', async () => {
    const { deps, refresh } = fixture();
    deps.preflight.mockRejectedValueOnce(new Error('Codex 尚未登录'));
    await refresh.request('codex');
    expect(deps.prepare).not.toHaveBeenCalled();
    await refresh.request();
    expect(deps.prepare).toHaveBeenCalledExactlyOnceWith(42, undefined);
});

it('stops taking new work the moment the handoff is written, and hands that cursor to the replacement', async () => {
    const {deps,refresh}=fixture(); deps.isIdle.mockReturnValue(false);
    await refresh.request('codex');
    // The engine writes its notes mid-turn; the cursor is taken there, not at
    // the boundary, so nothing sent afterwards is answered by the engine that
    // is leaving — it is replayed to the one taking over.
    refresh.hold();
    expect(deps.pause).toHaveBeenCalledTimes(1);
    deps.pause.mockReturnValue(99);
    refresh.hold();
    expect(deps.pause).toHaveBeenCalledTimes(1);
    deps.isIdle.mockReturnValue(true); await refresh.drain();
    expect(deps.prepare).toHaveBeenCalledExactlyOnceWith(42, 'codex');
});

it('gives the held cursor back when the switch fails, so the session keeps receiving', async () => {
    const {deps,refresh}=fixture(); deps.isIdle.mockReturnValue(false);
    await refresh.request('codex');
    refresh.hold();
    deps.preflight.mockRejectedValue(new Error('not logged in'));
    deps.isIdle.mockReturnValue(true); await refresh.drain();
    expect(deps.resume).toHaveBeenCalledExactlyOnceWith(42);
    expect(deps.exit).not.toHaveBeenCalled();
});

it('ignores a hold from an engine with no switch pending', () => {
    const {deps,refresh}=fixture();
    refresh.hold();
    expect(deps.pause).not.toHaveBeenCalled();
});

it('keeps looking for a boundary a turn that ended badly never reported', async () => {
    vi.useFakeTimers();
    try {
        const {deps,refresh}=fixture(); deps.isIdle.mockReturnValue(false);
        const watched=new SafeSessionRefresh(deps, 1000);
        await watched.request();
        expect(deps.prepare).not.toHaveBeenCalled();
        // Nothing calls drain again: onReady never ran, and the session sits
        // looking idle to everyone but this predicate.
        deps.isIdle.mockReturnValue(true);
        await vi.advanceTimersByTimeAsync(1000);
        expect(deps.prepare).toHaveBeenCalledTimes(1);
        // And it stops once the session has handed off.
        await vi.advanceTimersByTimeAsync(5000);
        expect(deps.prepare).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
});

it('says what it is waiting on, and says so again when that changes', async () => {
    const {deps,refresh}=fixture(); deps.isIdle.mockReturnValue(false);
    const blocker=vi.fn(()=>'等 2 个后台任务结束');
    const named=new SafeSessionRefresh({...deps,idleBlocker:blocker}, 0);
    await named.request();
    expect(deps.state).toHaveBeenCalledWith('queued','等 2 个后台任务结束');
    // Unchanged is not republished: the banner would flicker on every drain.
    deps.state.mockClear(); await named.drain();
    expect(deps.state).not.toHaveBeenCalled();
    blocker.mockReturnValue('等你回复权限请求'); await named.drain();
    expect(deps.state).toHaveBeenCalledExactlyOnceWith('queued','等你回复权限请求');
});

it('says nothing in particular when the runtime cannot name a blocker', async () => {
    const {deps,refresh}=fixture(); deps.isIdle.mockReturnValue(false);
    await refresh.request();
    expect(deps.state).toHaveBeenCalledWith('queued',undefined);
});

it('marks the login check as its own stage and clears it however the check ends', async () => {
    const { deps, refresh } = fixture();
    const stage = vi.fn(async (_s: 'preflight' | null) => {});
    const withStage = new SafeSessionRefresh({ ...deps, stage });
    await withStage.request('codex');
    expect(stage.mock.calls.map(([s]) => s)).toEqual(['preflight', null]);
    deps.preflight.mockRejectedValueOnce(new Error('offline'));
    stage.mockClear();
    const failing = new SafeSessionRefresh({ ...deps, stage });
    await failing.request('codex');
    expect(stage.mock.calls.map(([s]) => s)).toEqual(['preflight', null]);
});

it('passes the auth kind through when the login check is what failed', async () => {
    const { deps, refresh } = fixture();
    const { EngineAuthPreflightError } = await import('./refreshErrors');
    deps.preflight.mockRejectedValueOnce(new EngineAuthPreflightError('codex 尚未登录', 'codex'));
    await refresh.request('codex');
    expect(deps.state).toHaveBeenLastCalledWith('error', 'codex 尚未登录', 'auth');
});

it('cancels a queued switch, restoring a held cursor and reporting which engine it was going to', async () => {
    const { deps, refresh } = fixture(); deps.isIdle.mockReturnValue(false);
    await refresh.request('codex');
    refresh.hold();
    expect(await refresh.cancel()).toBe('codex');
    expect(refresh.pending).toBe(false);
    expect(deps.resume).toHaveBeenCalledWith(42);
    expect(deps.state).toHaveBeenLastCalledWith('applied');
    // Nothing left to drain, and a later request is taken fresh.
    deps.isIdle.mockReturnValue(true); await refresh.drain();
    expect(deps.prepare).not.toHaveBeenCalled();
    await refresh.request();
    expect(deps.prepare).toHaveBeenCalledExactlyOnceWith(42, undefined);
});

it('refuses to cancel once the boundary work has started', async () => {
    const { deps, refresh } = fixture();
    let resolveDrain!: () => void;
    let enteredDrain!: () => void;
    const entered = new Promise<void>(r => { enteredDrain = r; });
    deps.drain.mockImplementationOnce(() => { enteredDrain(); return new Promise<void>(r => { resolveDrain = r; }); });
    const running = refresh.request('codex');
    await entered;
    expect(await refresh.cancel()).toBeUndefined();
    resolveDrain(); await running;
    expect(deps.exit).toHaveBeenCalledTimes(1);
});

it('reports nothing to cancel when nothing is queued', async () => {
    const { refresh } = fixture();
    expect(await refresh.cancel()).toBeUndefined();
});

it('names the step an untagged failure happened in', async () => {
    const { deps, refresh } = fixture();
    deps.prepare.mockRejectedValueOnce(new Error('daemon offline'));
    await refresh.request();
    expect(deps.state).toHaveBeenLastCalledWith('error', 'daemon offline', 'relaunch');
});

it('gives up a plain refresh held only by standing background work, and keeps waiting otherwise', async () => {
    const { deps } = fixture();
    let now = 0; let standing = true;
    const refresh = new SafeSessionRefresh({ ...deps, standingBlocker: () => standing }, 0, 300_000, () => now);
    deps.isIdle.mockReturnValue(false);
    await refresh.request();
    now = 299_000; await refresh.drain();
    expect(refresh.pending).toBe(true);
    // A turn or a queued message interrupts the wait; the clock starts over.
    standing = false; now = 400_000; await refresh.drain();
    standing = true; now = 500_000; await refresh.drain();
    now = 700_000; await refresh.drain();
    expect(refresh.pending).toBe(true);
    now = 800_000; await refresh.drain();
    expect(refresh.pending).toBe(false);
    expect(deps.state).toHaveBeenLastCalledWith('error', expect.stringContaining('后台任务仍在运行'));
    expect(deps.prepare).not.toHaveBeenCalled(); expect(deps.exit).not.toHaveBeenCalled();
    // Asking again starts a fresh wait rather than failing at once.
    await refresh.request(); expect(refresh.pending).toBe(true);
});

it('never gives up an engine switch a person asked for', async () => {
    const { deps } = fixture();
    let now = 0;
    const refresh = new SafeSessionRefresh({ ...deps, standingBlocker: () => true }, 0, 300_000, () => now);
    deps.isIdle.mockReturnValue(false);
    await refresh.request('codex');
    now = 3_600_000; await refresh.drain(); await refresh.drain();
    expect(refresh.pending).toBe(true);
    expect(deps.state).not.toHaveBeenCalledWith('error', expect.anything());
});

it('takes the session back when the engine declines to exit after the hand-off was prepared', async () => {
    const { deps, refresh } = fixture();
    deps.exit.mockRejectedValueOnce(new Error('engine kept its scheduled work'));
    await refresh.request();
    expect(deps.prepare).toHaveBeenCalledTimes(1);
    expect(deps.state).toHaveBeenLastCalledWith('error', 'engine kept its scheduled work', 'relaunch');
    expect(deps.resume).toHaveBeenCalledWith(42); // The cursor is released, so chat keeps arriving.
    expect(refresh.pending).toBe(false);
    expect(refresh.blocksSteering).toBe(false);
    await refresh.request(); // Not wedged: a later refresh can run.
    expect(deps.exit).toHaveBeenCalledTimes(2);
});

it('publishes a fresh queued receipt on retry even when the idle blocker is unchanged', async () => {
    for (const failure of ['preflight', 'prepare', 'exit'] as const) {
        const { deps, refresh } = fixture();
        deps[failure].mockRejectedValueOnce(new Error('original session preserved'));
        await refresh.request();
        expect(deps.state).toHaveBeenLastCalledWith('error', 'original session preserved', failure === 'preflight' ? 'preflight' : 'relaunch');

        deps.state.mockClear();
        let finishPreflight!: () => void;
        deps.preflight.mockImplementationOnce(() => new Promise<void>(resolve => { finishPreflight = resolve; }));
        const retried = refresh.request();
        await vi.waitFor(() => expect(finishPreflight).toBeDefined());
        try {
            // Clear the old failure/start time before waiting on login or exit.
            expect(deps.state).toHaveBeenNthCalledWith(1, 'queued', undefined);
            await refresh.request();
            expect(deps.state).toHaveBeenCalledTimes(1);
        } finally {
            finishPreflight();
            await retried;
        }
    }
});
