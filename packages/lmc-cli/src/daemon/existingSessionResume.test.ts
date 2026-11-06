import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { confirmExistingSessionResume } from './existingSessionResume';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));
vi.mock('@/configuration', () => ({ configuration: { serverUrl: 'https://server.test' } }));

const now = 1_800_000_000_000;
beforeEach(() => { vi.resetAllMocks(); vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => vi.restoreAllMocks());

describe('resume of an existing process', () => {
    it('confirms the exact session with a current server heartbeat', async () => {
        // Heartbeats are persisted in 30s batches, so a 35s-old row is normal.
        vi.mocked(axios.get).mockResolvedValueOnce({ data: { session: { id: 'session-a', active: true, activeAt: now - 35_000 } } });
        expect(await confirmExistingSessionResume('session-a', 'test-token')).toEqual({ type: 'success', sessionId: 'session-a' });
        expect(axios.get).toHaveBeenCalledExactlyOnceWith('https://server.test/v1/sessions/session-a', {
            headers: { Authorization: 'Bearer test-token' }, timeout: 10_000,
        });
    });

    it.each([
        { id: 'session-a', active: false, activeAt: now - 3_600_000 },
        { id: 'session-a', active: true, activeAt: now - 3_600_000 },
        { id: 'session-a', active: true },
        { id: 'session-a', active: true, activeAt: now + 60_000 },
        { id: 'another-session', active: true, activeAt: now },
    ])('does not report success just because the old process exists: %j', async session => {
        vi.mocked(axios.get).mockResolvedValueOnce({ data: { session } });
        expect((await confirmExistingSessionResume('session-a', 'test-token')).type).toBe('error');
    });

    it('fails closed without leaking a credential-bearing transport error', async () => {
        vi.mocked(axios.get).mockRejectedValueOnce(new Error('request Authorization: Bearer private-test-token'));
        const result = await confirmExistingSessionResume('session-a', 'test-token');
        expect(result.type).toBe('error');
        expect(JSON.stringify(result)).not.toContain('private-test-token');
    });
});
