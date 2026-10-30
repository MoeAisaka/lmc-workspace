import { db } from '@/storage/db';
import { multiAccountEnabled } from './features';

type SessionRow = { id: string; accountId: string; dataEncryptionKey: Uint8Array | null; projectId: string | null };
const allowsRead = (actions: unknown) => Array.isArray(actions) && actions.includes('read');

async function grantsFor(accountId: string, authKind?: string) {
    // Device sharing is separate from session viewing. A paired CLI must not
    // discover other owners' sessions or use their keys as execution authority.
    if (authKind !== 'web' || !multiAccountEnabled()) return [];
    const policies = await db.lmcResourcePolicy.findMany({
        where: { kind: 'session', grants: { some: { accountId, account: { enabled: true } } } },
        include: { grants: { where: { accountId } } },
    });
    return policies.flatMap(policy => {
        const grant = policy.grants[0];
        return grant?.keyEnvelope && allowsRead(grant.actions) ? [{ ...policy, key: grant.keyEnvelope, actions: grant.actions as string[] }] : [];
    });
}

export async function sharedSessionIds(accountId: string, authKind?: string) {
    const grants = await grantsFor(accountId, authKind);
    if (!grants.length) return [];
    const rows = await db.session.findMany({ where: { id: { in: grants.map(g => g.resourceId) }, dataEncryptionKey: { not: null } }, select: { id: true, accountId: true } });
    return rows.filter(row => grants.some(g => g.resourceId === row.id && g.ownerAccountId === row.accountId)).map(row => row.id);
}

/** Project linkage is private independently of a shared session. */
export async function visibleSessionRows<T extends SessionRow>(accountId: string, authKind: string | undefined, rows: T[]) {
    const grants = rows.some(row => row.accountId !== accountId) ? await grantsFor(accountId, authKind) : [];
    return rows.flatMap(row => {
        if (row.accountId === accountId) return [{ ...row, shared: false, accessVersion: 0, accessActions: ['read', 'send', 'stop', 'approve', 'configure'] }];
        const grant = grants.find(g => g.resourceId === row.id && g.ownerAccountId === row.accountId);
        if (!grant || !row.dataEncryptionKey) return [];
        return [{ ...row, dataEncryptionKey: grant.key, projectId: null, shared: true, accessVersion: grant.version, accessActions: grant.actions }];
    });
}

export async function readableSession(accountId: string, sessionId: string, authKind?: string) {
    const row = await db.session.findUnique({ where: { id: sessionId } });
    if (!row) return null;
    return (await visibleSessionRows(accountId, authKind, [row]))[0] ?? null;
}

export function sessionResponse(v: Awaited<ReturnType<typeof readableSession>> & {}) {
    return { id: v.id, seq: v.seq, createdAt: v.createdAt.getTime(), updatedAt: v.updatedAt.getTime(),
        active: v.active, activeAt: v.lastActiveAt.getTime(), metadata: v.metadata, metadataVersion: v.metadataVersion,
        agentState: v.agentState, agentStateVersion: v.agentStateVersion,
        dataEncryptionKey: v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null,
        projectId: v.projectId, shared: v.shared, accessVersion: v.accessVersion, accessActions: v.accessActions, lastMessage: null };
}
