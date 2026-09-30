import { apiSocket } from '@/sync/apiSocket';
import { isRigMetadata } from '@/sync/rig';

type DownloadRequest = { path: string; action: 'download'; offset?: number; revision?: string };

/** Read-only fallback to the original host when a session's process has exited.
 * Never restart a session, select another machine, or replay an open-host action.
 * Chunk revisions remain intact if the session disconnects mid-download.
 */
export async function readSessionResource<T>(sessionId: string, request: DownloadRequest): Promise<T> {
    try {
        return await apiSocket.sessionRPC<T, DownloadRequest>(sessionId, 'resource-file', request);
    } catch (error) {
        if (!(error instanceof Error) || !['RPC target disconnected', 'RPC method not available'].includes(error.message)) throw error;
        const { storage } = await import('@/sync/storage');
        const metadata = storage.getState().sessions[sessionId]?.metadata;
        if (isRigMetadata(metadata) || !metadata?.machineId) throw error;
        const path = request.path.startsWith('/') ? request.path
            : metadata.path?.startsWith('/') ? `${metadata.path}/${request.path}` : null;
        if (!path) throw error;
        return apiSocket.machineRPC<T, DownloadRequest>(metadata.machineId, 'resource-file', { ...request, path });
    }
}
