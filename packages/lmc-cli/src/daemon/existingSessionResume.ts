import axios from 'axios';
import { configuration } from '@/configuration';
import type { SpawnSessionResult } from '@/modules/common/registerCommonHandlers';

/** A live PID prevents a duplicate runner; it does not prove a usable connection. */
export async function confirmExistingSessionResume(sessionId: string, token: string): Promise<SpawnSessionResult> {
    try {
        const response = await axios.get(`${configuration.serverUrl}/v1/sessions/${encodeURIComponent(sessionId)}`, {
            headers: { Authorization: `Bearer ${token}` }, timeout: 10_000,
        });
        const session = response.data?.session;
        const age = typeof session?.activeAt === 'number' ? Date.now() - session.activeAt : NaN;
        // The server persists heartbeats every 30s plus a 5s batch interval.
        // Leave room for that delay without accepting a stale active flag.
        if (session?.id === sessionId && session.active === true && age >= -5_000 && age <= 60_000) {
            return { type: 'success', sessionId };
        }
        return { type: 'error', errorMessage: 'The session process is still running, but its connection has not recovered. No duplicate process was started. Retry after the connection recovers; if it remains offline, repair the existing process first.' };
    } catch {
        // Transport errors can contain Authorization headers. Return only a
        // bounded explanation; do not serialize the request or its credentials.
        return { type: 'error', errorMessage: 'Could not verify the existing session connection. No process was stopped or restarted. Please retry.' };
    }
}
