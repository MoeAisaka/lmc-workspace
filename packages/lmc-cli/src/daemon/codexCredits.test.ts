import { describe, expect, it, vi } from 'vitest';
import { parseCodexCredits, createCreditsReader } from './codexCredits';
const payload = (balance: unknown, unlimited = false) => ({ rateLimitsByLimitId: { codex: { credits: { balance, unlimited } }, base_model_inference: { credits: { balance: '100' } } } });
describe('official Codex credit balance', () => {
    it('preserves decimal credits and zero, never substitutes reserve percentages', () => {
        expect(parseCodexCredits(payload('53480.0723700000'), 1)?.balance).toBe(53480.07237);
        expect(parseCodexCredits(payload('0'), 1)?.balance).toBe(0);
        expect(parseCodexCredits({ rateLimitsByLimitId: { base_model_inference: { credits: { balance: '100' } } } })).toBeNull();
        for (const invalid of ['', 'NaN', -1, Infinity]) expect(parseCodexCredits(payload(invalid))?.balance).toBeNull();
        expect(parseCodexCredits(payload(null, true))?.unlimited).toBe(true);
    });
    it('coalesces reads for one minute and retains failed samples as stale', async () => {
        let now = 1000;
        const probe = vi.fn().mockResolvedValue(parseCodexCredits(payload('52.34'), now));
        const read = createCreditsReader(probe, () => now);
        await Promise.all([read(), read()]); await read(); expect(probe).toHaveBeenCalledTimes(1);
        now += 60001; probe.mockRejectedValue(new Error('private-error'));
        expect(await read()).toEqual({ balance: 52.34, unlimited: false, capturedAt: 1000, stale: true });
        expect(probe).toHaveBeenCalledTimes(2);
        now += 60001; probe.mockResolvedValue(null); expect(await read()).toBeNull();
    });
});
