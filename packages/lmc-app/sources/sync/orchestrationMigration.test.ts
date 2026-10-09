import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metadata } from './storageTypes';

const fixture = vi.hoisted(() => ({
    sessions: {} as Record<string, { id: string; metadata: Metadata }>,
    calls: {} as Record<string, number>,
    failure: null as { id: string; call: number; after?: boolean } | null,
    beforeWrite: null as ((id: string) => void) | null,
    observe: null as (() => void) | null,
    staleSourceProposal: false,
}));
vi.mock('./storage', () => ({ storage: { getState: () => fixture } }));
vi.mock('./ops', () => ({
    sessionUpdateMetadata: async (id: string, update: (metadata: Metadata) => Metadata) => {
        const call = fixture.calls[id] = (fixture.calls[id] ?? 0) + 1;
        fixture.beforeWrite?.(id);
        if (fixture.failure?.id === id && fixture.failure.call === call && !fixture.failure.after) throw new Error('storage failed');
        if (fixture.staleSourceProposal && id === 'old' && call === 2) {
            const { delegationMigration: _marker, ...stale } = fixture.sessions[id].metadata;
            update(stale); // Initial cached proposal; CAS then observes the committed freeze.
        }
        const proposed = update(fixture.sessions[id].metadata);
        fixture.sessions[id].metadata = proposed;
        fixture.observe?.();
        if (fixture.failure?.id === id && fixture.failure.call === call && fixture.failure.after) throw new Error('response lost after commit');
    },
}));
import { migrateWorkers, hubOf } from './orchestration';

const record = (worker = 'worker', attempt = 1, deadline = 500) => ({
    worker, attempt, deadline, budgetMinutes: 10, dispatch: worker + '-' + attempt, state: 'dispatched',
});
const base = { path: '/fixture', host: 'test', version: '1', flavor: 'codex' } as Metadata;
function seed(oldLedger: unknown = { expired: record() }, nextLedger: unknown = {}) {
    fixture.sessions = {
        old: { id: 'old', metadata: { ...base, delegationLedger: oldLedger, orchestration: { role: 'hub', workers: [{ sessionId: 'worker', boundAt: 1, by: 'manual' }] } } },
        next: { id: 'next', metadata: { ...base, delegationLedger: nextLedger } },
        worker: { id: 'worker', metadata: { ...base, permissionMode: 'read-only', permissionModeSource: 'explicit',
            orchestration: { role: 'worker', hub: { sessionId: 'old', boundAt: 1, by: 'manual', autonomy: true } } } },
    };
}
const ledger = (id: string) => fixture.sessions[id].metadata.delegationLedger as Record<string, any>;
const workers = (id: string) => {
    const o = fixture.sessions[id].metadata.orchestration;
    return o?.role === 'hub' ? o.workers.map(w => w.sessionId) : [];
};

describe('migration retains delegation limits and one execution owner', () => {
    beforeEach(() => {
        fixture.calls = {}; fixture.failure = null; fixture.beforeWrite = null; fixture.observe = null; fixture.staleSourceProposal = false;
        seed();
    });
    it('preserves an already expired deadline independently of the display board', async () => {
        const original = JSON.stringify(ledger('old'));
        expect(await migrateWorkers('old', 'next')).toBe(1);
        expect(ledger('next').expired).toEqual(record());
        expect(ledger('next').expired.deadline).toBeLessThan(Date.now());
        expect(JSON.stringify(ledger('old'))).toBe(original);
        expect(workers('old')).toEqual([]);
        expect(hubOf('worker')).toBe('next');
        expect(fixture.sessions.old.metadata.delegationMigration).toBeUndefined();
    });
    it('waits for the winning CAS metadata when the freeze ACK precedes the local update event', async () => {
        fixture.staleSourceProposal = true;
        expect(await migrateWorkers('old', 'next')).toBe(1);
        expect(hubOf('worker')).toBe('next');
        expect(workers('old')).toEqual([]);
        expect(ledger('next').expired.deadline).toBe(500);
    });
    it('takes the greater attempt and earlier deadline, even when they come from different hubs', async () => {
        seed({ same: record('worker', 2, 600) }, { same: record('other', 1, 400) });
        await migrateWorkers('old', 'next');
        expect(ledger('next').same).toMatchObject({ worker: 'worker', attempt: 2, deadline: 400 });
        expect(ledger('old').same).toMatchObject({ attempt: 2, deadline: 600 });
    });
    it('preserves equal-attempt ownership conflicts as a dispatch block instead of selecting a second owner', async () => {
        seed({ same: record('worker') }, { same: record('other') });
        await migrateWorkers('old', 'next');
        expect(ledger('next').same).toMatchObject({ attempt: 1, deadline: 500, conflicted: true });
    });
    it('allows exactly 256 distinct records without evicting old restrictions', async () => {
        const old: Record<string, unknown> = {};
        for (let i = 0; i < 255; i++) old['old-' + i] = record();
        seed(old, { existing: record('other') });
        await migrateWorkers('old', 'next');
        expect(Object.keys(ledger('next'))).toHaveLength(256);
        expect(Object.keys(ledger('old'))).toHaveLength(255);
    });
    it('fails before moving ownership when the union exceeds 256, retaining all source limits', async () => {
        const old: Record<string, unknown> = {};
        for (let i = 0; i < 256; i++) old['old-' + i] = record();
        seed(old, { existing: record('other') });
        await expect(migrateWorkers('old', 'next')).rejects.toThrow('256');
        expect(Object.keys(ledger('old'))).toHaveLength(256);
        expect(Object.keys(ledger('next'))).toEqual(['existing']);
        expect(workers('old')).toEqual(['worker']);
        expect(workers('next')).toEqual([]);
        expect(hubOf('worker')).toBe('old');
        expect(fixture.sessions.old.metadata.delegationMigration).toMatchObject({ target: 'next', workers: ['worker'] });
    });
    it('does not discard malformed source limits as an empty ledger', async () => {
        seed({ old: { deadline: 1 } });
        await expect(migrateWorkers('old', 'next')).rejects.toThrow();
        expect(ledger('old')).toEqual({ old: { deadline: 1 } });
        expect(hubOf('worker')).toBe('old');
        expect(workers('next')).toEqual([]);
    });
    it.each([
        { id: 'next', call: 1 },
        { id: 'worker', call: 1 },
        { id: 'next', call: 2 },
        { id: 'next', call: 2, after: true },
        { id: 'old', call: 3 },
    ])('recovers the same migration after a failed/unknown commit at $id/$call', async failure => {
        const original = JSON.stringify(ledger('old'));
        fixture.observe = () => {
            const oldCanDispatch = fixture.sessions.old.metadata.delegationMigration === undefined && workers('old').includes('worker');
            const newCanDispatch = workers('next').includes('worker');
            expect(oldCanDispatch && newCanDispatch).toBe(false);
        };
        fixture.failure = failure;
        await expect(migrateWorkers('old', 'next')).rejects.toThrow();
        expect(JSON.stringify(ledger('old'))).toBe(original);
        expect(fixture.sessions.old.metadata.delegationMigration).toBeDefined();
        fixture.failure = null;
        expect(await migrateWorkers('old', 'next')).toBe(1);
        expect(hubOf('worker')).toBe('next');
        expect(workers('old')).toEqual([]);
        expect(ledger('next').expired.deadline).toBe(500);
        expect(fixture.sessions.old.metadata.delegationMigration).toBeUndefined();
    });
    it('rechecks bindings and does not overwrite a worker concurrently moved elsewhere', async () => {
        fixture.beforeWrite = id => {
            if (id === 'worker') fixture.sessions.worker.metadata.orchestration = { role: 'worker', hub: { sessionId: 'elsewhere', boundAt: 99, by: 'manual' } };
        };
        expect(await migrateWorkers('old', 'next')).toBe(0);
        expect(fixture.sessions.worker.metadata.orchestration).toMatchObject({ hub: { sessionId: 'elsewhere' } });
        expect(workers('next')).toEqual([]);
        expect(ledger('old').expired.deadline).toBe(500);
    });
    it('refuses a new target while the previous migration is incomplete', async () => {
        fixture.failure = { id: 'next', call: 1 };
        await expect(migrateWorkers('old', 'next')).rejects.toThrow();
        await expect(migrateWorkers('old', 'another')).rejects.toThrow('another hub');
        expect(workers('old')).toEqual(['worker']);
    });
    it('rebinds the workers of a deleted hub instead of leaving them orphaned', async () => {
        seed();
        delete fixture.sessions.old;
        fixture.calls = {}; fixture.failure = null;
        await expect(migrateWorkers('old', 'next')).resolves.toBe(1);
        expect(hubOf('worker')).toBe('next');
        expect(workers('next')).toEqual(['worker']);
    });
});
