import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agyUsageRecord, claudeUsageRecord, UsageCollector, UsageOutbox } from './usageAnalytics';
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
    it('rejects unsafe integer sums in agyUsageRecord when input + cacheRead or allWork exceeds MAX_SAFE_INTEGER', () => {
        expect(
            agyUsageRecord(
                { input_tokens: Number.MAX_SAFE_INTEGER, cache_read_tokens: 1, output_tokens: 0, total_tokens: 10 },
                origin,
                'overflow-native-total',
                'gemini-4-argon-high',
                Date.now(),
            ),
        ).toBeNull();
        expect(
            agyUsageRecord(
                { input_tokens: 10, cache_read_tokens: 0, output_tokens: Number.MAX_SAFE_INTEGER, total_tokens: 10 },
                origin,
                'overflow-all-work',
                'gemini-4-argon-high',
                Date.now(),
            ),
        ).toBeNull();
    });
    it('drains records enqueued concurrently while send() is in flight in UsageOutbox', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'lmc-usage-concurrent-'));
        try {
            const path = join(dir, 'stats.json');
            const received: any[] = [];
            let firstSend = true;
            let outbox!: UsageOutbox;
            outbox = new UsageOutbox(
                path,
                async (record) => {
                    received.push(record);
                    if (firstSend) {
                        firstSend = false;
                        // Enqueue a second distinct record while the first send() is still in flight!
                        outbox.enqueue((c) => c.codex({ ...event(2000, 600, 100), threadId: 'concurrent-thread' }, origin, 'model'));
                    }
                    return true;
                },
                () => {},
            );
            outbox.enqueue((c) => c.codex(event(1000, 300, 50), origin, 'model'));
            await outbox.flush();
            expect(received).toHaveLength(2);
            expect(JSON.parse(await readFile(path, 'utf8')).pending).toHaveLength(0);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    it('rejects ensureDurable() while offline when outbox write/rename fails, then resolves once durable (R9-P2-6)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'lmc-usage-durable-'));
        try {
            const path = join(dir, 'stats.json');
            let failWrite = true;
            const outbox = new UsageOutbox(
                path,
                async () => false,
                () => {},
                {
                    writeAtomicFile: async (tmpPath, content) => {
                        if (failWrite) {
                            throw Object.assign(new Error('ENOSPC: outbox disk full'), { code: 'ENOSPC' });
                        }
                        const { writeFile } = await import('node:fs/promises');
                        await writeFile(tmpPath, content, { mode: 0o600 });
                    },
                },
            );
            outbox.enqueue(() =>
                agyUsageRecord(
                    { input_tokens: 40, output_tokens: 10, cache_read_tokens: 0, total_tokens: 50 },
                    origin,
                    'conv-1:sql:1',
                    'gemini-3.1-pro-high',
                    1_700_000_000_000,
                ),
            );
            await expect(outbox.ensureDurable()).rejects.toThrow(/ENOSPC/);

            failWrite = false;
            await expect(outbox.ensureDurable()).resolves.toBeUndefined();

            const expectedRecord = agyUsageRecord(
                { input_tokens: 40, output_tokens: 10, cache_read_tokens: 0, total_tokens: 50 },
                origin,
                'conv-1:sql:1',
                'gemini-3.1-pro-high',
                1_700_000_000_000,
            )!;
            const saved = JSON.parse(await readFile(path, 'utf8'));
            expect(saved.pending).toHaveLength(1);
            expect(saved.pending[0].key).toBe(expectedRecord.key);
            expect(saved.pending[0].tokens).toEqual({
                input: 40,
                output: 10,
                cacheRead: 0,
                cacheWrite: 0,
            });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
