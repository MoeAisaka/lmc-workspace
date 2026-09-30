import { describe, expect, it } from 'vitest';
import { decideQueryBoundary } from './queryBoundary';

const base = { runningModeHash: 'a', batchHash: 'a', isolate: false, carried: false, backgroundTasks: 0 };

describe('decideQueryBoundary', () => {
    it('keeps the query for a batch in the same mode', () => {
        expect(decideQueryBoundary(base)).toBe('continue');
        expect(decideQueryBoundary({ ...base, runningModeHash: null, batchHash: 'b' })).toBe('continue');
    });

    it('restarts the query for a new mode when nothing runs in the background', () => {
        expect(decideQueryBoundary({ ...base, batchHash: 'b' })).toBe('restart');
    });

    it('delivers into the running query while a background task keeps Claude alive', () => {
        expect(decideQueryBoundary({ ...base, batchHash: 'b', backgroundTasks: 1 })).toBe('defer-mode-change');
    });

    it('still gives an isolated command its own query', () => {
        expect(decideQueryBoundary({ ...base, isolate: true, backgroundTasks: 2 })).toBe('restart');
        expect(decideQueryBoundary({ ...base, isolate: true, carried: true })).toBe('continue');
    });
});
