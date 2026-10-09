import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { AgentMailClient } from './agentMail';
import { encryptWithDataKey, encodeBase64 } from '@/api/encryption';

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), isAxiosError: () => false } }));
vi.mock('@/configuration', () => ({ configuration: { serverUrl: 'https://server.test' } }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));

beforeEach(() => {
    vi.mocked(axios.get).mockReset().mockResolvedValue({ data: { key: Buffer.alloc(32).toString('base64'), mailProtocol: 2 } });
    vi.mocked(axios.post).mockReset().mockResolvedValue({ data: { id: 'stored-mail', duplicate: false } });
});

describe('receipt protocol negotiation at the HTTP boundary', () => {
    const body = encodeBase64(encryptWithDataKey({ text: 'hello' }, new Uint8Array(32)));
    it('learns a center upgrade inside a long-lived process, and never steps down', async () => {
        vi.useFakeTimers();
        try {
            let protocol = 2;
            vi.mocked(axios.get).mockImplementation(async () => ({ data: { key: Buffer.alloc(32).toString('base64'), mailProtocol: protocol } }) as any);
            const client = new AgentMailClient('fake-token', 'recipient');
            expect(await client.supportsReceipts()).toBe(false);
            protocol = 3;
            expect(await client.supportsReceipts()).toBe(false); // Not re-asked on every poll.
            vi.advanceTimersByTime(10 * 60_000);
            expect(await client.supportsReceipts()).toBe(true);
            protocol = 2;
            vi.advanceTimersByTime(60 * 60_000);
            expect(await client.supportsReceipts()).toBe(true);
            expect(vi.mocked(axios.get)).toHaveBeenCalledTimes(2);
        } finally { vi.useRealTimers(); }
    });
    it.each([undefined, 1, 2, 3])('negotiates center protocol %s without sending unsupported requests', async protocol => {
        vi.mocked(axios.get).mockImplementation(async (url: any) => ({ data: url.endsWith('channel-key')
            ? { key: Buffer.alloc(32).toString('base64'), ...(protocol ? { mailProtocol: protocol } : {}) }
            : url.endsWith('directory') ? { entries: [] } : { mail: [{ id: 'm', fromSessionId: 'sender', body, hop: 1, createdAt: 1 }] } }) as any);
        const client = new AgentMailClient('fake-token', 'recipient');
        expect(await client.supportsReceipts()).toBe(protocol === 3);
        expect(await client.receive()).toMatchObject([{ id: 'm', text: 'hello' }]);
        const options = vi.mocked(axios.get).mock.calls.find(([url]) => String(url).endsWith('/mail'))![1] as any;
        expect(options.params).toEqual({ sessionId: 'recipient', ...(protocol === 3 ? { mailProtocol: 3 } : {}) });
        vi.mocked(axios.post).mockResolvedValue({ data: { acknowledged: ['m'] } });
        expect(await client.acknowledge(['m'])).toBe(protocol === 3);
        if (protocol !== 3) expect(axios.post).not.toHaveBeenCalled();
        else expect(axios.post).toHaveBeenCalledWith('https://server.test/v1/lmc/agent/mail/ack', { sessionId: 'recipient', ids: ['m'] }, expect.anything());
    });
    it('does not treat failed or partial ACK responses as confirmation', async () => {
        vi.mocked(axios.get).mockResolvedValue({ data: { key: Buffer.alloc(32).toString('base64'), mailProtocol: 3 } });
        const client = new AgentMailClient('fake-token', 'recipient');
        vi.mocked(axios.post).mockRejectedValueOnce(new Error('lost response'));
        expect(await client.acknowledge(['m'])).toBe(false);
        vi.mocked(axios.post).mockResolvedValueOnce({ data: { acknowledged: [] } });
        expect(await client.acknowledge(['m'])).toBe(false);
        vi.mocked(axios.post).mockResolvedValueOnce({ data: { acknowledged: ['m'] } });
        expect(await client.acknowledge(['m'])).toBe(true);
    });
    it('retains an invalid ciphertext as a control notice candidate on v3', async () => {
        vi.mocked(axios.get).mockImplementation(async (url: any) => ({ data: url.endsWith('channel-key')
            ? { key: Buffer.alloc(32).toString('base64'), mailProtocol: 3 }
            : url.endsWith('directory') ? { entries: [] } : { mail: [{ id: 'bad', fromSessionId: 'sender', body: 'AAAA', hop: 1, createdAt: 1 }] } }) as any);
        expect(await new AgentMailClient('fake-token', 'recipient').receive()).toMatchObject([{ id: 'bad', invalid: true, text: '' }]);
    });
});

async function send(text: string, sender = 'worker', recipient = 'hub') {
    const result = await new AgentMailClient('test-token', sender).send(recipient, text, 1);
    expect(result.ok).toBe(true);
    return vi.mocked(axios.post).mock.calls.at(-1)![1] as { idempotencyKey?: string };
}

const report = '[report t1 · attempt 1 · done]\nsummary  fixed\nchanges  commit-a\nverification  passed';

describe('persistent report identity at the actual mail boundary', () => {
    it('keeps identity across client restarts and changing automatic annotations', async () => {
        const first = await send(report + '\ncost  1 call\nmodel  claude-opus-5\ntrace  old tail');
        const retry = await send(report + '\ncost  9 calls\nmodel  gpt-6-astra\ntrace  new tail');
        expect(first.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
        expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    });

    it('does not swallow new status, attempt, dispatch, commit, verification or explicit evidence', async () => {
        const base = (await send(report)).idempotencyKey;
        expect(base).toBeTruthy();
        for (const text of [report.replace('done]', 'blocked]'), report.replace('attempt 1', 'attempt 2'),
            report + '\ndispatch  second-phase', report.replace('commit-a', 'commit-b'),
            report + '\nverification  another check', report + '\nevidence  probe-sha-2']) {
            expect((await send(text)).idempotencyKey).not.toBe(base);
        }
        expect((await send(report, 'another-worker')).idempotencyKey).not.toBe(base);
        expect((await send(report, 'worker', 'another-hub')).idempotencyKey).not.toBe(base);
    });

    it('hashes full business fields before display truncation', async () => {
        const long = '[report long · attempt 1 · done]\nsummary  ' + 'x'.repeat(1300);
        const first = await send(long + 'A');
        const second = await send(long + 'B');
        expect(first.idempotencyKey).toBeTruthy();
        expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    });

    it('does not pretend an older server supports safe report retries', async () => {
        vi.mocked(axios.get).mockResolvedValue({ data: { key: Buffer.alloc(32).toString('base64') } });
        const result = await new AgentMailClient('test-token', 'worker').send('hub', report, 1);
        expect(result.ok).toBe(false);
        expect(axios.post).not.toHaveBeenCalled();
    });

    it('leaves ordinary text as distinct user-requested sends', async () => {
        expect((await send('Please look at this')).idempotencyKey).toBeUndefined();
    });
});
