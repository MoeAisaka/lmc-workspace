import { vi, describe, expect, it } from 'vitest';
// These modules now report through the translation layer, and i18n reads
// stored settings when it loads.
vi.mock('@/sync/persistence', () => ({ loadSettings: () => ({ settings: {} }) }));
import { buildDeviceEngineGroups, collectArchivedSessions, flattenDeviceSessions, projectGroupIdForSession } from './deviceEngineGroups';
import type { Machine, Session } from '@/sync/storageTypes';
import { listArchiveRule } from '@/sync/sessionArchive';

const machine = (id: string, extra: Partial<Machine> = {}): Machine => ({
    id, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, metadataVersion: 1, daemonStateVersion: 1,
    metadata: { host: `${id}.local`, platform: 'darwin', happyCliVersion: '1.2.9', happyHomeDir: '/h', homeDir: '/h' } as any,
    daemonState: { startedWithCliVersion: '1.2.10' }, ...extra,
});
const session = (id: string, machineId: string | null, flavor: string, extra: Partial<Session> = {}): Session => ({
    id, seq: 1, createdAt: 100, updatedAt: 100, active: true, activeAt: 100, metadataVersion: 1, agentStateVersion: 1,
    thinking: false, thinkingAt: 0, presence: 'online', agentState: null,
    metadata: { machineId, flavor, path: '/p', lastMeaningfulMessageAt: 100 } as any, ...extra,
});

describe('buildDeviceEngineGroups', () => {
    it('classifies native Antigravity and its alias without absorbing unknown providers', () => {
        const [g] = buildDeviceEngineGroups([
            session('a', 'm', 'agy'), session('b', 'm', 'antigravity'),
            session('c', 'm', 'codex'), session('d', 'm', 'claude'), session('e', 'm', 'future'),
        ], [machine('m')]);
        expect(g.engines.map(e => [e.key, e.label])).toEqual([
            ['claude', 'Claude'], ['codex', 'Codex'], ['agy', 'Antigravity'], ['other', 'Other'],
        ]);
        expect(g.engines.find(e => e.key === 'agy')?.sessions.map(s => s.id)).toEqual(['a', 'b']);
    });
    it('labels a privately owned run on a shared device without exposing device management', () => {
        const run = session('run', 'host', 'codex', { metadata: { machineId: 'host', flavor: 'codex', host: 'Shared Mac', sharedDevice: true } as any });
        const [group] = buildDeviceEngineGroups([run], []);
        expect(group).toMatchObject({ name: 'Shared Mac', shared: false, sharedDevice: true, online: true, agentVersion: null });
        expect(buildDeviceEngineGroups([{ ...run, presence: 100 }], [])[0].online).toBe(false);
    });
    it('places a read-only grant outside private device groups and does not ask its reader for approvals', () => {
        const shared = session('shared', 'private-host', 'codex', { shared: true, agentState: { requests: { r: { tool: 'Bash', arguments: {} } } } as any });
        const groups = buildDeviceEngineGroups([shared, session('owned', 'private-host', 'codex')], [machine('private-host')]);
        expect(groups).toHaveLength(2);
        const group = groups.find(g => g.shared)!;
        expect(group.name).toBe('共享会话');
        expect(group.attentionCount).toBe(0);
        expect(group.agentVersion).toBeNull();
        expect(group.engines[0].sessions.map(s => s.id)).toEqual(['shared']);
        expect(groups.find(g => !g.shared)!.engines[0].sessions.map(s => s.id)).toEqual(['owned']);
    });

    it('groups device → engine → session, Claude before Codex, oldest first', () => {
        // Ordered by creation, never by activity: the list is the user's to
        // arrange, so a session that starts working must not jump the queue.
        const groups = buildDeviceEngineGroups([
            session('a', 'm1', 'codex'),
            session('b', 'm1', 'claude', { createdAt: 50, metadata: { machineId: 'm1', flavor: 'claude', lastMeaningfulMessageAt: 50 } as any }),
            session('c', 'm1', 'claude', { createdAt: 10, metadata: { machineId: 'm1', flavor: 'claude', lastMeaningfulMessageAt: 500 } as any }),
        ], [machine('m1', { metadata: { displayName: 'MacMini', host: 'x', platform: 'darwin', happyCliVersion: '1.2.9', happyHomeDir: '/h', homeDir: '/h' } as any })]);
        expect(groups).toHaveLength(1);
        expect(groups[0].name).toBe('MacMini');
        expect(groups[0].agentVersion).toBe('1.2.10');
        expect(groups[0].engines.map((e) => e.key)).toEqual(['claude', 'codex']);
        expect(groups[0].engines[0].sessions.map((s) => s.id)).toEqual(['c', 'b']);
    });

    it('counts sessions that need a reply without letting it reorder the devices', () => {
        const waiting = session('w', 'm2', 'claude', { agentState: { requests: { r1: { tool: 'Bash', arguments: { command: 'ls' } } } } as any });
        const groups = buildDeviceEngineGroups([waiting, session('z', 'm1', 'claude')], [machine('m1', { active: false }), machine('m2')]);
        // By name, so neither going offline nor needing a reply moves a device.
        expect(groups.map((g) => g.machineId)).toEqual(['m1', 'm2']);
        expect(groups.find((g) => g.machineId === 'm2')!.attentionCount).toBe(1);
        expect(groups.find((g) => g.machineId === 'm1')!.online).toBe(false);
    });

    it('hides archived sessions and side chats, but lists an idle paired device', () => {
        const groups = buildDeviceEngineGroups([
            session('arch', 'm1', 'claude', { metadata: { machineId: 'm1', flavor: 'claude', lifecycleState: 'archived' } as any }),
            session('side', 'm1', 'claude', { metadata: { machineId: 'm1', flavor: 'claude', isSideChat: true } as any }),
        ], [machine('m1')]);
        expect(groups).toHaveLength(1);
        expect(groups[0].engines).toEqual([]);
    });

    it('keeps a disconnected legacy CLI session in its device group', () => {
        const dead = session('dead', 'm1', 'claude', { active: false });
        const groups = buildDeviceEngineGroups([dead, session('live', 'm1', 'claude')], [machine('m1')]);
        expect(groups[0].engines[0].sessions.map((s) => s.id)).toEqual(['dead', 'live']);
        expect(collectArchivedSessions([dead, session('live', 'm1', 'claude')])).toEqual([]);
    });

    it('files what the list counts as archived under archived, not under its device', () => {
        const gone = session('gone', 'm1', 'claude', { active: false, metadata: { machineId: 'm1', flavor: 'claude', path: '/p', lifecycleState: 'running', lastMeaningfulMessageAt: 100 } as any });
        const live = session('live', 'm1', 'claude');
        const isArchived = (s: Session) => s.id === 'gone';
        expect(buildDeviceEngineGroups([gone, live], [machine('m1')])[0].engines[0].sessions.map((s) => s.id)).toEqual(['gone', 'live']);
        expect(buildDeviceEngineGroups([gone, live], [machine('m1')], { isArchived })[0].engines[0].sessions.map((s) => s.id)).toEqual(['live']);
        expect(collectArchivedSessions([gone, live], isArchived).map((s) => s.id)).toEqual(['gone']);
    });

    it('keeps disconnected Claude and Codex sessions on their offline device until explicitly archived', () => {
        const rows = ['claude', 'codex'].map(flavor => session(flavor, 'm1', flavor, {
            active: false, presence: 100,
            metadata: { machineId: 'm1', flavor, lifecycleState: 'running' } as any,
        }));
        const groups = buildDeviceEngineGroups(rows, [machine('m1', { active: false })]);
        expect(groups).toHaveLength(1);
        expect(groups[0].online).toBe(false);
        expect(flattenDeviceSessions(groups[0]).map(s => s.id)).toEqual(['claude', 'codex']);
        expect(collectArchivedSessions(rows)).toEqual([]);
        const archived = rows.map(s => ({ ...s, metadata: { ...s.metadata!, lifecycleState: 'archived' } }));
        expect(buildDeviceEngineGroups(archived, [machine('m1', { active: false })])).toEqual([]);
        expect(collectArchivedSessions(archived)).toHaveLength(2);
    });

    it.each(['claude', 'codex'])('keeps long-disconnected %s sessions, except on removed devices', (flavor) => {
        const gone = session('gone', 'm1', flavor, { active: false, activeAt: 1, presence: 1,
            metadata: { machineId: 'm1', flavor, lifecycleState: 'running' } as any });
        for (const machines of [[machine('m1')], [machine('m1', { active: false })], []]) {
            const isArchived = listArchiveRule(machines);
            const groups = buildDeviceEngineGroups([gone], machines, { isArchived });
            expect(groups.flatMap(flattenDeviceSessions).map(s => s.id)).toEqual(['gone']);
            expect(collectArchivedSessions([gone], isArchived)).toEqual([]);
        }
        const machines = [machine('other')];
        const isArchived = listArchiveRule(machines);
        expect(buildDeviceEngineGroups([gone], machines, { isArchived }).flatMap(flattenDeviceSessions)).toEqual([]);
        expect(collectArchivedSessions([gone], isArchived).map(s => s.id)).toEqual(['gone']);
    });

    it('drops an offline device that has no sessions left', () => {
        const groups = buildDeviceEngineGroups([session('a', 'm1', 'claude')], [machine('m1'), machine('old', { active: false })]);
        expect(groups.map((g) => g.machineId)).toEqual(['m1']);
        expect(buildDeviceEngineGroups([], [machine('old', { active: false })], { hideIdleOfflineDevices: false })).toHaveLength(1);
    });

    it('derives the same project-group id the avatar overrides were saved under', () => {
        expect(projectGroupIdForSession(session('a', 'm1', 'claude', { metadata: { machineId: 'm1', path: '/repo' } as any })))
            .toBe('happy:["m1","/repo"]');
        expect(projectGroupIdForSession(session('b', 'm1', 'claude', { metadata: { machineId: 'm1', client: { id: 'rig' }, project: { id: 'p1', name: 'P' } } as any })))
            .toBe('p1');
    });

    it('puts sessions without a machine under an unknown-device group', () => {
        const groups = buildDeviceEngineGroups([session('x', null, 'gemini')], []);
        expect(groups[0].machineId).toBeNull();
        expect(groups[0].engines[0].key).toBe('other');
    });

    it('breaks equal names and creation times consistently across clients', () => {
        const rows = [session('b', 'm1', 'claude'), session('a', 'm1', 'claude'), session('c', 'm1', 'codex')];
        const devices = [machine('m2', { metadata: { displayName: 'Same device' } as any }), machine('m1', { metadata: { displayName: 'Same device' } as any })];
        for (const [sessions, machines] of [[rows, devices], [[...rows].reverse(), [...devices].reverse()]] as [Session[], Machine[]][]) {
            const groups = buildDeviceEngineGroups(sessions, machines);
            expect(groups.map(g => g.machineId)).toEqual(['m1', 'm2']);
            expect(groups[0].engines[0].sessions.map(s => s.id)).toEqual(['a', 'b']);
            expect(flattenDeviceSessions(groups[0]).map(s => s.id)).toEqual(['a', 'b', 'c']);
        }
        expect(buildDeviceEngineGroups([], devices).map(g => g.machineId)).toEqual(['m1', 'm2']);
        expect(buildDeviceEngineGroups([], [...devices].reverse()).map(g => g.machineId)).toEqual(['m1', 'm2']);
    });

    it('does not use device-local send times to order archived sessions', () => {
        const rows = [
            session('older', 'm1', 'claude', { active: false, createdAt: 10, lastMessageSentAt: 1000, metadata: { lifecycleState: 'archived' } as any }),
            session('newer', 'm1', 'codex', { active: false, createdAt: 20, metadata: { lifecycleState: 'archived' } as any }),
            session('latest-activity', 'm1', 'claude', { active: false, createdAt: 5, metadata: { lifecycleState: 'archived', lastMeaningfulMessageAt: 50 } as any }),
        ];
        const expected = ['latest-activity', 'newer', 'older'];
        expect(collectArchivedSessions(rows).map(s => s.id)).toEqual(expected);
        expect(collectArchivedSessions(rows.map(s => ({ ...s, lastMessageSentAt: undefined }))).map(s => s.id)).toEqual(expected);
    });
});

describe('flattenDeviceSessions', () => {
    it('interleaves engines by creation time instead of listing one engine after the other', () => {
        const group = {
            machineId: 'm1', name: 'MacMini', online: true, agentVersion: null, attentionCount: 0,
            engines: [
                { key: 'claude' as const, label: 'Claude', sessions: [{ id: 'c1', createdAt: 10 }, { id: 'c2', createdAt: 30 }] as any },
                { key: 'codex' as const, label: 'Codex', sessions: [{ id: 'x1', createdAt: 20 }] as any },
            ],
        };
        expect(flattenDeviceSessions(group).map((s) => s.id)).toEqual(['c1', 'x1', 'c2']);
    });
});
