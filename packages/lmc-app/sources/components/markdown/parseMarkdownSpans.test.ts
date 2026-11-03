import { describe, expect, it } from 'vitest';
import { parseMarkdownSpans, spansLength } from './parseMarkdownSpans';

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

    it('converts <br>, <br/>, and <br /> into clean line breaks while trimming surrounding horizontal spaces', () => {
        const spans = parseMarkdownSpans(
            '❌ **不能！** <br>Free 档在 Codex 仅开放桌面端入门小模型 `GPT-6 Luna`<br/>第二行 <BR /> 第三行',
            false
        );
        expect(spans).toEqual([
            { styles: [], text: '❌ ', url: null },
            { styles: ['bold'], text: '不能！', url: null },
            { styles: [], text: '\nFree 档在 Codex 仅开放桌面端入门小模型 ', url: null },
            { styles: ['code'], text: 'GPT-6 Luna', url: null },
            { styles: [], text: '\n第二行\n第三行', url: null },
        ]);
    });

    it('keeps <br> literal inside backtick code, backslash escapes, HTML entities, and generics', () => {
        expect(parseMarkdownSpans('代码 `<br>`、转义 \\<br>、实体 &lt;br&gt; 与泛型 Array<string> / Map<s, b>', false)).toEqual([
            { styles: [], text: '代码 ', url: null },
            { styles: ['code'], text: '<br>', url: null },
            { styles: [], text: '、转义 <br>、实体 <br> 与泛型 Array<string> / Map<s, b>', url: null },
        ]);
    });

    it('parses paired inline HTML formatting tags, autolinks, and inline lists in table prose', () => {
        const spans = parseMarkdownSpans(
            '<strong>重点</strong> <em>说明</em> <del>废弃</del> <code>a &amp;&amp; b</code> <a href="https://example.com">官网</a> <https://openai.com>',
            false
        );
        expect(spans).toEqual([
            { styles: ['bold'], text: '重点', url: null },
            { styles: [], text: ' ', url: null },
            { styles: ['italic'], text: '说明', url: null },
            { styles: [], text: ' ', url: null },
            { styles: ['strikethrough'], text: '废弃', url: null },
            { styles: [], text: ' ', url: null },
            { styles: ['code'], text: 'a && b', url: null },
            { styles: [], text: ' ', url: null },
            { styles: [], text: '官网', url: 'https://example.com' },
            { styles: [], text: ' ', url: null },
            { styles: [], text: 'https://openai.com', url: 'https://openai.com' },
        ]);

        const listSpans = parseMarkdownSpans('规则如下 <ul><li><b>第一条</b></li><li>第二条&#124;补充</li></ul>', false);
        expect(listSpans.map((s) => s.text).join('')).toBe('规则如下\n• 第一条\n• 第二条|补充');
    });

    it('measures spansLength by the widest visual line rather than summing across <br> line breaks', () => {
        const multiLine = parseMarkdownSpans('第一行<br>第二行更长一些<br>三', false);
        const longestSingleLine = parseMarkdownSpans('第二行更长一些', false);
        expect(spansLength(multiLine)).toBe(spansLength(longestSingleLine));
    });

    it('parses inline math ($...$, \\(...\\), $$...$$) including nested inside bold, italic, and links', () => {
        const spans = parseMarkdownSpans(
            String.raw`**加粗 $x_1 + x_2$** 与 *斜体 $a * b$*、链接 [$E=mc^2$](https://example.com) 及 \(\alpha + \beta\) 和行内 $$\sum_{i=1}^n i$$`,
            false
        );
        expect(spans).toEqual([
            { styles: ['bold'], text: '加粗 ', url: null },
            { styles: ['bold'], text: 'x_1 + x_2', url: null, math: 'inline' },
            { styles: [], text: ' 与 ', url: null },
            { styles: ['italic'], text: '斜体 ', url: null },
            { styles: ['italic'], text: 'a * b', url: null, math: 'inline' },
            { styles: [], text: '、链接 ', url: null },
            { styles: [], text: 'E=mc^2', url: 'https://example.com', math: 'inline' },
            { styles: [], text: ' 及 ', url: null },
            { styles: [], text: String.raw`\alpha + \beta`, url: null, math: 'inline' },
            { styles: [], text: ' 和行内 ', url: null },
            { styles: [], text: String.raw`\sum_{i=1}^n i`, url: null, math: 'display' },
        ]);
    });

    it('avoids false positives on currency amounts, shell variables, escaped dollars, code spans, and footnotes', () => {
        expect(
            parseMarkdownSpans('满月 $100，Batch 仅 $1.00 输入 / $0.05 缓存命中 / $5.00 输出 per 1M', false)
        ).toEqual([
            { styles: [], text: '满月 $100，Batch 仅 $1.00 输入 / $0.05 缓存命中 / $5.00 输出 per 1M', url: null },
        ]);

        // Currency earlier on the same line must NOT block a real formula later on the line
        expect(
            parseMarkdownSpans('满月额度 $100，计算公式为 $x + y = 100$。', false)
        ).toEqual([
            { styles: [], text: '满月额度 $100，计算公式为 ', url: null },
            { styles: [], text: 'x + y = 100', url: null, math: 'inline' },
            { styles: [], text: '。', url: null },
        ]);

        expect(parseMarkdownSpans('区间 $10~$20，月费 $10/mo | $20/mo', false)).toEqual([
            { styles: [], text: '区间 $10~$20，月费 $10/mo | $20/mo', url: null },
        ]);

        expect(parseMarkdownSpans('环境变量 $PATH:$HOME 与 ${FOO}/${BAR}，转义 \\$100，代码 `$x + y$`，脚注 \\[1\\]', false)).toEqual([
            { styles: [], text: '环境变量 $PATH:$HOME 与 ${FOO}/${BAR}，转义 $100，代码 ', url: null },
            { styles: ['code'], text: '$x + y$', url: null },
            { styles: [], text: '，脚注 [1]', url: null },
        ]);
    });

    it('measures spansLength of LaTeX math by rendered plain text instead of raw macro source', () => {
        const mathSpans = parseMarkdownSpans(String.raw`$\mathbf{36.5\text{cm}}$`, false);
        const plainSpans = parseMarkdownSpans('36.5cm', false);
        expect(spansLength(mathSpans)).toBe(spansLength(plainSpans));
    });
});
