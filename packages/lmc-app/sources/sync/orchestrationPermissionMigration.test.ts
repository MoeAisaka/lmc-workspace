import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metadata } from './storageTypes';

// Isolate storage/network I/O, not migration or permission derivation. This
// exercises the metadata updater's published value, not SDK or CAS timing.
const fixture = vi.hoisted(() => ({ sessions: {} as Record<string, { id: string; metadata: Metadata }> }));
vi.mock('./storage', () => ({ storage: { getState: () => fixture } }));
vi.mock('./ops', () => ({
    sessionUpdateMetadata: async (id: string, update: (metadata: Metadata) => Metadata) => {
        fixture.sessions[id].metadata = update(fixture.sessions[id].metadata);
    },
}));
import { migrateWorkers, unbindWorker } from './orchestration';
import { resolveWorkerPermissionMode } from './workerPermission';

function seed(flavor: string, autonomy: boolean | undefined, source: 'ambient' | 'explicit' = 'ambient', mode = 'default') {
    const base = { path: '/fixture', host: 'test', version: '1', flavor } as Metadata;
    fixture.sessions = {
        old: { id: 'old', metadata: { ...base, orchestration: { role: 'hub', workers: [{ sessionId: 'worker', boundAt: 1, by: 'manual' }] } } },
        next: { id: 'next', metadata: { ...base } },
        worker: { id: 'worker', metadata: { ...base, permissionMode: mode, permissionModeSource: source,
            orchestration: { role: 'worker', hub: { sessionId: 'old', boundAt: 1, by: 'manual', ...(autonomy !== undefined ? { autonomy } : {}) } } } },
    };
}

describe('worker permission across hub migration', () => {
    beforeEach(() => { fixture.sessions = {}; });

    it.each([['claude', 'bypassPermissions'], ['codex', 'yolo']])('retains the existing %s default, then revokes it on unbind', async (flavor, full) => {
        seed(flavor, true);
        expect(resolveWorkerPermissionMode(fixture.sessions.worker.metadata, flavor)).toBe(full);
        expect(await migrateWorkers('old', 'next')).toBe(1);
        expect(fixture.sessions.worker.metadata.orchestration).toMatchObject({ role: 'worker', hub: { sessionId: 'next', autonomy: true } });
        expect(resolveWorkerPermissionMode(fixture.sessions.worker.metadata, flavor)).toBe(full);
        expect(fixture.sessions.worker.metadata.permissionMode).toBe('default');
        await unbindWorker('worker');
        expect(resolveWorkerPermissionMode(fixture.sessions.worker.metadata, flavor)).toBe('default');
    });

    it.each([false, undefined])('does not authorize a worker whose existing autonomy is %s', async (autonomy) => {
        seed('codex', autonomy);
        await migrateWorkers('old', 'next');
        expect(resolveWorkerPermissionMode(fixture.sessions.worker.metadata, 'codex')).toBe('default');
        expect(fixture.sessions.worker.metadata.orchestration).not.toMatchObject({ hub: { autonomy: true } });
    });

    it.each(['claude', 'codex'])('preserves an explicit restricted pick on %s', async (flavor) => {
        seed(flavor, true, 'explicit', 'read-only');
        await migrateWorkers('old', 'next');
        expect(fixture.sessions.worker.metadata).toMatchObject({ permissionMode: 'read-only', permissionModeSource: 'explicit' });
        expect(resolveWorkerPermissionMode(fixture.sessions.worker.metadata, flavor)).toBe('read-only');
    });

    it('does not convert unsupported engine permissions into either full-allow spelling', async () => {
        seed('gemini', true);
        await migrateWorkers('old', 'next');
        expect(resolveWorkerPermissionMode(fixture.sessions.worker.metadata, 'gemini')).toBe('default');
    });
});
