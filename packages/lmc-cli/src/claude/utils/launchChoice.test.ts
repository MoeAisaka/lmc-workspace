import { describe, expect, it } from 'vitest';
import { resolveSessionChoice } from './launchChoice';

describe('session choices against launch arguments', () => {
    it('keeps the launched value when the first snapshot has nothing picked', () => {
        expect(resolveSessionChoice({ initial: true, launched: 'medium', current: 'medium', picked: null })).toBe('medium');
        expect(resolveSessionChoice({ initial: true, launched: 'claude-x', current: 'claude-x', picked: '' })).toBe('claude-x');
    });
    it('clears on a later reset and when nothing was launched', () => {
        expect(resolveSessionChoice({ initial: false, launched: 'medium', current: 'medium', picked: null })).toBeUndefined();
        expect(resolveSessionChoice({ initial: true, launched: undefined, current: 'high', picked: null })).toBeUndefined();
    });
    it('applies an explicit pick at any time and ignores an absent field', () => {
        expect(resolveSessionChoice({ initial: true, launched: 'medium', current: 'medium', picked: 'high' })).toBe('high');
        expect(resolveSessionChoice({ initial: false, launched: 'medium', current: 'low', picked: undefined })).toBe('low');
    });
});
