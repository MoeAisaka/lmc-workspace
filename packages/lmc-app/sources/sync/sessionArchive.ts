import type { Session } from './storageTypes';
import { isRigMetadata } from './rig';

/** Heartbeats and missing legacy metadata never imply an explicit archive. */
export function isSessionArchived(session: Pick<Session, 'metadata' | 'active'>): boolean {
    return session.metadata?.lifecycleState === 'archived';
}

/** Keep the removed-device exception, without retiring sessions by elapsed time. */
export function listArchiveRule(machines: readonly { id: string }[]): (session: Pick<Session, 'metadata' | 'active'>) => boolean {
    const machineIds = new Set(machines.map(machine => machine.id));
    return session => {
        if (isSessionArchived(session)) return true;
        const machineId = session.metadata?.machineId;
        // An empty or unloaded machine list cannot establish device removal.
        // Active sessions and Rig sessions retain their existing safeguards.
        if (session.active || !machineId || isRigMetadata(session.metadata) || machineIds.size === 0) return false;
        return !machineIds.has(machineId);
    };
}
