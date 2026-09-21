import { describe, expect, it } from 'vitest';
import { resourceExtension, resourcePathMatches, type ResourceSearchResponse } from 'lmc-wire';
import { resourceHighlightParts, runResourceSearch, type ResourceSearchProgress } from './resourceSearch';

describe('resource search results', () => {
    it('uses leaf extensions, case-insensitive paths, and literal Unicode highlights', () => {
        expect(resourceExtension('folder.pdf/FILE.DOCX')).toBe('docx');
        expect(resourceExtension('C:\\docs\\.env')).toBe('');
        expect(resourceExtension('file.')).toBe('');
        expect(resourcePathMatches('C:\\Docs\\Guide.md', 'docs/guide')).toBe(true);
        expect(resourceHighlightParts('a+b 回滚 A+B', 'a+b')).toEqual([
            { text: 'a+b', match: true }, { text: ' 回滚 ', match: false }, { text: 'A+B', match: true },
        ]);
    });

    it('combines sequential pages and preserves honest skipped-file coverage', async () => {
        const requests: unknown[] = []; const states: ResourceSearchProgress[] = [];
        const pages: ResourceSearchResponse[] = [
            { success: true, matches: [{ path: 'a.md', nameMatch: false, snippets: [{ text: 'needle', line: 4 }] }], skipped: [], scanned: 1, total: 2, nextOffset: 1, snapshot: 's' },
            { success: true, matches: [], skipped: [{ path: 'scan.pdf', reason: 'noText' }], scanned: 2, total: 2, nextOffset: null, snapshot: 's' },
        ];
        await runResourceSearch({ query: 'needle' }, async request => { requests.push(request); return pages.shift()!; }, state => states.push(state), new AbortController().signal);
        expect(requests[1]).toMatchObject({ offset: 1, snapshot: 's' });
        expect(states[0].complete).toBe(false);
        expect(states[1]).toMatchObject({ complete: true, scanned: 2, matches: [{ path: 'a.md' }], skipped: [{ path: 'scan.pdf' }] });
    });

    it('does not publish a late reply or start another batch after cancellation', async () => {
        const controller = new AbortController(); const states: ResourceSearchProgress[] = [];
        await runResourceSearch({ query: 'old' }, async () => {
            controller.abort();
            return { success: true, matches: [{ path: 'old.md', nameMatch: true, snippets: [] }], skipped: [], scanned: 1, total: 2, nextOffset: 1, snapshot: 's' };
        }, state => states.push(state), controller.signal);
        expect(states).toEqual([]);
    });

    it('stops invalid pagination instead of making an endless RPC loop', async () => {
        await expect(runResourceSearch({ query: 'x' }, async () => ({ success: true, matches: [], skipped: [], scanned: 0, total: 4, nextOffset: 0, snapshot: 's' }), () => {}, new AbortController().signal)).rejects.toThrow('changed');
    });
});
