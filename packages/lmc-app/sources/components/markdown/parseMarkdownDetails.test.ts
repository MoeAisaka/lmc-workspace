import { describe, expect, it } from 'vitest';
import { parseMarkdown } from './parseMarkdown';

describe('Markdown details', () => {
    it('renders the reported history block as a disclosure between normal paragraphs', () => {
        const blocks = parseMarkdown('前文\n\n<details>\n\n<summary>历史核对记录</summary>\n\nMCP 搜索记录\n\n</details>\n\n后文');
        expect(blocks.map(block => block.type)).toEqual(['text', 'details', 'text']);
        expect(blocks[1]).toEqual({ type: 'details', summary: [{ text: '历史核对记录', styles: [], url: null }], content: 'MCP 搜索记录', open: false });
    });

    it('keeps nested Markdown, links, lists and tables available to the normal parser', () => {
        const [block] = parseMarkdown('<details open>\n<summary>**证据**与记录</summary>\n\n- [说明](https://example.com)\n\n| A | B |\n|---|---|\n| 1 | 2 |\n</details>');
        if (block.type !== 'details') throw Error('missing disclosure');
        expect(block.open).toBe(true);
        expect(block.summary[0].styles).toContain('bold');
        const body = parseMarkdown(block.content);
        expect(body.map(block => block.type)).toEqual(['list', 'table']);
        expect(body[0]).toMatchObject({ items: [{ spans: [{ url: 'https://example.com' }] }] });
    });

    it('matches nested closing tags and preserves same-line trailing text', () => {
        const blocks = parseMarkdown('<details><summary>外层</summary>\n<details><summary>内层</summary>证据</details>\n外层末尾\n</details>后文');
        expect(blocks).toHaveLength(2);
        if (blocks[0].type !== 'details') throw Error('missing disclosure');
        const body = parseMarkdown(blocks[0].content);
        expect(body.map(block => block.type)).toEqual(['details', 'text']);
        expect(body[0]).toMatchObject({ content: '证据' });
        expect(blocks[1]).toMatchObject({ type: 'text', content: [{ text: '后文' }] });
    });

    it('does not treat inline or fenced code examples as closing tags', () => {
        const [block] = parseMarkdown('<details>\n<summary>示例</summary>\n`</details>`\n```html\n</details>\n<details>\n```\n结束\n</details>');
        if (block.type !== 'details') throw Error('missing disclosure');
        expect(parseMarkdown(block.content).map(block => block.type)).toEqual(['text', 'code-block', 'text']);
        expect(block.content).toContain('结束');
        expect(parseMarkdown('```html\n<details><summary>示例</summary></details>\n```')[0].type).toBe('code-block');
        expect(parseMarkdown('`<details>`')[0].type).toBe('text');
    });

    it('accepts unfinished streamed summaries and bodies without losing text', () => {
        expect(parseMarkdown('<details>\n<summary>历史')[0]).toMatchObject({ type: 'details', summary: [{ text: '历史' }], content: '' });
        expect(parseMarkdown('<details>\n<summary>历史</summary>\n部分证据')[0]).toMatchObject({ type: 'details', summary: [{ text: '历史' }], content: '部分证据' });
        expect(parseMarkdown('<details>\n内容\n</details>')[0]).toMatchObject({ type: 'details', summary: [], content: '内容' });
    });

    it('ignores HTML attributes except boolean open and leaves other HTML inert', () => {
        expect(parseMarkdown('<DETAILS OPEN="">\n<SUMMARY>标题</SUMMARY>内容</DETAILS>')[0]).toMatchObject({ type: 'details', open: true, content: '内容' });
        expect(parseMarkdown('<details title="open" onclick="alert(1)">内容</details>')[0]).toMatchObject({ type: 'details', open: false });
        expect(parseMarkdown('<script>alert(1)</script>')[0]).toMatchObject({ type: 'text', content: [{ text: '<script>alert(1)</script>' }] });
        expect(parseMarkdown('<details-other>')[0].type).toBe('text');
    });
});
