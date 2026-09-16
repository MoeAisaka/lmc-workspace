import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { AgentMailClient } from './agentMail';

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), isAxiosError: () => false } }));
vi.mock('@/configuration', () => ({ configuration: { serverUrl: 'https://server.test' } }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));

beforeEach(() => {
    vi.mocked(axios.get).mockReset().mockResolvedValue({ data: { key: Buffer.alloc(32).toString('base64'), mailProtocol: 2 } });
    vi.mocked(axios.post).mockReset().mockResolvedValue({ data: { id: 'stored-mail', duplicate: false } });
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
