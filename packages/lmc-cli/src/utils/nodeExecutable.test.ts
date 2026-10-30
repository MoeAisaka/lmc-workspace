import { describe, expect, it } from 'vitest';
import { resolveNodeExecutable } from './nodeExecutable';

describe('resolveNodeExecutable', () => {
    it('prefers stable Homebrew bin/node symlink over versioned Cellar path on darwin', () => {
        expect(resolveNodeExecutable(
            '/opt/homebrew/Cellar/node/26.0.0/bin/node',
            'darwin',
            (p) => p === '/opt/homebrew/bin/node',
        )).toBe('/opt/homebrew/bin/node');

        expect(resolveNodeExecutable(
            '/opt/homebrew/Cellar/node@24/24.18.0/bin/node',
            'darwin',
            (p) => p === '/opt/homebrew/bin/node',
        )).toBe('/opt/homebrew/bin/node');
    });

    it('leaves non-Homebrew and non-darwin paths untouched', () => {
        expect(resolveNodeExecutable('C:\\Program Files\\nodejs\\node.exe', 'win32', () => true))
            .toBe('C:\\Program Files\\nodejs\\node.exe');
        expect(resolveNodeExecutable('/Users/dev/.nvm/versions/node/v22.0.0/bin/node', 'darwin', () => true))
            .toBe('/Users/dev/.nvm/versions/node/v22.0.0/bin/node');
    });
});
