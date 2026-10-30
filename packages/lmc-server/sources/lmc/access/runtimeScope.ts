import { db } from '@/storage/db';

export type RuntimeScope = { sessionId: string; machineId: string };
export function parseRuntimeScope(value: unknown): RuntimeScope | null {
    const scope = value as Partial<RuntimeScope> | null;
    return scope && typeof scope.sessionId === 'string' && /^[\w-]{1,191}$/.test(scope.sessionId) && typeof scope.machineId === 'string' && /^[\w-]{1,191}$/.test(scope.machineId) ? scope as RuntimeScope : null;
}

/** Default deny: a session runner cannot use account, machine or mail APIs. */
export async function allowsRuntimeHttp(scope: RuntimeScope, method: string, pathname: string, body?: any): Promise<boolean> {
    const sid = encodeURIComponent(scope.sessionId);
    if (method === 'GET' && pathname === `/v1/sessions/${sid}`) return true;
    if (['GET', 'POST'].includes(method) && pathname === `/v3/sessions/${sid}/messages`) return true;
    if (method === 'POST' && [`/v1/lmc/runtime/${sid}/start`, `/v1/lmc/runtime/${sid}/authorize`, `/v1/lmc/sessions/${sid}/commands/claim`].includes(pathname)) return true;
    if (method === 'GET' && pathname === `/v1/lmc/sessions/${sid}/commands/pending`) return true;
    if (method === 'GET' && pathname === `/v1/sessions/${sid}/file-deliveries`) return true;
    if (method === 'POST' && new RegExp(`^/v1/sessions/${sid}/file-deliveries/[\\w-]+/ack$`).test(pathname)) return true;
    if (['GET', 'PUT', 'POST'].includes(method) && pathname.startsWith(`/v1/sessions/${sid}/attachments/`)) return true;
    if (method === 'GET' && pathname === '/v1/files/capabilities') return true;
    if (method === 'POST' && pathname === '/v1/files') {
        if (typeof body?.id !== 'string') return false;
        const existing = await db.fileAsset.findUnique({ where: { id: body.id }, select: { runtimeSessionId: true } });
        return !existing || existing.runtimeSessionId === scope.sessionId;
    }
    const share = pathname.match(/^\/v1\/file-shares\/([\w-]+)$/);
    if (share && method === 'DELETE') {
        const row = await db.fileShare.findUnique({ where: { id: share[1] }, select: { asset: { select: { runtimeSessionId: true } } } });
        return row?.asset.runtimeSessionId === scope.sessionId;
    }
    const file = pathname.match(/^\/v1\/files\/([\w-]+)(?:\/(?:parts\/\d+|complete|abort|shares))?$/);
    if (file && ['GET', 'PUT', 'POST'].includes(method)) {
        const row = await db.fileAsset.findUnique({ where: { id: file[1] }, select: { runtimeSessionId: true } });
        if (row?.runtimeSessionId === scope.sessionId) return true;
        // An inbox delivery grants this runtime access to that one file only.
        if (method === 'GET' && !pathname.includes('/shares')) return !!await db.fileDelivery.findFirst({ where: { assetId: file[1], sessionId: scope.sessionId }, select: { id: true } });
        return false;
    }
    return false;
}

export function allowsRuntimePacket(scope: RuntimeScope, packet: any[]): boolean {
    const [event, data] = packet;
    if (event === 'ping') return true;
    if (event === 'rpc-register' || event === 'rpc-unregister') return typeof data?.method === 'string' && data.method.startsWith(scope.sessionId + ':');
    if (['message', 'session-alive', 'session-end', 'update-metadata', 'update-state'].includes(event)) return data?.sid === scope.sessionId;
    if (event === 'usage-report' || event === 'usage-report-v2') return data?.sessionId === scope.sessionId;
    return false;
}
