import { apiSocket } from '@/sync/apiSocket';
import { isRigMetadata } from '@/sync/rig';

const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;
/** The Agent's refusal for a malformed path, see resolveResourceFile in lmc-cli. */
const INVALID_PATH = '无效的文件路径';

type DownloadRequest = { path: string; action: 'download'; offset?: number; revision?: string };

/** Read-only fallback to the original host when a session's process has exited.
 * Never restart a session, select another machine, or replay an open-host action.
 * Chunk revisions remain intact if the session disconnects mid-download.
 */
export async function readSessionResource<T>(sessionId: string, request: DownloadRequest): Promise<T> {
    const viaHost = async (error: unknown): Promise<T> => {
        const { storage } = await import('@/sync/storage');
        const metadata = storage.getState().sessions[sessionId]?.metadata;
        if (isRigMetadata(metadata) || !metadata?.machineId) throw error;
        const absolute = (value: string | undefined | null) => !!value && (value.startsWith('/') || WINDOWS_DRIVE.test(value));
        const path = absolute(request.path) ? request.path
            : absolute(metadata.path) ? `${metadata.path}/${request.path}` : null;
        if (!path) throw error;
        return apiSocket.machineRPC<T, DownloadRequest>(metadata.machineId, 'resource-file', { ...request, path });
    };
    let result: T;
    try {
        result = await apiSocket.sessionRPC<T, DownloadRequest>(sessionId, 'resource-file', request);
    } catch (error) {
        if (!(error instanceof Error) || !['RPC target disconnected', 'RPC method not available'].includes(error.message)) throw error;
        return viaHost(error);
    }
    // Session processes started before Agent 1.2.100 refuse every Windows
    // drive path as if it were a URL. Their daemon may already be newer, so ask
    // the same host once. Any other file error is the answer and is not replayed.
    const refused = result as { success?: boolean; error?: string } | null;
    if (refused?.success === false && refused.error === INVALID_PATH && WINDOWS_DRIVE.test(request.path)) {
        try { return await viaHost(new Error(INVALID_PATH)); } catch { return result; }
    }
    return result;
}
