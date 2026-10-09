import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActiveSessionJournal, StartupSessionRecovery } from './sessionRecovery';
import type { Metadata } from '@/api/types';
import type { SessionRefreshOptions } from './sessionRefresh';

const dirs: string[] = [];
function setup(engine: 'claude' | 'codex' = 'codex') {
    const dir = mkdtempSync(join(tmpdir(), 'lmc-recovery-')); dirs.push(dir);
    const file = join(dir, 'active-sessions.json');
    const journal = new ActiveSessionJournal(file); journal.remember('original', 123);
    const metadata = { machineId: 'machine', lifecycleState: 'running', flavor: engine, path: '/fixture',
        codexThreadId: engine === 'codex' ? 'original-thread' : undefined,
        claudeSessionId: engine === 'claude' ? 'original-thread' : undefined,
        modelMode: 'same-model', effortLevel: 'medium', permissionMode: engine === 'codex' ? 'yolo' : 'default',
        codexServiceTier: engine === 'codex' ? 'fast' : undefined,
    } as Metadata;
    const ports = { journal: new ActiveSessionJournal(file), machineId: 'machine',
        live: vi.fn(async (_id: string) => false), busy: vi.fn((_id: string) => false), stopping: vi.fn(() => false),
        metadata: vi.fn(async (_id: string) => metadata as Metadata | null),
        resume: vi.fn(async (_id: string, _metadata: Metadata, _options: SessionRefreshOptions, _canStart: () => boolean) => { journal.remember('original', 456); }),
        error: vi.fn(),
    };
    return { file, journal, ports, recovery: new StartupSessionRecovery(ports) };
}
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

it.each(['claude', 'codex'] as const)('restores only recorded running %s, preserving its thread and choices', async engine => {
    const { ports, recovery } = setup(engine); await recovery.run(); await recovery.run();
    expect(ports.resume).toHaveBeenCalledTimes(1);
    expect(ports.resume).toHaveBeenCalledWith('original', expect.objectContaining({ flavor: engine }),
        expect.objectContaining({ model: 'same-model', effort: 'medium', permissionMode: engine === 'codex' ? 'yolo' : 'default' }), expect.any(Function));
    expect(ports.resume.mock.calls[0][2]).not.toHaveProperty('engine');
    expect(ports.resume.mock.calls[0][2]).not.toHaveProperty('receiveSeq');
});
it('stores only operational IDs and PIDs, never keys, prompts or provider records', () => {
    const { file } = setup(); expect(JSON.parse(readFileSync(file, 'utf8')))
        .toEqual({ version: 1, sessions: [{ sessionId: 'original', pid: 123 }] });
});
it('does not resurrect a deliberately stopped session or erase its replacement on a late exit', async () => {
    const { journal, file, ports } = setup(); journal.remember('original', 456); journal.forget('original', 123);
    expect(new ActiveSessionJournal(file).list()).toEqual([{ sessionId: 'original', pid: 456 }]);
    journal.forget('original', 456);
    await new StartupSessionRecovery({ ...ports, journal: new ActiveSessionJournal(file) }).run();
    expect(ports.resume).not.toHaveBeenCalled();
});
it.each(['archived', 'archiveRequested'])('drops %s sessions after fresh inspection', async lifecycleState => {
    const { ports, recovery } = setup(); ports.metadata.mockResolvedValue({ ...await ports.metadata('original'), lifecycleState } as Metadata);
    await recovery.run(); expect(ports.resume).not.toHaveBeenCalled(); expect(ports.journal.list()).toEqual([]);
});
it('never duplicates a live orphan or an in-flight refresh', async () => {
    const live = setup(); live.ports.live.mockResolvedValue(true); await live.recovery.run(); expect(live.ports.resume).not.toHaveBeenCalled();
    const busy = setup(); busy.ports.busy.mockReturnValue(true); await busy.recovery.run(); expect(busy.ports.resume).not.toHaveBeenCalled();
    busy.ports.busy.mockReturnValue(false); await busy.recovery.run(); expect(busy.ports.resume).toHaveBeenCalledTimes(1);
});
it.each(['wrong-machine', 'missing-thread', 'unsupported'])('fails closed for %s', async reason => {
    const { ports, recovery } = setup(); const metadata = (await ports.metadata('original'))!;
    ports.metadata.mockResolvedValue({ ...metadata, ...(reason === 'wrong-machine' ? { machineId: 'other' }
        : reason === 'missing-thread' ? { codexThreadId: undefined } : { flavor: 'gemini' }) } as Metadata);
    await recovery.run(); expect(ports.resume).not.toHaveBeenCalled(); expect(ports.error).toHaveBeenCalledTimes(1);
});
it('retries an unavailable server, retaining intent and bounding failed launch attempts', async () => {
    const { ports, recovery } = setup(); ports.metadata.mockResolvedValueOnce(null);
    await recovery.run(); expect(ports.journal.list()).toHaveLength(1); expect(ports.resume).not.toHaveBeenCalled();
    await recovery.run(); expect(ports.resume).toHaveBeenCalledTimes(1);
    const failing = setup(); failing.ports.resume.mockRejectedValue(new Error('backend unavailable'));
    for (let n = 0; n < 5; n++) await failing.recovery.run();
    expect(failing.ports.resume).toHaveBeenCalledTimes(3); expect(failing.ports.journal.list()).toHaveLength(1);
});
it('serializes retries and rechecks shutdown after metadata arrives', async () => {
    const { ports, recovery } = setup(); let release!: (m: Metadata | null) => void;
    ports.metadata.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const first = recovery.run(); await vi.waitFor(() => expect(ports.metadata).toHaveBeenCalled());
    await recovery.run(); ports.stopping.mockReturnValue(true);
    release({ machineId: 'machine', flavor: 'codex', codexThreadId: 'thread', lifecycleState: 'running' } as Metadata);
    await first; expect(ports.resume).not.toHaveBeenCalled();
});
it('honors an explicit stop while awaiting server metadata', async () => {
    const { ports, journal, recovery } = setup(); let release!: (m: Metadata | null) => void;
    const metadata = await ports.metadata('original');
    ports.metadata.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const first = recovery.run(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    journal.forget('original'); release(metadata); await first;
    expect(ports.resume).not.toHaveBeenCalled();
});
it('revokes the final launch permission if stop arrives during process discovery', async () => {
    const { ports, journal, recovery } = setup();
    ports.resume.mockImplementation(async (_id, _metadata, _options, canStart) => {
        expect(canStart()).toBe(true);
        journal.forget('original');
        expect(canStart()).toBe(false);
    });
    await recovery.run(); expect(ports.resume).toHaveBeenCalledTimes(1);
});
it('does not add newly started sessions to the startup recovery snapshot', async () => {
    const { ports, journal, recovery } = setup(); journal.remember('new-session', 789);
    await recovery.run(); await recovery.run();
    expect(ports.resume).toHaveBeenCalledTimes(1);
    expect(ports.resume.mock.calls[0][0]).toBe('original');
});
it('preserves a corrupt journal and refuses speculative recovery', async () => {
    const { file, ports } = setup(); writeFileSync(file, '{invalid');
    await new StartupSessionRecovery(ports).run();
    expect(ports.error).toHaveBeenCalledTimes(1);
    expect(ports.resume).not.toHaveBeenCalled();
    expect(readFileSync(file, 'utf8')).toBe('{invalid');
});
