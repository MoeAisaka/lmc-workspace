import { describe, expect, it } from 'vitest';
import type { MarkdownSpan } from './parseMarkdown';
import { fontOf, layoutTableImage, TABLE_IMAGE, tableToHtml, tableToTsv, wrapCell, type TextRun } from './tableCopy';

const span = (text: string, styles: MarkdownSpan['styles'] = [], url: string | null = null): MarkdownSpan => ({ text, styles, url });
// Every character ten wide: widths in these tests are character counts times ten.
const measure = (run: TextRun) => [...run.text].length * 10;
const text = (lines: TextRun[][]) => lines.map((line) => line.map((run) => run.text).join(''));

describe('copying a table as a table', () => {
    const headers = [[span('机器')], [span('上行')]];
    const rows = [
        [[span('Mac '), span('mini', ['bold'])], [span('3.8 MB')]],
        [[span('a<b>&"c', ['code'])], [span('docs', [], 'https://example.com/?a=1&b=2')]],
    ];

    it('keeps bold, code and web links in the HTML and escapes the rest', () => {
        expect(tableToHtml(headers, rows)).toBe(
            '<table><thead><tr><th>机器</th><th>上行</th></tr></thead><tbody>'
            + '<tr><td>Mac <b>mini</b></td><td>3.8 MB</td></tr>'
            + '<tr><td><code>a&lt;b&gt;&amp;&quot;c</code></td><td><a href="https://example.com/?a=1&amp;b=2">docs</a></td></tr>'
            + '</tbody></table>');
    });

    it('does not carry a link that only means something inside the app', () => {
        expect(tableToHtml([[span('f')]], [[[span('run.ts', [], 'src/run.ts:12')]]])).toContain('<td>run.ts</td>');
    });

    it('writes one line per row with tabs between columns', () => {
        expect(tableToTsv(headers, rows)).toBe('机器\t上行\nMac mini\t3.8 MB\na<b>&"c\tdocs');
    });

    it('keeps a tab or line break inside a cell from shifting the columns', () => {
        expect(tableToTsv([[span('a')], [span('b')]], [[[span('x\ty\nz')], [span('2')]]])).toBe('a\tb\nx y z\t2');
    });

    it('fills a short row out to the header width', () => {
        expect(tableToTsv(headers, [[[span('only')]]])).toBe('机器\t上行\nonly\t');
        expect(tableToHtml(headers, [[[span('only')]]])).toContain('<tr><td>only</td><td></td></tr>');
    });

    it('preserves multi-line cell breaks as <br> in HTML while keeping TSV single-line', () => {
        const brCell = [span('❌ '), span('不能！', ['bold']), span('\nFree 档仅开放入门小模型')];
        expect(tableToHtml([[span('结论')]], [[brCell]])).toBe(
            '<table><thead><tr><th>结论</th></tr></thead><tbody>'
            + '<tr><td>❌ <b>不能！</b><br>Free 档仅开放入门小模型</td></tr>'
            + '</tbody></table>'
        );
        expect(tableToTsv([[span('结论')]], [[brCell]])).toBe('结论\n❌ 不能！ Free 档仅开放入门小模型');
    });
});

describe('wrapping a cell for the picture', () => {
    it('breaks between words and drops the space at the break', () => {
        expect(text(wrapCell([span('alpha beta gamma')], 100, false, measure))).toEqual(['alpha beta', 'gamma']);
    });

    it('breaks Chinese text at any character', () => {
        expect(text(wrapCell([span('一二三四五六七')], 30, false, measure))).toEqual(['一二三', '四五六', '七']);
    });

    it('splits a word wider than the cell instead of letting it overflow', () => {
        expect(text(wrapCell([span('abcdefgh')], 30, false, measure))).toEqual(['abc', 'def', 'gh']);
    });

    it('keeps differently styled runs apart and makes a header bold throughout', () => {
        const [line] = wrapCell([span('a '), span('b', ['code'])], 100, true, measure);
        expect(line).toEqual([{ text: 'a ', bold: true, italic: false, code: false, cjk: false }, { text: 'b', bold: true, italic: false, code: true, cjk: false }]);
    });
});

describe('laying out the picture', () => {
    it('sizes each column to its widest cell and every row to its tallest cell', () => {
        const layout = layoutTableImage([[span('ab')], [span('c')]], [[[span('abcdefghij')], [span('x')]]], measure);
        const { padding, cellX, cellY, lineHeight, minColumn } = TABLE_IMAGE;
        expect(layout.columns).toEqual([100 + cellX * 2, minColumn + cellX * 2]);
        expect(layout.rows.map((row) => row.height)).toEqual([lineHeight + cellY * 2, lineHeight + cellY * 2]);
        expect(layout.width).toBe(100 + minColumn + cellX * 4 + padding * 2);
        expect(layout.height).toBe((lineHeight + cellY * 2) * 2 + padding * 2);
    });

    it('caps a column and wraps what does not fit, making the row taller', () => {
        const layout = layoutTableImage([[span('h')]], [[[span('一'.repeat(80))]]], measure);
        expect(layout.columns[0]).toBe(TABLE_IMAGE.maxColumn + TABLE_IMAGE.cellX * 2);
        expect(layout.rows[1].cells[0]).toHaveLength(3);
        expect(layout.rows[1].height).toBe(3 * TABLE_IMAGE.lineHeight + TABLE_IMAGE.cellY * 2);
    });
});

describe('choosing the canvas font', () => {
    const run = (over: Partial<TextRun>): TextRun => ({ text: 'x', bold: false, italic: false, code: false, cjk: false, ...over });

    it('does not embolden a family that is already the bold face', () => {
        const plex = { regular: 'Plex-Regular', semiBold: 'Plex-SemiBold', italic: 'Plex-Italic', mono: 'Mono' };
        expect(fontOf(run({ bold: true }), plex)).toBe('400 16px Plex-SemiBold');
        expect(fontOf(run({ italic: true }), plex)).toBe('400 16px Plex-Italic');
    });

    it('gives Chinese in a bold run its weight through the regular family, since the fallback font has no bold face of ours', () => {
        const plex = { regular: 'Plex-Regular', semiBold: 'Plex-SemiBold', italic: 'Plex-Italic', mono: 'Mono' };
        expect(fontOf(run({ bold: true, cjk: true }), plex)).toBe('600 16px Plex-Regular');
        expect(text(wrapCell([span('机器 A')], 1000, true, measure))).toEqual(['机器 A']);
        expect(wrapCell([span('机器 A')], 1000, true, measure)[0].map((r) => [r.text, r.cjk])).toEqual([['机器', true], [' A', false]]);
    });

    it('asks a single-family font for the weight and slant', () => {
        const system = { regular: 'system-ui', semiBold: 'system-ui', italic: 'system-ui', mono: 'monospace' };
        expect(fontOf(run({ bold: true }), system)).toBe('600 16px system-ui');
        expect(fontOf(run({ italic: true }), system)).toBe('italic 400 16px system-ui');
        expect(fontOf(run({ code: true }), system)).toBe('400 15px monospace');
    });
});
