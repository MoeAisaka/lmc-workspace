import { describe, expect, it } from 'vitest';
import type { Metadata } from '@/api/types';
import { claudeTurnFailure, createQuotaReporter, isQuotaFailure } from './quota';

const worker = (state: string): Metadata => ({ orchestration: { role: 'worker', hub: { sessionId: 'H', boundAt: 1, by: 'auto' }, board: [{ id: 't1', title: 'x', state, attempt: 2, counterpart: 'H', firstAt: 1, updatedAt: 2 }] } } as unknown as Metadata);

describe('quota reporter', () => {
    it('recognises quota and rate-limit failures, not ordinary ones', () => {
        expect(isQuotaFailure('Claude AI usage limit reached|1789200000')).toBe(true);
        expect(isQuotaFailure('429 Too Many Requests')).toBe(true);
        expect(isQuotaFailure('insufficient_quota: You exceeded your current quota')).toBe(true);
        expect(isQuotaFailure('ENOENT: no such file')).toBe(false);
        expect(claudeTurnFailure({ type: 'result', is_error: true, result: 'rate limit' })).toBe('rate limit');
        expect(claudeTurnFailure({ type: 'assistant', message: { content: [{ type: 'text', text: 'Claude AI usage limit reached|5' }] } })).toContain('usage limit');
        expect(claudeTurnFailure({ type: 'result', is_error: false })).toBeNull();
    });

    it('reports every dispatched task to the hub as blocked by quota, once', async () => {
        let metadata = worker('dispatched');
        const mails: { to: string; text: string }[] = [];
        let now = 1000;
        const reporter = createQuotaReporter({ selfId: 'W', metadata: () => metadata, updateMetadata: async (u) => { metadata = u(metadata); }, sendMail: async (to, text) => { mails.push({ to, text }); return { ok: true }; }, now: () => now });
        expect(await reporter.onFailure('disk full')).toBe(false);
        expect(await reporter.onFailure('429 rate limit exceeded')).toBe(true);
        expect(mails).toHaveLength(1);
        expect(mails[0].to).toBe('H');
        expect(mails[0].text.startsWith('[report t1 · attempt 2 · blocked]')).toBe(true);
        expect(mails[0].text).toMatch(/blocked\s+quota — 429/);
        expect(metadata.orchestration?.board?.[0].state).toBe('blocked');
        // Repeated failures within the cooldown do not spam the hub.
        metadata = worker('dispatched');
        await reporter.onFailure('429 again');
        expect(mails).toHaveLength(1);
        now += 11 * 60_000;
        await reporter.onFailure('429 again');
        expect(mails).toHaveLength(2);
    });

    it('sends a notice when there is nothing dispatched, and stays quiet as a hub', async () => {
        const mails: string[] = [];
        const reporter = createQuotaReporter({ selfId: 'W', metadata: () => worker('done'), updateMetadata: async () => undefined, sendMail: async (_to, text) => { mails.push(text); return { ok: true }; } });
        expect(await reporter.onFailure('usage limit reached')).toBe(true);
        expect(mails[0]).toContain('[notice] worker W hit an engine quota');
        const hub = createQuotaReporter({ selfId: 'H', metadata: () => ({ orchestration: { role: 'hub', workers: [] } } as unknown as Metadata), updateMetadata: async () => undefined, sendMail: async () => ({ ok: true }) });
        expect(await hub.onFailure('usage limit reached')).toBe(false);
    });
});
