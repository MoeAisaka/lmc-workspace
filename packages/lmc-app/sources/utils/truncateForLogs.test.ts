import { describe, expect, it } from 'vitest';
import { truncateForLogs, serializeForLogs } from './truncateForLogs';

describe('truncateForLogs', () => {
    it('caps how many array items survive, and says how many were dropped', () => {
        const result = truncateForLogs(Array.from({ length: 1000 }, (_, i) => i)) as unknown[];
        expect(result).toHaveLength(51);
        expect(result[50]).toBe('[... 950 more items]');
        // A short array is untouched.
        expect(truncateForLogs([1, 2, 3])).toEqual([1, 2, 3]);
    });

    it('caps how many object keys survive', () => {
        const wide = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i]));
        const result = truncateForLogs(wide) as Record<string, unknown>;
        expect(Object.keys(result)).toHaveLength(51);
        expect(result['[...]']).toBe('150 more keys');
    });

    it('still truncates long strings and deep nesting', () => {
        expect(String(truncateForLogs('x'.repeat(2000)))).toContain('[... TRUNCATED FOR LOGS]');
        let deep: any = 'leaf';
        for (let i = 0; i < 20; i++) deep = { next: deep };
        expect(JSON.stringify(truncateForLogs(deep))).toContain('[...]');
    });
});

describe('serializeForLogs', () => {
    it('bounds a single entry even when the payload is wide and deep', () => {
        // Without a cap this is megabytes: every entry is held in the in-memory
        // log ring, so one such line used to be enough to bloat the tab.
        const huge = Array.from({ length: 5000 }, (_, i) => ({
            id: `message-${i}`, body: 'y'.repeat(5000), nested: { a: 1, b: 2, c: 3 },
        }));
        const serialized = serializeForLogs(huge);
        expect(serialized.length).toBeLessThanOrEqual(8000 + 40);
        expect(serialized).toContain('[... TRUNCATED FOR LOGS]');
    });

    it('leaves ordinary values readable', () => {
        expect(serializeForLogs('hello')).toBe('hello');
        expect(serializeForLogs({ a: 1 })).toBe('{\n  "a": 1\n}');
    });

    it('does not throw on a circular structure', () => {
        const circular: any = { name: 'root' };
        circular.self = circular;
        expect(() => serializeForLogs(circular)).not.toThrow();
    });
});
