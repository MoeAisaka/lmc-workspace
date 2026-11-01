import { describe, expect, it } from 'vitest';
import { parseMarkdownSpans } from './parseMarkdownSpans';

const linked = (markdown: string) => parseMarkdownSpans(markdown, false)
    .filter((span) => span.url)
    .map((span) => span.url);

describe('parseMarkdownSpans file links', () => {
    it('links a path written into prose', () => {
        expect(linked('已写入 /Volumes/Work/cases.json，请查收')).toEqual(['/Volumes/Work/cases.json']);
    });

    it('links a path in backticks, and leaves a command alone', () => {
        expect(linked('run `pnpm test` on `packages/app/index.tsx`')).toEqual(['packages/app/index.tsx']);
    });

    it('keeps a url a url', () => {
        expect(linked('see https://example.com/a.json for the shape')).toEqual(['https://example.com/a.json']);
    });

    it('carries an explicit markdown link target through unchanged', () => {
        expect(linked('[清单](data/cases.json)')).toEqual(['data/cases.json']);
    });

    it('leaves the surrounding text in place', () => {
        const spans = parseMarkdownSpans('见 src/a.ts 第二段', false);
        expect(spans.map((span) => span.text).join('')).toBe('见 src/a.ts 第二段');
    });

    it('recursively parses inline code inside markdown links without exposing raw backticks', () => {
        const spans = parseMarkdownSpans('请查看 [`libraryLifecycle`](file:///Volumes/Work/Agent%20Workspace/src/lifecycle.ts#L5-L12)', false);
        expect(spans).toEqual([
            { styles: [], text: '请查看 ', url: null },
            {
                styles: ['code'],
                text: 'libraryLifecycle',
                url: 'file:///Volumes/Work/Agent%20Workspace/src/lifecycle.ts#L5-L12',
            },
        ]);
    });

    it('recursively parses inline code and links nested inside bold, italic, and strikethrough', () => {
        const spans = parseMarkdownSpans('**方案 A（含 `game_expansions` 与 [设计稿](https://example.com/a_(b))）** ~~旧版~~', false);
        expect(spans).toEqual([
            { styles: ['bold'], text: '方案 A（含 ', url: null },
            { styles: ['bold', 'code'], text: 'game_expansions', url: null },
            { styles: ['bold'], text: ' 与 ', url: null },
            { styles: ['bold'], text: '设计稿', url: 'https://example.com/a_(b)' },
            { styles: ['bold'], text: '）', url: null },
            { styles: [], text: ' ', url: null },
            { styles: ['strikethrough'], text: '旧版', url: null },
        ]);
    });

    it('preserves snake_case identifiers and arithmetic asterisks as literal text', () => {
        expect(parseMarkdownSpans('字段 is_completed_at 与 game_play_plans，尺寸 3 * 4 = 12', false)).toEqual([
            { styles: [], text: '字段 is_completed_at 与 game_play_plans，尺寸 3 * 4 = 12', url: null },
        ]);
    });
});
