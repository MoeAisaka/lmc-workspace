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
});
