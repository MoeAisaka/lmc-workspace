import type { Server } from 'socket.io';
import { db } from '@/storage/db';
import { multiAccountEnabled } from './features';

let io: Server | undefined;
export function initSessionNotifications(server: Server) { io = server; }

/** Only an invalidation hint crosses account rooms. Content and keys always
 * go through a fresh authenticated HTTP read, including after reconnect. */
const pending = new Map<string, Promise<void>>();
export function notifySharedSession(ownerId: string, sessionId: string): Promise<void> {
    if (!io || !multiAccountEnabled()) return Promise.resolve();
    const key = `${ownerId}:${sessionId}`;
    const current = pending.get(key);
    if (current) return current;
    // Streaming updates and heartbeats only invalidate. Coalesce a burst into
    // one fresh authorized read instead of amplifying it into per-token queries.
    const next = new Promise<void>(resolve => setTimeout(resolve, 100))
        .then(() => emitSharedSessionHint(ownerId, sessionId)).finally(() => pending.delete(key));
    pending.set(key, next);
    return next;
}

async function emitSharedSessionHint(ownerId: string, sessionId: string) {
    if (!io || !multiAccountEnabled()) return;
    const policy = await db.lmcResourcePolicy.findUnique({ where: { kind_resourceId: { kind: 'session', resourceId: sessionId } },
        include: { grants: { where: { account: { enabled: true } } } } });
    if (!policy || policy.ownerAccountId !== ownerId) return;
    for (const grant of policy.grants) {
        if (grant.accountId !== ownerId && grant.keyEnvelope && Array.isArray(grant.actions) && grant.actions.includes('read')) {
            io.to(`user:${grant.accountId}:web-ui`).emit('shared-session-changed', { sessionId });
        }
    }
}

export function notifySessionAccessChanged(sessionId: string, accountIds: string[]) {
    if (!io) return;
    for (const accountId of new Set(accountIds)) io.to(`user:${accountId}:web-ui`).emit('session-access-changed', { sessionId });
}
