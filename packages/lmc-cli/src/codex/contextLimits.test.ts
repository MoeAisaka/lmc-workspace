import { expect, it } from 'vitest';
import { validateCodexContextLimits, codexContextLimitArgs } from './contextLimits';
it('omits backend defaults and allows independent overrides', () => {
    expect(codexContextLimitArgs(undefined)).toEqual([]);
    expect(codexContextLimitArgs({ autoCompactTokenLimit: 200000 })).toEqual(['--auto-compact-token-limit', '200000']);
});
it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100'])('rejects invalid tokens %s', n => {
    expect(() => validateCodexContextLimits({ contextWindow: n })).toThrow();
});
it('rejects invalid structures and pairs', () => {
    for (const value of [null, [], '100', { contextWindow: 100, autoCompactTokenLimit: 100 }, { contextWindow: 100, autoCompactTokenLimit: 101 }]) {
        expect(() => validateCodexContextLimits(value)).toThrow();
    }
});
