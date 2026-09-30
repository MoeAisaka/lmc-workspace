import type { Session } from './storageTypes';
import { isRigMetadata } from './rig';

/** Connection loss is not retirement when the agent reports a lifecycle. */
export function isSessionArchived(session: Pick<Session, 'metadata' | 'active'>): boolean {
    const lifecycle = session.metadata?.lifecycleState;
    if (lifecycle) return lifecycle === 'archived';
    // Older CLI records have no lifecycle marker. Preserve their existing
    // archive fallback instead of bringing all historical sessions back.
    return !isRigMetadata(session.metadata) && !session.active;
}
