import { vi, describe, expect, it } from 'vitest';
// These modules now report through the translation layer, and i18n reads
// stored settings when it loads.
vi.mock('@/sync/persistence', () => ({ loadSettings: () => ({ settings: {} }) }));
import { collectRecentTargets } from './recentTargets';
import type { Machine, Session } from '@/sync/storageTypes';

const machine = (id: string, displayName: string): Machine => ({
    id, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, metadataVersion: 1, daemonStateVersion: 1,
    metadata: { displayName, host: `${id}.local`, platform: 'darwin', happyCliVersion: '1.2.9', happyHomeDir: '/h', homeDir: '/h' } as any,
    daemonState: null,
});

const session = (id: string, machineId: string | null, flavor: string, path: string | null, at: number, extra: Record<string, unknown> = {}): Session => ({
    id, seq: 1, createdAt: at, updatedAt: at, active: true, activeAt: at, metadataVersion: 1, agentStateVersion: 1,
    thinking: false, thinkingAt: 0, presence: 'online', agentState: null,
    metadata: { machineId, flavor, path, lastMeaningfulMessageAt: at, ...extra } as any,
});

describe('collectRecentTargets', () => {
    it('keeps one entry per device + project + engine, newest first', () => {
        const targets = collectRecentTargets({
            sessions: [
                session('a', 'm1', 'claude', '/Users/me/work/lmc', 100),
                session('b', 'm1', 'claude', '/Users/me/work/lmc', 500),
                session('c', 'm1', 'codex', '/Users/me/work/lmc', 300),
            ],
            machines: [machine('m1', 'MacMini')],
        });
        expect(targets.map((target) => [target.machineName, target.projectName, target.engine])).toEqual([
            ['MacMini', 'lmc', 'claude'],
            ['MacMini', 'lmc', 'codex'],
        ]);
        expect(targets[0].activityAt).toBe(500);
    });

    it('skips side chats and sessions with no machine or path, and honours the limit', () => {
        const targets = collectRecentTargets({
            sessions: [
                session('side', 'm1', 'claude', '/a', 900, { isSideChat: true }),
                session('nopath', 'm1', 'claude', null, 800),
                session('nomachine', null, 'claude', '/b', 700),
                session('x', 'm1', 'claude', '/c', 600),
                session('y', 'm1', 'claude', '/d', 500),
            ],
            machines: [machine('m1', 'MacMini')],
            limit: 1,
        });
        expect(targets.map((target) => target.projectName)).toEqual(['c']);
    });

    it('drops the combination already selected', () => {
        const targets = collectRecentTargets({
            sessions: [
                session('a', 'm1', 'claude', '/here', 900),
                session('b', 'm1', 'claude', '/there', 800),
            ],
            machines: [machine('m1', 'MacMini')],
            exclude: { machineId: 'm1', path: '/here' },
        });
        expect(targets.map((target) => target.path)).toEqual(['/there']);
    });

    it('falls back to the machine id when the machine is unknown', () => {
        const targets = collectRecentTargets({
            sessions: [session('a', 'ghost', 'codex', '/x/y', 10)],
            machines: [],
        });
        expect(targets[0].machineName).toBe('ghost');
        expect(targets[0].engineLabel).toBe('Codex');
    });
});
