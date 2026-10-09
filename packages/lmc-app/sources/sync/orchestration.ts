import { storage } from './storage';
import { sessionUpdateMetadata } from './ops';
import type { Metadata } from './storageTypes';
import { DelegationMigrationSchema, mergeDelegationLedgers, type DelegationMigration } from 'lmc-wire';

/**
 * Binding sessions into a hub and its workers, from the app.
 *
 * The binding is written on both sessions — the hub lists its workers, each
 * worker names its hub — and keyed by LMC session id, which no refresh or
 * engine switch changes. Two writes rather than one because the two sessions
 * are separate rows with separate keys; the order (worker first, then hub)
 * means a failure part-way leaves a worker pointing at a hub that does not
 * list it, which `bindingsOf` treats as unbound, rather than a hub claiming a
 * worker that does not know it.
 */
export type Orchestration = NonNullable<Metadata['orchestration']>;

export function orchestrationOf(sessionId: string): Orchestration | undefined {
    return storage.getState().sessions[sessionId]?.metadata?.orchestration ?? undefined;
}

/** A binding is real only when both sides agree on it. */
export function hubOf(workerId: string): string | null {
    const worker = orchestrationOf(workerId);
    if (worker?.role !== 'worker') return null;
    const hub = orchestrationOf(worker.hub.sessionId);
    return hub?.role === 'hub' && hub.workers.some((w) => w.sessionId === workerId) ? worker.hub.sessionId : null;
}

export function workersOf(hubId: string): string[] {
    const hub = orchestrationOf(hubId);
    if (hub?.role !== 'hub') return [];
    return hub.workers.map((w) => w.sessionId).filter((id) => orchestrationOf(id)?.role === 'worker' && (orchestrationOf(id) as any).hub.sessionId === hubId);
}

export async function makeHub(sessionId: string): Promise<void> {
    await sessionUpdateMetadata(sessionId, (metadata) => {
        const current = metadata.orchestration as Orchestration | undefined;
        if (current?.role === 'hub') return metadata;
        return { ...metadata, orchestration: { role: 'hub', workers: [] } };
    });
}

export async function bindWorker(hubId: string, workerId: string, by: 'auto' | 'manual' = 'manual'): Promise<void> {
    if (hubId === workerId) throw new Error('A session cannot be its own worker');
    const boundAt = Date.now();
    const previousHub = hubOf(workerId);
    if (previousHub && previousHub !== hubId) await unbindWorker(workerId);
    await sessionUpdateMetadata(workerId, (metadata) => ({ ...metadata, orchestration: { role: 'worker', hub: { sessionId: hubId, boundAt, by } } }));
    await sessionUpdateMetadata(hubId, (metadata) => {
        const current = metadata.orchestration as Orchestration | undefined;
        const workers = current?.role === 'hub' ? current.workers.filter((w) => w.sessionId !== workerId) : [];
        return { ...metadata, orchestration: { role: 'hub', workers: [...workers, { sessionId: workerId, boundAt, by }] } };
    });
    // This is an owner binding intent, not an SDK acknowledgement. Runtime
    // policy is derived from it; no automatic full mode is written to the pick.
    await sessionUpdateMetadata(workerId, metadata => {
        const current = metadata.orchestration as Orchestration | undefined;
        if (current?.role !== 'worker' || current.hub.sessionId !== hubId || current.hub.boundAt !== boundAt) return metadata;
        return { ...metadata, orchestration: { ...current, hub: { ...current.hub, autonomy: true } } };
    });
}

export async function unbindWorker(workerId: string): Promise<void> {
    const worker = orchestrationOf(workerId);
    const hubId = worker?.role === 'worker' ? worker.hub.sessionId : null;
    if (hubId) {
        await sessionUpdateMetadata(hubId, (metadata) => {
            const current = metadata.orchestration as Orchestration | undefined;
            if (current?.role !== 'hub') return metadata;
            return { ...metadata, orchestration: { role: 'hub', workers: current.workers.filter((w) => w.sessionId !== workerId) } };
        }).catch(() => { /* the hub may be gone; the worker side is what matters for it */ });
    }
    await sessionUpdateMetadata(workerId, (metadata) => ({ ...metadata, orchestration: undefined }));
}

/**
 * A hub is gone — archived, deleted, or its machine dead — and its workers
 * still point at it. Everything moves to another session, which becomes a
 * hub if it is not one: each worker is re-pointed, the new hub lists them,
 * and the old hub's board (when it can still be read) is carried over so the
 * new hub knows what was in flight. The ledger is retained at the source.
 * A durable migration marker blocks source delegation until ownership moves.
 */
export async function migrateWorkers(oldHubId: string, newHubId: string): Promise<number> {
    if (oldHubId === newHubId) return 0;
    const all = storage.getState().sessions;
    const workerIds = Object.values(all)
        .filter((s) => { const o = s.metadata?.orchestration; return o?.role === 'worker' && o.hub.sessionId === oldHubId && s.id !== newHubId; })
        .map((s) => s.id);
    const boundAt = Date.now();
    if (!all[oldHubId]) {
        // The old hub was deleted: there is no ledger left to carry and nobody
        // who could still dispatch from it. Its workers must not stay orphaned.
        for (const workerId of workerIds) await bindWorker(newHubId, workerId, 'manual');
        return workerIds.length;
    }
    let snapshot: { ledger: unknown; board: NonNullable<Orchestration['board']>; migration: DelegationMigration } | undefined;
    // Strict CAS captures the ledger which won the freeze, not a stale app copy.
    // A failed later write keeps this marker for a safe, same-target retry.
    await sessionUpdateMetadata(oldHubId, metadata => {
        const current = metadata.orchestration as Orchestration | undefined;
        if (current?.role !== 'hub') throw new Error('Source hub metadata/ledger is unavailable; no new task budget may be invented');
        const migration = metadata.delegationMigration === undefined
            ? { target: newHubId, token: oldHubId + ':' + newHubId + ':' + boundAt, workers: [...new Set([...workerIds, ...current.workers.map(w => w.sessionId)])].filter(id => id !== newHubId), boundAt }
            : DelegationMigrationSchema.parse(metadata.delegationMigration);
        if (migration.target !== newHubId) throw new Error('A migration to another hub is already pending');
        snapshot = { ledger: metadata.delegationLedger, board: current.board ?? [], migration };
        return { ...metadata, delegationMigration: migration };
    });
    if (!snapshot) throw new Error('Source migration was not confirmed');
    const captured = snapshot;
    let mergedLedger: ReturnType<typeof mergeDelegationLedgers> = {};
    await sessionUpdateMetadata(newHubId, (metadata) => {
        if (metadata.delegationMigration !== undefined) throw new Error('Destination hub has a pending outgoing migration');
        mergedLedger = mergeDelegationLedgers(metadata.delegationLedger, captured.ledger);
        const current = metadata.orchestration as Orchestration | undefined;
        const workers = current?.role === 'hub' ? current.workers : [];
        const ownBoard = current?.role === 'hub' ? (current.board ?? []) : [];
        const byId = new Map(ownBoard.map(entry => [entry.id, entry]));
        for (const entry of captured.board) {
            const own = byId.get(entry.id);
            if (!own || entry.attempt > own.attempt || (entry.attempt === own.attempt && entry.updatedAt > own.updatedAt)) byId.set(entry.id, entry);
        }
        const merged = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40);
        // Persist limits first. Incoming workers are granted only after the old
        // hub revokes them; a merge failure cannot produce two tool owners.
        return { ...metadata, delegationLedger: mergedLedger, orchestration: { ...(current?.role === 'hub' ? current : {}), role: 'hub', workers, board: merged } };
    });
    const migrating = captured.migration.workers;
    let revoked = false;
    await sessionUpdateMetadata(oldHubId, metadata => {
        revoked = false;
        // The write ACK can beat the app's metadata event. A no-op proposal
        // lets strict CAS read the latest version rather than failing on an
        // old local copy which has not received our freeze marker yet.
        if (metadata.delegationMigration === undefined) return metadata;
        const migration = DelegationMigrationSchema.parse(metadata.delegationMigration);
        if (migration.token !== captured.migration.token) throw new Error('Source migration changed; no worker was moved');
        const current = metadata.orchestration as Orchestration;
        if (current.role !== 'hub') throw new Error('Source hub role changed');
        revoked = true;
        return { ...metadata, orchestration: { ...current, workers: current.workers.filter(w => !migrating.includes(w.sessionId) && w.sessionId !== newHubId) } };
    });
    if (!revoked) throw new Error('Source migration was not confirmed; no worker was moved');
    const moved: string[] = [];
    const failed: string[] = [];
    for (const workerId of migrating) {
        let ours = false;
        try { await sessionUpdateMetadata(workerId, (metadata) => {
            const current = metadata.orchestration as Orchestration | undefined;
            ours = current?.role === 'worker' && ((current.hub.sessionId === oldHubId && current.hub.boundAt <= captured.migration.boundAt)
                || (current.hub.sessionId === newHubId && current.hub.boundAt === captured.migration.boundAt));
            if (!ours || current?.role !== 'worker') return metadata;
            // Carry an existing grant, never infer one from the permission pick.
            // Explicit picks remain on metadata and still override this default.
            const autonomy = current.hub.autonomy;
            return { ...metadata, orchestration: { ...current, hub: { sessionId: newHubId, boundAt: captured.migration.boundAt, by: 'manual', ...(autonomy !== undefined ? { autonomy } : {}) } } };
        }); } catch { failed.push(workerId); continue; }
        if (ours) moved.push(workerId);
    }
    await sessionUpdateMetadata(newHubId, metadata => {
        const current = metadata.orchestration as Orchestration | undefined;
        if (current?.role !== 'hub') throw new Error('Destination hub role changed; source remains paused');
        return { ...metadata, orchestration: { ...current, workers: [
            ...current.workers.filter(w => !migrating.includes(w.sessionId)),
            ...moved.map(sessionId => ({ sessionId, boundAt: captured.migration.boundAt, by: 'manual' as const })),
        ] } };
    });
    if (failed.length) throw new Error('Hub migration is incomplete for ' + failed.join(', ') + '; retry the same migration. Source ledger and migration marker were retained');
    await sessionUpdateMetadata(oldHubId, metadata => {
        if (metadata.delegationMigration === undefined) return metadata; // Another same-target caller already completed.
        if (DelegationMigrationSchema.parse(metadata.delegationMigration).token !== captured.migration.token) throw new Error('Source migration changed');
        const { delegationMigration: _migration, ...rest } = metadata;
        return rest;
    });
    return moved.length;
}

/** Dissolve a hub: every worker returns to an ordinary session. */
export async function dissolveHub(hubId: string): Promise<void> {
    for (const workerId of workersOf(hubId)) await unbindWorker(workerId);
    await sessionUpdateMetadata(hubId, (metadata) => ({ ...metadata, orchestration: undefined }));
}
