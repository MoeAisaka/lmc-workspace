import * as React from 'react';
import { sync } from './sync';
import { machineSpawnNewSession, sessionUpdateMetadata } from './ops';
import { useAllMachines, useAllSessions } from './storage';
import type { Machine, Session, SpawnRequest } from './storageTypes';
import { machineDisplayName } from '@/utils/lmc/deviceEngineGroups';
import { t } from '@/text';

/**
 * Carrying out a hub's request for a worker on another machine.
 *
 * A runner holds only its own session key and the account token: it can spawn
 * on its own machine through the daemon's local socket, but another machine's
 * daemon speaks encrypted RPC that only the account's secret can address. The
 * app has that secret. So the hub writes the request into its metadata, and
 * whichever app on the account sees it first claims it (a versioned metadata
 * write — two apps cannot both win), spawns the worker born bound and titled,
 * adds the binding on the hub's side, and tells the hub with a message.
 *
 * A claim older than a few minutes is treated as abandoned: the app that made
 * it may have closed mid-flight.
 */
const CLAIM_STALE_MS = 3 * 60_000;
const inFlight = new Set<string>();

function findMachine(machines: Machine[], wanted: string): Machine | null {
    const key = wanted.trim().toLowerCase();
    return machines.find((m) => m.active && (m.id === wanted || machineDisplayName(m, m.metadata?.host ?? '').toLowerCase() === key || (m.metadata?.host ?? '').toLowerCase() === key)) ?? null;
}

function needsRelay(request: SpawnRequest, now: number): boolean {
    return request.state === 'pending' || (request.state === 'claimed' && now - (request.claimedAt ?? request.requestedAt) > CLAIM_STALE_MS);
}

async function patchRequest(hubId: string, requestId: string, patch: (r: SpawnRequest) => SpawnRequest | null): Promise<boolean> {
    let applied = false;
    try {
        await sessionUpdateMetadata(hubId, (metadata) => {
            const orchestration = metadata.orchestration as { role: string; spawnRequests?: SpawnRequest[] } | undefined;
            if (orchestration?.role !== 'hub') return metadata;
            const requests = orchestration.spawnRequests ?? [];
            const current = requests.find((r) => r.id === requestId);
            const next = current ? patch(current) : null;
            applied = !!next;
            if (!next) return metadata;
            return { ...metadata, orchestration: { ...orchestration, spawnRequests: requests.map((r) => (r.id === requestId ? next : r)) } };
        });
    } catch {
        return false;
    }
    return applied;
}

export async function fulfilSpawnRequest(hub: Session, request: SpawnRequest, machines: Machine[]): Promise<void> {
    const key = `${hub.id}:${request.id}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
        const now = Date.now();
        // Claim: only if it is still ours to take when the write lands.
        const claimed = await patchRequest(hub.id, request.id, (r) => (needsRelay(r, now) ? { ...r, state: 'claimed', claimedAt: now } : null));
        if (!claimed) return;
        const machine = findMachine(machines, request.machine);
        const finish = async (outcome: Partial<SpawnRequest> & { state: 'done' | 'failed' }, notice: string) => {
            await patchRequest(hub.id, request.id, (r) => ({ ...r, ...outcome }));
            await sync.sendMessage(hub.id, notice).catch(() => undefined);
        };
        if (!machine) {
            await finish({ state: 'failed', error: 'no machine' }, `[notice] ${t('lmc.orchestration.spawnFailed', { title: request.title, machine: request.machine, error: t('lmc.orchestration.spawnNoMachine') })} (request ${request.id})`);
            return;
        }
        const result = await machineSpawnNewSession({
            machineId: machine.id, directory: request.directory, agent: request.agent, approvedNewDirectoryCreation: true,
            modelMode: request.model, effortLevel: request.effort, permissionMode: request.permissionMode,
            hubSessionId: hub.id, title: request.title,
        });
        if (result.type !== 'success') {
            const error = result.type === 'error' ? result.errorMessage : `directory ${request.directory} does not exist there`;
            await finish({ state: 'failed', error }, `[notice] ${t('lmc.orchestration.spawnFailed', { title: request.title, machine: machineDisplayName(machine, request.machine), error })} (request ${request.id})`);
            return;
        }
        const workerId = result.sessionId;
        // The worker was born naming this hub; the hub's side of the binding
        // is ours to write, since the worker cannot open the hub's row.
        await sessionUpdateMetadata(hub.id, (metadata) => {
            const orchestration = metadata.orchestration as { role: string; workers: { sessionId: string; boundAt: number; by: 'auto' | 'manual' }[] } | undefined;
            if (orchestration?.role !== 'hub') return metadata;
            return { ...metadata, orchestration: { ...orchestration, workers: [...orchestration.workers.filter((w) => w.sessionId !== workerId), { sessionId: workerId, boundAt: Date.now(), by: 'auto' }] } };
        }).catch(() => undefined);
        try { await sync.refreshSessions(); } catch { /* broadcast sync will hydrate */ }
        await finish({ state: 'done', sessionId: workerId }, `[notice] ${t('lmc.orchestration.spawnStarted', { title: request.title, machine: machineDisplayName(machine, request.machine) })}: worker session id ${workerId}, bound to you. Give it a moment to come up, then dispatch with assign_task. (request ${request.id})`);
    } finally {
        inFlight.delete(key);
    }
}

/** Mounted once at the app root: watches every hub on the account for spawn requests. */
export function useOrchestrationSpawnRelay(): void {
    const sessions = useAllSessions();
    const machines = useAllMachines({ includeOffline: true });
    React.useEffect(() => {
        const now = Date.now();
        for (const session of sessions) {
            const orchestration = session.metadata?.orchestration;
            if (orchestration?.role !== 'hub') continue;
            for (const request of orchestration.spawnRequests ?? []) {
                if (needsRelay(request, now)) void fulfilSpawnRequest(session, request, machines);
            }
        }
    }, [sessions, machines]);
}
