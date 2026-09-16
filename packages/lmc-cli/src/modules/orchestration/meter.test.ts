import { describe, expect, it } from 'vitest';
import { claudeTurnUsage, codexTurnUsage, createTaskMeter } from './meter';

describe('task meter', () => {
    it('sums the turns since a task was dispatched', () => {
        const meter = createTaskMeter();
        meter.add({ inputTokens: 1000, outputTokens: 200, usd: 0.01 }, 1000);
        meter.add({ inputTokens: 25_000, outputTokens: 1500, usd: 0.12 }, 5000);
        meter.add({ inputTokens: 3000, outputTokens: 100, usd: 0.02 }, 9000);
        expect(meter.since(4000)).toBe('2 calls · in 28k · out 1.6k · $0.14');
        expect(meter.since(10_000)).toBeNull();
        const codex = createTaskMeter();
        codex.add(codexTurnUsage({ type: 'token_count', total: { inputTokens: 9, outputTokens: 9 }, last: { inputTokens: 500, outputTokens: 50 } })!, 1);
        expect(codex.since(0)).toBe('1 call · in 500 · out 50');
    });

    it('reads a Claude result and a Codex token count', () => {
        expect(claudeTurnUsage({ type: 'assistant', message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } } })).toEqual({ inputTokens: 100, outputTokens: 5 });
        const long = claudeTurnUsage({ type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 1 }, content: [{ type: 'text', text: 'x'.repeat(400) }] } })!;
        expect(long.estimated).toBe(true); expect(long.outputTokens).toBeGreaterThan(90);
        const est = createTaskMeter(); est.add(long, 1); expect(est.since(0)).toMatch(/out ≈/);
        est.reconcile({ inputTokens: 10, outputTokens: 120 }, 2); expect(est.since(0)).toBe('1 call · in 10 · out 120');
        expect(claudeTurnUsage({ type: 'result', total_cost_usd: 0.003 })).toBeNull();
        const m = createTaskMeter();
        m.add({ inputTokens: 100, outputTokens: 2 }, 1); m.add({ inputTokens: 200, outputTokens: 3 }, 2);
        m.reconcile({ inputTokens: 300, outputTokens: 450, usd: 0.05 }, 3);
        expect(m.since(0)).toBe('2 calls · in 300 · out 450 · $0.050');
        expect(m.turnsSince(0)).toBe(2);
        expect(claudeTurnUsage({ type: 'assistant' })).toBeNull();
        expect(codexTurnUsage({ type: 'token_count' })).toBeNull();
    });
});
