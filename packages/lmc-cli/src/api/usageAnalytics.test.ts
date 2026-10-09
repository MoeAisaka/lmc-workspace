import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeUsageRecord, UsageCollector, UsageOutbox } from './usageAnalytics';
const origin = { sessionId: 'lmc-session', machineId: 'lmc-machine' };
const event = (input: number, cached: number, output: number, lastInput = 100, lastCached = 40, lastOutput = 10) => ({
    type: 'token_count', threadId: 'thread', total: { inputTokens: input, cachedInputTokens: cached, outputTokens: output },
    last: { inputTokens: lastInput, cachedInputTokens: lastCached, outputTokens: lastOutput },
});
describe('LMC usage collection', () => {
    it('joins Claude fragments by provider message, without persisting content', () => {
        const body = { type: 'assistant', timestamp: '2026-10-05T00:00:00Z', uuid: 'fragment-a', message: { id: 'request', model: 'claude', content: 'PRIVATE', usage: { input_tokens: 5, output_tokens: 8, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 } } };
        const a = claudeUsageRecord(body, origin)!;
        expect(a.tokens).toEqual({ input: 5, output: 8, cacheRead: 20, cacheWrite: 3 });
        expect(claudeUsageRecord({ ...body, uuid: 'fragment-b' }, origin)?.key).toBe(a.key);
        expect(JSON.stringify(a)).not.toContain('PRIVATE');
    });
    it('uses only latest usage at first observation, subtracts cache and deduplicates repeats', () => {
        const c = new UsageCollector();
        expect(c.codex(event(1000, 300, 50), origin, null)?.tokens).toEqual({ input: 60, output: 10, cacheRead: 40, cacheWrite: 0 });
        expect(c.codex(event(1000, 300, 50), origin, null)).toBeNull();
        expect(c.codex(event(1500, 700, 80), origin, null)?.tokens).toEqual({ input: 100, cacheRead: 400, output: 30, cacheWrite: 0 });
        expect(c.codex(event(900, 200, 20), origin, null)).toBeNull();
    });
    it('isolates provider streams and includes skipped cumulative updates', () => {
        const c = new UsageCollector(); c.codex(event(1000, 300, 50), origin, null);
        expect(c.codex(event(2000, 600, 100), origin, null)?.tokens).toEqual({ input: 700, cacheRead: 300, output: 50, cacheWrite: 0 });
        expect(c.codex({ ...event(2000, 600, 100), threadId: 'another' }, origin, null)?.tokens.output).toBe(10);
        expect(c.codex({ type: 'token_count' }, origin, null)).toBeNull();
    });
    it('seeds idle resume and reset counters without attributing old usage to today', () => {
        const c = new UsageCollector();
        expect(c.codex(event(1000, 300, 50), origin, null, false)).toBeNull();
        const a = c.codex(event(1500, 500, 100), origin, null)!;
        expect(a.tokens).toEqual({ input: 300, output: 50, cacheRead: 200, cacheWrite: 0 });
        expect(c.codex(event(1000, 300, 50), origin, null)).toBeNull();
        const b = c.codex(event(1500, 500, 100), origin, null)!;
        expect(b.tokens).toEqual(a.tokens); expect(b.key).not.toBe(a.key);
    });
    it('persists pending statistics and checkpoints before send, resumes after outage', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'lmc-usage-'));
        try {
            const path = join(dir, 'stats.json'); const received: any[] = [];
            const a = new UsageOutbox(path, async () => false, () => { throw new Error('disk failure'); });
            a.enqueue(c => c.codex(event(1000, 300, 50), origin, 'model'));
            await a.flush();
            expect(JSON.parse(await readFile(path, 'utf8')).pending).toHaveLength(1);
            const b = new UsageOutbox(path, async r => { received.push(r); return true; }, () => {});
            await b.flush();
            expect(received).toHaveLength(1);
            b.enqueue(c => c.codex(event(1000, 300, 50), origin, 'model'));
            await b.flush();
            expect(received).toHaveLength(1);
            expect(JSON.parse(await readFile(path, 'utf8')).pending).toHaveLength(0);
        } finally { await rm(dir, { recursive: true, force: true }); }
    });
});
