import { describe, expect, it } from 'vitest';
import { nativeResumeIdentity } from './policy';
const id = '11eab19e-31a0-4fbe-a5b2-66a4d1e21319';
describe('native restore arguments', () => {
    it('accepts the daemon resume flag and preserves known permission/chrome choices', () => {
        expect(nativeResumeIdentity(['--resume', id, '--chrome', '--dangerously-skip-permissions'], id)).toBe(id);
        expect(nativeResumeIdentity(['--resume', id], null)).toBe(id);
    });
    it('does not silently change identity or ignore unsupported options', () => {
        expect(() => nativeResumeIdentity(['--resume', id], 'other')).toThrow('身份');
        expect(() => nativeResumeIdentity(['--resume'], null)).toThrow('ID');
        expect(() => nativeResumeIdentity(['--continue'], null)).toThrow('参数');
        expect(() => nativeResumeIdentity(['--worktree', 'secret-value'], id)).toThrow('--worktree');
    });
});
