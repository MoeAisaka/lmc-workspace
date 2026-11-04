import axios from 'axios';
import { configuration } from '@/configuration';
import { decodeBase64, decrypt } from '@/api/encryption';
import type { Metadata } from '@/api/types';
import { logger } from '@/ui/logger';

/** Refresh must read one identity, independent of account size or session age. */
export async function fetchSessionMetadata(
    sessionId: string,
    encryptionKey: Uint8Array,
    encryptionVariant: 'legacy' | 'dataKey',
    token: string,
): Promise<Metadata | null> {
    try {
        const response = await axios.get(`${configuration.serverUrl}/v1/sessions/${encodeURIComponent(sessionId)}`, {
            headers: { Authorization: `Bearer ${token}` }, timeout: 10_000,
        });
        const session = response.data?.session;
        if (session?.id !== sessionId || typeof session.metadata !== 'string') return null;
        return decrypt(encryptionKey, encryptionVariant, decodeBase64(session.metadata)) as Metadata | null;
    } catch (error) {
        logger.debug(`[DAEMON RUN] Failed to fetch session metadata from server: ${error instanceof Error ? error.message : error}`);
        return null;
    }
}
