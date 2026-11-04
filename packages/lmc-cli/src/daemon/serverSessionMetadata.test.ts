import { beforeEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import { fetchSessionMetadata } from './serverSessionMetadata';
import { decrypt } from '@/api/encryption';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));
vi.mock('@/configuration', () => ({ configuration: { serverUrl: 'https://server.test' } }));
vi.mock('@/api/encryption', () => ({ decodeBase64: (value: string) => Buffer.from(value, 'base64'), decrypt: vi.fn() }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));

beforeEach(() => vi.clearAllMocks());

it('reads only the requested session, without enumerating an account-wide metadata page', async () => {
    const key = new Uint8Array([1, 2, 3]);
    const metadata = { flavor: 'agy', hostPid: 42, agyConversationId: 'native-conversation' };
    vi.mocked(axios.get).mockResolvedValueOnce({ data: { session: { id: 'old-session', metadata: 'ZW5jcnlwdGVk' } } });
    vi.mocked(decrypt).mockReturnValueOnce(metadata);

    expect(await fetchSessionMetadata('old-session', key, 'dataKey', 'test-token')).toEqual(metadata);
    expect(axios.get).toHaveBeenCalledExactlyOnceWith('https://server.test/v1/sessions/old-session', {
        headers: { Authorization: 'Bearer test-token' }, timeout: 10_000,
    });
    expect(decrypt).toHaveBeenCalledWith(key, 'dataKey', Buffer.from('encrypted'));
});

it('keeps the current session when the exact lookup fails', async () => {
    vi.mocked(axios.get).mockRejectedValueOnce(new Error('request timed out'));
    expect(await fetchSessionMetadata('session', new Uint8Array(), 'legacy', 'test-token')).toBeNull();
    expect(decrypt).not.toHaveBeenCalled();
});
