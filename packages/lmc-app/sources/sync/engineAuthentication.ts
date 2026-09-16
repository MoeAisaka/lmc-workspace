import { apiSocket } from './apiSocket';
import { storage } from './storage';
import { sessionCapabilities } from './sessionCapabilities';
import { t } from '@/text';
export async function checkSessionAuthentication(sessionId: string) {
    const metadata = storage.getState().sessions[sessionId]?.metadata;
    if (!sessionCapabilities(metadata).authentication) throw new Error(t('localFeatures.engineAgentUpgrade'));
    return apiSocket.sessionRPC<{ status: 'ready' | 'required' | 'unknown'; checkedAt: number }, {}>(sessionId, 'check-engine-auth', {});
}
