import { storage } from './storage';
import { sessionUpdateMetadata } from './ops';
import type { Metadata } from './storageTypes';

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
 * new hub knows what was in flight. The old hub, if it still exists, is left
 * with no workers.
 */
export async function migrateWorkers(oldHubId: string, newHubId: string): Promise<number> {
    if (oldHubId === newHubId) return 0;
    const all = storage.getState().sessions;
    const old = orchestrationOf(oldHubId);
    const workerIds = Object.values(all)
        .filter((s) => { const o = s.metadata?.orchestration; return o?.role === 'worker' && o.hub.sessionId === oldHubId && s.id !== newHubId; })
        .map((s) => s.id);
    const boundAt = Date.now();
    const board = old?.role === 'hub' ? (old.board ?? []) : [];
    await sessionUpdateMetadata(newHubId, (metadata) => {
        const current = metadata.orchestration as Orchestration | undefined;
        const workers = current?.role === 'hub' ? current.workers.filter((w) => !workerIds.includes(w.sessionId)) : [];
        const ownBoard = current?.role === 'hub' ? (current.board ?? []) : [];
        const merged = [...board.filter((e) => !ownBoard.some((o) => o.id === e.id)), ...ownBoard].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40);
        return { ...metadata, orchestration: { role: 'hub', workers: [...workers, ...workerIds.map((sessionId) => ({ sessionId, boundAt, by: 'manual' as const }))], board: merged } };
    });
    for (const workerId of workerIds) {
        await sessionUpdateMetadata(workerId, (metadata) => {
            const current = metadata.orchestration as Orchestration | undefined;
            // Carry an existing grant, never infer one from the permission pick.
            // Explicit picks remain on metadata and still override this default.
            const autonomy = current?.role === 'worker' && current.hub.sessionId === oldHubId ? current.hub.autonomy : undefined;
            return { ...metadata, orchestration: { role: 'worker', hub: { sessionId: newHubId, boundAt, by: 'manual', ...(autonomy !== undefined ? { autonomy } : {}) }, board: current?.role === 'worker' ? current.board : undefined } };
        }).catch(() => { /* a worker that cannot be written keeps pointing at the old hub; the list shows it unbound */ });
    }
    if (old?.role === 'hub') {
        await sessionUpdateMetadata(oldHubId, (metadata) => ({ ...metadata, orchestration: { ...(metadata.orchestration as Orchestration), workers: [] } })).catch(() => undefined);
    }
    return workerIds.length;
}

/** Dissolve a hub: every worker returns to an ordinary session. */
export async function dissolveHub(hubId: string): Promise<void> {
    for (const workerId of workersOf(hubId)) await unbindWorker(workerId);
    await sessionUpdateMetadata(hubId, (metadata) => ({ ...metadata, orchestration: undefined }));
}
