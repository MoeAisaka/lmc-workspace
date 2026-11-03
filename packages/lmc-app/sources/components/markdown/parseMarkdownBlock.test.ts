import { describe, it, expect } from 'vitest';
import { parseMarkdown } from './parseMarkdown';

const spans = (text: string) => text ? [{ styles: [], text, url: null }] : [];

describe('quoted reading blocks', () => {
    it('keeps paragraphs and lists in one quotation without absorbing surrounding text', () => {
        expect(parseMarkdown('Before\n\n> **Key idea**\n>\n> - First\n> - Second\n\nAfter')).toEqual([
            { type: 'text', content: spans('Before') },
            { type: 'quote', content: '**Key idea**\n\n- First\n- Second' },
            { type: 'text', content: spans('After') },
        ]);
    });
    it('preserves code literals and peels only one level of nested quotation', () => {
        expect(parseMarkdown('```sh\n> literal\n```\n\n> > nested\n> outer')).toEqual([
            { type: 'code-block', language: 'sh', content: '> literal' },
            { type: 'quote', content: '> nested\nouter' },
        ]);
    });
});

describe('parseMarkdownBlock - table parsing', () => {

    it('parses a standard table without blank lines', () => {
        const md = [
            '| A | B |',
            '|---|---|',
            '| 1 | 2 |',
        ].join('\n');

        const blocks = parseMarkdown(md);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toEqual({
            type: 'table',
            headers: [spans('A'), spans('B')],
            rows: [[spans('1'), spans('2')]],
        });
    });

    it('parses a table with blank lines between rows (LLM output)', () => {
        const md = [
            '| A | B |',
            '',
            '|---|---|',
            '',
            '| 1 | 2 |',
            '',
            '| 3 | 4 |',
        ].join('\n');

        const blocks = parseMarkdown(md);
        // Should be recognized as a single table, not 4 separate text blocks
        const tableBlocks = blocks.filter(b => b.type === 'table');
        expect(tableBlocks).toHaveLength(1);
        expect(tableBlocks[0]).toEqual({
            type: 'table',
            headers: [spans('A'), spans('B')],
            rows: [[spans('1'), spans('2')], [spans('3'), spans('4')]],
        });
    });

    it('preserves empty interior cells (e.g. row header column)', () => {
        const md = [
            '| | Header1 | Header2 |',
            '|---|---|---|',
            '| Row1 | a | b |',
        ].join('\n');

        const blocks = parseMarkdown(md);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toEqual({
            type: 'table',
            headers: [spans(''), spans('Header1'), spans('Header2')],
            rows: [[spans('Row1'), spans('a'), spans('b')]],
        });
    });

    it('handles blank lines and empty first cell combined', () => {
        const md = [
            '### Comparison',
            '',
            '| | Plan A | Plan B |',
            '',
            '|--|----|----|',
            '',
            '| Price | $10/mo | $20/mo |',
            '',
            '| Storage | 5 GB | 50 GB |',
            '',
            '| Support | Email only | 24/7 chat |',
        ].join('\n');

        const blocks = parseMarkdown(md);
        const tableBlocks = blocks.filter(b => b.type === 'table');
        expect(tableBlocks).toHaveLength(1);

        const table = tableBlocks[0];
        if (table.type !== 'table') throw new Error('not a table');

        // Empty first cell should be preserved
        expect(table.headers).toHaveLength(3);
        expect(table.headers[0]).toEqual([]);

        expect(table.rows).toHaveLength(3);
        expect(table.rows[0][0]).toEqual(spans('Price'));
    });

    it('stops table collection at non-blank, non-pipe lines', () => {
        const md = [
            '| A | B |',
            '|---|---|',
            '| 1 | 2 |',
            '',
            'Some text after the table',
        ].join('\n');

        const blocks = parseMarkdown(md);
        const tableBlocks = blocks.filter(b => b.type === 'table');
        const textBlocks = blocks.filter(b => b.type === 'text');

        expect(tableBlocks).toHaveLength(1);
        expect(textBlocks).toHaveLength(1);
    });

    it('does not split table cells on pipes inside inline code or escaped pipes, and parses alignments', () => {
        const md = [
            '| 字段 | 类型 | 备注 |',
            '|:---|:---:|---:|',
            '| `play_status` | `\'BACKLOG\' | \'PLAYING\'` | 含转义 \\| 竖线 |',
        ].join('\n');

        const blocks = parseMarkdown(md);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toEqual({
            type: 'table',
            alignments: ['left', 'center', 'right'],
            headers: [spans('字段'), spans('类型'), spans('备注')],
            rows: [[
                [{ styles: ['code'], text: 'play_status', url: null }],
                [{ styles: ['code'], text: "'BACKLOG' | 'PLAYING'", url: null }],
                spans('含转义 | 竖线'),
            ]],
        });
    });

    it('renders <br> line breaks and <code> pipes cleanly inside GFM table cells', () => {
        const md = [
            '| 权益项 | 能否在 Codex 里解锁 `GPT-6` | 过期与清零规则 |',
            '|---|---|---|',
            '| Free 周限额重置卡 | ❌ **不能！** <br>重置卡只刷新套餐周额度池，不解锁 <code>GPT-6 | 5.4</code> | 兑换后 30 天内有效<br>用完即清零 |',
        ].join('\n');

        const blocks = parseMarkdown(md);
        expect(blocks).toHaveLength(1);
        const table = blocks[0];
        if (table.type !== 'table') throw new Error('expected table');
        expect(table.rows[0][1]).toEqual([
            { styles: [], text: '❌ ', url: null },
            { styles: ['bold'], text: '不能！', url: null },
            { styles: [], text: '\n重置卡只刷新套餐周额度池，不解锁 ', url: null },
            { styles: ['code'], text: 'GPT-6 | 5.4', url: null },
        ]);
        expect(table.rows[0][2]).toEqual([
            { styles: [], text: '兑换后 30 天内有效\n用完即清零', url: null },
        ]);
    });

    it('preserves hierarchy when an ordered list nests unordered sub-items and task checkboxes', () => {
        const md = [
            '1. 第一步',
            '   - 子项 A',
            '   - [x] 已完成子项 B',
            '2. 第二步',
        ].join('\n');

        const blocks = parseMarkdown(md);
        expect(blocks).toEqual([
            {
                type: 'numbered-list',
                items: [
                    { number: 1, depth: 0, spans: spans('第一步') },
                    { number: 0, depth: 1, bullet: true, spans: spans('子项 A') },
                    { number: 0, depth: 1, bullet: true, checked: true, spans: spans('已完成子项 B') },
                    { number: 2, depth: 0, spans: spans('第二步') },
                ],
            },
        ]);
    });

    it('parses GitHub-style callout alerts separately from standard blockquotes', () => {
        const blocks = parseMarkdown('> [!IMPORTANT] 核心约束\n> 归档终态不可直接排期');
        expect(blocks).toEqual([
            {
                type: 'callout',
                kind: 'important',
                title: '核心约束',
                content: '归档终态不可直接排期',
            },
        ]);
    });
});

describe('parseMarkdownBlock - LaTeX display math & table pipe protection', () => {
    it('parses single-line $$...$$ display math after a numbered list item (609cm dimension chain)', () => {
        const formula = String.raw`\text{西墙展示柜 } \mathbf{36.5\text{cm}} + \text{展示柜前过道 } \mathbf{75\text{cm}} + \text{对坐半岛桌 } \mathbf{125\text{cm}} + \underbrace{\text{书房柜 } 35\text{cm} + \text{隔音芯 } 10\text{cm} + \text{主卧柜 } 35\text{cm}}_{\text{双面隔断柜墙 } \mathbf{80\text{cm}}} + \text{主卧床尾道 } \mathbf{84\text{cm}} + \text{大床靠背 } 209\text{cm} = 609\text{cm}`;
        const md = [
            '1. 书房东西双满墙柜 + 主卧满墙电视柜（横向 `609cm` 毫米级尺寸链）',
            '',
            `$$${formula}$$`,
        ].join('\n');

        const blocks = parseMarkdown(md);
        expect(blocks).toHaveLength(2);
        expect(blocks[0].type).toBe('numbered-list');
        expect(blocks[1]).toEqual({
            type: 'math',
            content: formula,
        });
    });

    it('parses multi-line $$...$$, \\[...\\], fenced math/katex blocks, and indented math inside lists', () => {
        const md = [
            '$$',
            String.raw`\begin{aligned}`,
            String.raw`a &= b + c \\`,
            String.raw`d &= e + f`,
            String.raw`\end{aligned}`,
            '$$',
            '',
            String.raw`\[\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}\]`,
            '',
            '```math',
            'E = mc^2',
            '```',
            '',
            '1. 推导步骤',
            '   $$x^2 + y^2 = r^2$$',
        ].join('\n');

        const blocks = parseMarkdown(md);
        expect(blocks).toEqual([
            {
                type: 'math',
                content: '\\begin{aligned}\na &= b + c \\\\\nd &= e + f\n\\end{aligned}',
            },
            {
                type: 'math',
                content: String.raw`\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}`,
            },
            {
                type: 'math',
                content: 'E = mc^2',
            },
            {
                type: 'numbered-list',
                items: [{ number: 1, depth: 0, spans: spans('推导步骤') }],
            },
            {
                type: 'math',
                content: 'x^2 + y^2 = r^2',
            },
        ]);
    });

    it('keeps pipes inside inline math ($|x - y|$ and \\(|a|\\)) from splitting GFM table cells', () => {
        const md = [
            '| 指标 | 约束表达式 |',
            '|---|---|',
            String.raw`| 误差界 | $|x - y| \le \varepsilon$ 且 \(\|A\|_2 = 1\) |`,
        ].join('\n');

        const blocks = parseMarkdown(md);
        expect(blocks).toHaveLength(1);
        const table = blocks[0];
        if (table.type !== 'table') throw new Error('expected table');
        expect(table.rows[0]).toHaveLength(2);
        expect(table.rows[0][1]).toEqual([
            { styles: [], text: String.raw`|x - y| \le \varepsilon`, url: null, math: 'inline' },
            { styles: [], text: ' 且 ', url: null },
            { styles: [], text: String.raw`\|A\|_2 = 1`, url: null, math: 'inline' },
        ]);
    });

    it('keeps bare escaped numeric footnotes like \\[1\\] as text instead of display math', () => {
        expect(parseMarkdown('\\[1\\]')).toEqual([
            { type: 'text', content: spans('[1]') },
        ]);
    });
});
