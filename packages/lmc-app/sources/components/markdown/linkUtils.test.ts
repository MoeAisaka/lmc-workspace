import { describe, expect, it } from 'vitest';
import { findFileReferences, isHttpMarkdownLink, parseFileReference } from './linkUtils';

describe('isHttpMarkdownLink', () => {
    it('accepts http and https links', () => {
        expect(isHttpMarkdownLink('http://example.com')).toBe(true);
        expect(isHttpMarkdownLink('https://example.com/docs')).toBe(true);
        expect(isHttpMarkdownLink(' HTTPS://example.com/docs ')).toBe(true);
    });

    it('rejects non-http schemes and path-like targets', () => {
        expect(isHttpMarkdownLink('mailto:test@example.com')).toBe(false);
        expect(isHttpMarkdownLink('data:text/plain,hello')).toBe(false);
        expect(isHttpMarkdownLink('/Users/me/project/file.ts')).toBe(false);
        expect(isHttpMarkdownLink('packages/lmc-app/index.tsx')).toBe(false);
    });
});

describe('parseFileReference', () => {
    it('reads absolute, home and relative paths', () => {
        expect(parseFileReference('/Volumes/Work/cases.json')).toEqual({ path: '/Volumes/Work/cases.json', line: null });
        expect(parseFileReference('~/notes/todo.md')).toEqual({ path: '~/notes/todo.md', line: null });
        expect(parseFileReference('./src/app.ts')).toEqual({ path: './src/app.ts', line: null });
        expect(parseFileReference('packages/lmc-app/index.tsx')).toEqual({ path: 'packages/lmc-app/index.tsx', line: null });
    });

    it('separates a position suffix from the name', () => {
        expect(parseFileReference('sources/a.ts:42')).toEqual({ path: 'sources/a.ts', line: 42 });
        expect(parseFileReference('sources/a.ts:42:7')).toEqual({ path: 'sources/a.ts', line: 42 });
    });

    it('accepts a bare filename, including a dotfile', () => {
        expect(parseFileReference('package.json')?.path).toBe('package.json');
        expect(parseFileReference('.env')?.path).toBe('.env');
    });

    it('refuses anything that does not name a file', () => {
        expect(parseFileReference('https://example.com/a.json')).toBeNull();
        expect(parseFileReference('mailto:a@example.com')).toBeNull();
        expect(parseFileReference('#anchor')).toBeNull();
        expect(parseFileReference('src/components')).toBeNull();
        expect(parseFileReference('v1.2.3')).toBeNull();
        expect(parseFileReference('two words.md')).toBeNull();
    });

    it('reads a file:// target as the path it wraps', () => {
        expect(parseFileReference('file:///tmp/out.log')).toEqual({ path: '/tmp/out.log', line: null });
    });
});

describe('findFileReferences', () => {
    const paths = (text: string) => findFileReferences(text).map((found) => found.reference.path);

    it('finds paths written into a sentence', () => {
        expect(paths('已写入 /Volumes/Work/cases.json，请查收')).toEqual(['/Volumes/Work/cases.json']);
        expect(paths('see packages/app/x.ts:12 and packages/app/y.ts')).toEqual(['packages/app/x.ts', 'packages/app/y.ts']);
    });

    it('leaves the sentence punctuation out of the path', () => {
        expect(paths('written to src/a.ts.')).toEqual(['src/a.ts']);
        expect(paths('(see src/a.ts)')).toEqual(['src/a.ts']);
        expect(paths('open src/a.ts:')).toEqual(['src/a.ts']);
    });

    it('requires a directory, so prose that merely ends in an extension is left alone', () => {
        expect(paths('rewrote it in node.js and shipped README.md')).toEqual([]);
        expect(paths('applies to and/or cases, 24/7')).toEqual([]);
        expect(paths('version v1.2.3 of the app')).toEqual([]);
    });
});
