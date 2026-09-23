import { describe, it, expect, vi } from 'vitest';
import { realpathSync } from 'node:fs';
import { findLiveSessionProcess, findOrphanedSessionPid, SingleFlight, findProviderSessionPid } from './sessionSpawnGuard';
import type { TrackedSession } from './types';

vi.mock('node:fs', () => ({ realpathSync: vi.fn(() => '/Volumes/External Disk/LMC-runtime/runtime/agent-releases') }));

const tracked = (pid: number, happySessionId?: string): TrackedSession => ({
    startedBy: 'daemon',
    pid,
    happySessionId,
});

describe('findLiveSessionProcess', () => {
    it('finds the live process that already owns the session', () => {
        const map = new Map([[52272, tracked(52272, 'sessionA')]]);
        expect(findLiveSessionProcess(map, 'sessionA', () => true)).toBe(map.get(52272));
    });

    it('ignores processes belonging to other sessions', () => {
        const map = new Map([[52272, tracked(52272, 'sessionB')]]);
        expect(findLiveSessionProcess(map, 'sessionA', () => true)).toBeUndefined();
    });

    it('ignores a tracked entry that has not reported its session yet', () => {
        const map = new Map([[52272, tracked(52272)]]);
        expect(findLiveSessionProcess(map, 'sessionA', () => true)).toBeUndefined();
    });

    it('reaps a dead pid instead of treating it as an owner', () => {
        // Externally-started sessions get no exit handler, so a stale entry can
        // outlive its process and would otherwise block resume forever.
        const map = new Map([[52272, tracked(52272, 'sessionA')]]);
        const onReap = vi.fn();

        expect(findLiveSessionProcess(map, 'sessionA', () => false, onReap)).toBeUndefined();
        expect(map.has(52272)).toBe(false);
        expect(onReap).toHaveBeenCalledWith(52272);
    });

    it('reaps a dead duplicate and still finds the live owner', () => {
        const map = new Map([
            [52272, tracked(52272, 'sessionA')],
            [52298, tracked(52298, 'sessionA')],
        ]);

        const live = findLiveSessionProcess(map, 'sessionA', (pid) => pid === 52298);

        expect(live?.pid).toBe(52298);
        expect(map.has(52272)).toBe(false);
    });
});

describe('SingleFlight', () => {
    it('collapses concurrent calls for the same key', async () => {
        const flight = new SingleFlight<string>();
        const task = vi.fn(async () => 'spawned');
        const onJoin = vi.fn();

        const [first, second] = await Promise.all([
            flight.run('sessionA', task),
            flight.run('sessionA', task, onJoin),
        ]);

        expect(task).toHaveBeenCalledTimes(1);
        expect(first).toBe('spawned');
        expect(second).toBe('spawned');
        expect(onJoin).toHaveBeenCalledTimes(1);
    });

    it('keeps different keys independent', async () => {
        const flight = new SingleFlight<string>();
        const task = vi.fn(async (id: string) => id);

        await Promise.all([
            flight.run('sessionA', () => task('sessionA')),
            flight.run('sessionB', () => task('sessionB')),
        ]);

        expect(task).toHaveBeenCalledTimes(2);
    });

    it('releases the key once settled so a later resume can run', async () => {
        const flight = new SingleFlight<string>();
        const task = vi.fn(async () => 'spawned');

        await flight.run('sessionA', task);
        await flight.run('sessionA', task);

        expect(task).toHaveBeenCalledTimes(2);
        expect(flight.size).toBe(0);
    });

    it('does not wedge the key when the resume fails', async () => {
        const flight = new SingleFlight<string>();

        await expect(flight.run('sessionA', async () => { throw new Error('boom'); }))
            .rejects.toThrow('boom');

        expect(flight.size).toBe(0);
        await expect(flight.run('sessionA', async () => 'spawned')).resolves.toBe('spawned');
    });
});

describe('findOrphanedSessionPid', () => {
    const persisted = (hostPid?: number): TrackedSession => ({
        startedBy: 'persisted',
        pid: 0,
        happySessionId: 'sessionA',
        happySessionMetadataFromLocalWebhook: { hostPid } as TrackedSession['happySessionMetadataFromLocalWebhook'],
    });

    const happyCmd = '/opt/node /Volumes/WorkSSD/DevCaches/npm-global/lib/node_modules/happy/dist/index.mjs claude --resume abc';

    it('recovers a session left running by a previous daemon', async () => {
        const found = await findOrphanedSessionPid(persisted(52272), async () => [
            { pid: 52272, name: 'node', cmd: happyCmd },
        ]);
        expect(found).toBe(52272);
    });

    it('ignores a recycled pid that is not a happy process', async () => {
        const found = await findOrphanedSessionPid(persisted(52272), async () => [
            { pid: 52272, name: 'Safari', cmd: '/Applications/Safari.app/Contents/MacOS/Safari' },
        ]);
        expect(found).toBeUndefined();
    });

    it('reports nothing when the pid is gone', async () => {
        expect(await findOrphanedSessionPid(persisted(52272), async () => [])).toBeUndefined();
    });

    it('reports nothing without a persisted hostPid', async () => {
        expect(await findOrphanedSessionPid(persisted(undefined), async () => [
            { pid: 52272, name: 'node', cmd: happyCmd },
        ])).toBeUndefined();
        expect(await findOrphanedSessionPid(undefined, async () => [])).toBeUndefined();
    });

    it('blocks a resume when ownership cannot be checked', async () => {
        await expect(findOrphanedSessionPid(persisted(52272), async () => {
            throw new Error('ps unavailable');
        })).rejects.toThrow('Cannot verify existing session process');
    });

    it('refuses a duplicate when the process exists but its command is unavailable', async () => {
        await expect(findOrphanedSessionPid(persisted(52272), async () => [
            { pid: 52272, name: 'node' },
        ])).rejects.toThrow('Cannot verify existing session process');
    });

    it.each([
        '/opt/node /opt/happy/dist/codex/happyMcpStdioBridge.mjs',
        '/opt/happy/bin/codex app-server --listen stdio://',
        '/opt/node /opt/happy/dist/index.mjs daemon start-sync',
        '/opt/node /opt/happy/dist/index.mjs mcp',
        '/opt/node /opt/unrelated/dist/index.mjs codex',
        '/opt/node /opt/other.mjs /opt/happy/dist/index.mjs codex',
    ])('does not mistake an engine, helper or daemon for a session: %s', async (cmd) => {
        expect(await findOrphanedSessionPid(persisted(52272), async () => [
            { pid: 52272, name: 'happy', cmd },
        ])).toBeUndefined();
    });

    it.each([
        '/opt/node --no-warnings --no-deprecation /opt/happy/dist/index.mjs codex --resume abc',
        '/opt/node /Volumes/Work SSD/happy-cli/dist/index.mjs claude --resume abc',
        '/opt/node /opt/happy/dist/index.mjs --happy-starting-mode remote --resume abc',
    ])('recognizes the actual session wrapper: %s', async (cmd) => {
        expect(await findOrphanedSessionPid(persisted(52272), async () => [
            { pid: 52272, name: 'node', cmd },
        ])).toBe(52272);
    });
});

it('recognizes both engines in the deployed LMC MacBook release layout', async () => {
    const session = { ...tracked(0, 's'), startedBy:'persisted' as const, happySessionMetadataFromLocalWebhook:{hostPid:123} } as TrackedSession;
    for (const engine of ['claude','codex']) {
        expect(await findOrphanedSessionPid(session, async()=>[{pid:123,name:'node',cmd:`/opt/homebrew/bin/node /Users/example/.lmc/agent-releases/264176f/dist/index.mjs ${engine} --started-by daemon`}])).toBe(123);
    }
    expect(await findOrphanedSessionPid(session, async()=>[{pid:123,name:'node',cmd:'/opt/homebrew/bin/node /tmp/264176f/dist/index.mjs claude'}])).toBeUndefined();
});

describe('finding a wrapper by the conversation it resumes', () => {
    const thread = '01a065e8-aac8-7ef3-a3cc-098842743c67';
    const wrapper = (pid: number, id: string) => ({
        pid,
        cmd: `node --no-warnings /Users/y/.lmc/agent-releases/upgrades-20260907-v10/dist/index.mjs codex --resume ${id} --started-by daemon`,
    });

    it('finds a replacement neither the map nor the persisted pid knows', () => {
        expect(findProviderSessionPid([wrapper(73682, thread)], thread)).toBe(73682);
    });

    it('ignores the engine process that resumes the same conversation', () => {
        const engine = { pid: 999, cmd: `/Users/y/.lmc/agent/runtime-releases/codex-0.153.4/bin/codex.js app-server --resume ${thread}` };
        expect(findProviderSessionPid([engine], thread)).toBeUndefined();
    });

    it('leaves a wrapper that belongs to a different session alone', () => {
        const owned = new Set([73682]);
        expect(findProviderSessionPid([wrapper(73682, thread)], thread, pid => owned.has(pid))).toBeUndefined();
    });

    it('matches the whole id, never a prefix of a longer one', () => {
        expect(findProviderSessionPid([wrapper(1, thread + '-forked')], thread)).toBeUndefined();
        expect(findProviderSessionPid([wrapper(2, thread)], thread.slice(0, 12))).toBeUndefined();
    });

    it('refuses ids too short or too odd to be a conversation', () => {
        for (const id of [undefined, '', 'abc', '../../etc', 'a b c', '.*']) {
            expect(findProviderSessionPid([wrapper(3, String(id))], id as any)).toBeUndefined();
        }
    });
});


describe('relocated Agent releases', () => {
    const root = '/Volumes/External Disk/LMC-runtime/runtime/agent-releases';
    const thread = '01a0ace8-a4f4-7b03-bca9-377ee29d301a';
    const session = { ...tracked(0, 's'), startedBy: 'persisted' as const,
        happySessionMetadataFromLocalWebhook: { hostPid: 123 } } as TrackedSession;
    const processAt = (entry: string, args: string) => ({ pid: 123, name: 'node',
        cmd: `node --no-warnings --no-deprecation ${entry} ${args}` });

    it.each(['claude', 'codex'])('recognizes %s under the resolved installation root', async engine => {
        const proc = processAt(`${root}/upgrades-20260922-v2/dist/index.mjs`, `${engine} --resume ${thread}`);
        expect(await findOrphanedSessionPid(session, async () => [proc])).toBe(123);
        expect(findProviderSessionPid([proc], thread)).toBe(123);
    });

    it.each([
        [root + '/upgrades-20260922-v2/dist/index.mjs', 'daemon start-sync'],
        [root + '/upgrades-20260922-v2/dist/index.mjs', 'mcp'],
        [root + '/upgrades-20260922-v2/dist/codex/bridge.mjs', 'codex'],
        ['/tmp/agent-releases/upgrades-20260922-v2/dist/index.mjs', 'codex'],
        ['/Volumes/Other Disk/LMC-runtime/runtime/agent-releases/v1/dist/index.mjs', 'claude'],
        ['/opt/helper.mjs', root + '/upgrades-20260922-v2/dist/index.mjs codex'],
    ])('rejects non-session or unconfigured relocated entry %s %s', async (entry, args) => {
        const proc = processAt(entry, `${args} --resume ${thread}`);
        expect(await findOrphanedSessionPid(session, async () => [proc])).toBeUndefined();
        expect(findProviderSessionPid([proc], thread)).toBeUndefined();
    });
});

it('fails closed when the relocated installation cannot be resolved', async () => {
    vi.mocked(realpathSync).mockImplementationOnce(() => { throw new Error('volume unavailable'); });
    const session = { ...tracked(0, 's'), startedBy: 'persisted' as const,
        happySessionMetadataFromLocalWebhook: { hostPid: 123 } } as TrackedSession;
    expect(await findOrphanedSessionPid(session, async () => [{ pid: 123,
        cmd: 'node /Volumes/External Disk/LMC-runtime/runtime/agent-releases/v1/dist/index.mjs codex' }])).toBeUndefined();
});
