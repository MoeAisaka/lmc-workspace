import { describe, expect, it } from 'vitest';
import { calculateCost } from './pricing';

const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 } as any;

describe('calculateCost', () => {
    it('prices Haiku 5.5 at its own rate, not as Claude 3 Haiku', () => {
        expect(calculateCost(usage, 'claude-haiku-5-5')).toMatchObject({ input: 0.10, output: 0.50 });
        expect(calculateCost(usage, 'claude-haiku-5-5[1m]')).toMatchObject({ input: 0.10, output: 0.50 });
    });

    it('still prices Haiku 4.5 by its dated id', () => {
        expect(calculateCost(usage, 'claude-haiku-4-5-20251001')).toMatchObject({ input: 1.0, output: 5.0 });
    });
});
