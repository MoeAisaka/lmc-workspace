import type { MarkdownSpan } from './parseMarkdown';
import { latexToPlainText } from './mathUtils';

/**
 * A rendered table, taken out of the page two ways: as a real table (HTML for
 * spreadsheets and documents, tab-separated text for everything else) and as
 * a picture of the whole table, including the columns scrolled off screen.
 */

type Cell = MarkdownSpan[];

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const spanDisplayText = (span: MarkdownSpan) => span.math ? latexToPlainText(span.text) : span.text;

function spanToHtml(span: MarkdownSpan): string {
    let html = escapeHtml(spanDisplayText(span));
    if (span.styles.includes('code')) html = `<code>${html}</code>`;
    else html = html.replace(/\n/g, '<br>');
    if (span.styles.includes('strikethrough')) html = `<s>${html}</s>`;
    if (span.styles.includes('bold') || span.styles.includes('semibold')) html = `<b>${html}</b>`;
    if (span.styles.includes('italic')) html = `<i>${html}</i>`;
    // Only web links travel; a file reference means nothing outside this app.
    if (span.url && /^https?:\/\//i.test(span.url)) html = `<a href="${escapeHtml(span.url)}">${html}</a>`;
    return html;
}

const cellText = (cell: Cell | undefined) => (cell ?? []).map(spanDisplayText).join('');

export function tableToHtml(headers: Cell[], rows: Cell[][]): string {
    const cells = (row: Cell[], tag: 'th' | 'td') => headers.map((_, column) => `<${tag}>${(row[column] ?? []).map(spanToHtml).join('')}</${tag}>`).join('');
    return `<table><thead><tr>${cells(headers, 'th')}</tr></thead><tbody>${rows.map((row) => `<tr>${cells(row, 'td')}</tr>`).join('')}</tbody></table>`;
}

/** One line per row, tabs between columns. A tab or line break inside a cell would shift every cell after it. */
export function tableToTsv(headers: Cell[], rows: Cell[][]): string {
    const line = (row: Cell[]) => headers.map((_, column) => cellText(row[column]).replace(/[\t\r\n]+/g, ' ').trim()).join('\t');
    return [headers, ...rows].map(line).join('\n');
}

// ---- the picture -------------------------------------------------------------

/** `cjk` marks text the app's Latin face has no glyphs for, which the browser draws in a system font. */
export type TextRun = { text: string; bold: boolean; italic: boolean; code: boolean; cjk: boolean };
export type Measure = (run: TextRun) => number;

const CJK = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

/** Break points: between words, and before or after any CJK character. */
function tokens(text: string): string[] {
    const out: string[] = [];
    let word = '';
    for (const ch of text) {
        if (ch === ' ' || CJK.test(ch)) { if (word) out.push(word); word = ''; out.push(ch); }
        else word += ch;
    }
    if (word) out.push(word);
    return out;
}

/** Wraps a cell to `width`. A word wider than the cell is split by character rather than left to overflow. */
export function wrapCell(cell: Cell, width: number, header: boolean, measure: Measure): TextRun[][] {
    const lines: TextRun[][] = [[]];
    let used = 0;
    const put = (run: TextRun, w: number) => {
        const line = lines[lines.length - 1], last = line[line.length - 1];
        if (last && last.bold === run.bold && last.italic === run.italic && last.code === run.code && last.cjk === run.cjk) last.text += run.text;
        else line.push({ ...run });
        used += w;
    };
    const newLine = () => { lines.push([]); used = 0; };
    for (const span of cell) {
        const style = { bold: header || span.styles.includes('bold') || span.styles.includes('semibold'), italic: span.styles.includes('italic'), code: span.styles.includes('code') };
        for (const part of spanDisplayText(span).split(/(\n)/)) {
            if (part === '\n') { newLine(); continue; }
            for (const token of tokens(part)) {
                const run = { text: token, ...style, cjk: CJK.test(token) }, w = measure(run);
                if (token === ' ' && used === 0) continue;
                if (used + w <= width) { put(run, w); continue; }
                if (token === ' ') { newLine(); continue; }
                if (w <= width) { newLine(); put(run, w); continue; }
                for (const ch of token) {
                    const piece = { text: ch, ...style, cjk: run.cjk }, pw = measure(piece);
                    if (used > 0 && used + pw > width) newLine();
                    put(piece, pw);
                }
            }
        }
    }
    return lines;
}

export const TABLE_IMAGE = { padding: 16, cellX: 12, cellY: 8, fontSize: 16, lineHeight: 24, maxColumn: 360, minColumn: 48, radius: 8 };

export type TableImageLayout = {
    width: number;
    height: number;
    columns: number[];
    /** Each row's wrapped cells and its height, header first. */
    rows: { height: number; cells: TextRun[][][] }[];
};

export function layoutTableImage(headers: Cell[], rows: Cell[][], measure: Measure): TableImageLayout {
    const { padding, cellX, cellY, lineHeight, maxColumn, minColumn } = TABLE_IMAGE;
    const all = [headers, ...rows];
    const natural = (cell: Cell | undefined, header: boolean) => Math.max(0, ...wrapCell(cell ?? [], Infinity, header, measure).map((line) => line.reduce((sum, run) => sum + measure(run), 0)));
    const columns = headers.map((_, column) => Math.ceil(Math.min(maxColumn, Math.max(minColumn, ...all.map((row, index) => natural(row[column], index === 0)))) + cellX * 2));
    const laidOut = all.map((row, index) => {
        const cells = headers.map((_, column) => wrapCell(row[column] ?? [], columns[column] - cellX * 2, index === 0, measure));
        return { cells, height: Math.max(1, ...cells.map((lines) => lines.length)) * lineHeight + cellY * 2 };
    });
    return {
        columns,
        rows: laidOut,
        width: columns.reduce((sum, w) => sum + w, 0) + padding * 2,
        height: laidOut.reduce((sum, row) => sum + row.height, 0) + padding * 2,
    };
}

/**
 * The families the page itself uses. The app's own face ships one family per
 * weight, so asking that family for 600 again would embolden it twice; a
 * system font is a single family and does need the weight.
 */
export type TableImageFonts = { regular: string; semiBold: string; italic: string; mono: string };

export function fontOf(run: TextRun, fonts: TableImageFonts): string {
    const size = run.code ? TABLE_IMAGE.fontSize - 1 : TABLE_IMAGE.fontSize;
    if (run.code) return `${run.italic ? 'italic ' : ''}${run.bold ? 600 : 400} ${size}px ${fonts.mono}`;
    // The bold face cannot lend its weight to a fallback font: Chinese in a header came out regular.
    if (run.bold && run.cjk && fonts.semiBold !== fonts.regular) return `600 ${size}px ${fonts.regular}`;
    if (run.bold) return `${run.italic ? 'italic ' : ''}${fonts.semiBold === fonts.regular ? 600 : 400} ${size}px ${fonts.semiBold}`;
    if (run.italic) return `${fonts.italic === fonts.regular ? 'italic ' : ''}400 ${size}px ${fonts.italic}`;
    return `400 ${size}px ${fonts.regular}`;
}

/**
 * Draws the table on white, whatever the theme: the picture is going into
 * someone else's document or chat, not staying on this page.
 */
export function renderTableImage(headers: Cell[], rows: Cell[][], fonts: TableImageFonts): Promise<Blob> {
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
    if (!ctx) return Promise.reject(new Error('Canvas unavailable'));
    const measure: Measure = (run) => { ctx.font = fontOf(run, fonts); return ctx.measureText(run.text).width; };
    const layout = layoutTableImage(headers, rows, measure);
    // Browsers refuse very large canvases; a long table is drawn at 1x rather than not at all.
    const scale = layout.width * 2 <= 8192 && layout.height * 2 <= 16384 && layout.width * layout.height * 4 <= 64_000_000 ? 2 : 1;
    canvas.width = Math.ceil(layout.width * scale);
    canvas.height = Math.ceil(layout.height * scale);
    ctx.scale(scale, scale);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, layout.width, layout.height);

    const { padding, cellX, cellY, lineHeight, radius } = TABLE_IMAGE;
    const tableWidth = layout.width - padding * 2, tableHeight = layout.height - padding * 2;
    ctx.textBaseline = 'middle';
    let y = padding;
    for (const row of layout.rows) {
        let x = padding;
        row.cells.forEach((lines, column) => {
            lines.forEach((line, index) => {
                let runX = x + cellX;
                for (const run of line) {
                    ctx.font = fontOf(run, fonts);
                    ctx.fillStyle = '#0d0d0d';
                    ctx.fillText(run.text, runX, y + cellY + index * lineHeight + lineHeight / 2);
                    runX += ctx.measureText(run.text).width;
                }
            });
            x += layout.columns[column];
        });
        y += row.height;
    }
    ctx.strokeStyle = '#e5e5e5';
    ctx.lineWidth = 1;
    ctx.beginPath();
    y = padding;
    for (const row of layout.rows.slice(0, -1)) { y += row.height; ctx.moveTo(padding, Math.round(y) + 0.5); ctx.lineTo(padding + tableWidth, Math.round(y) + 0.5); }
    let x = padding;
    for (const w of layout.columns.slice(0, -1)) { x += w; ctx.moveTo(Math.round(x) + 0.5, padding); ctx.lineTo(Math.round(x) + 0.5, padding + tableHeight); }
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(padding + 0.5, padding + 0.5, tableWidth - 1, tableHeight - 1, radius);
    ctx.stroke();
    return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Image encoding failed'))), 'image/png'));
}

// ---- getting it out of the page ----------------------------------------------

/** Whether this browser lets a page put a picture on the clipboard at all. */
export function canCopyImage(): boolean {
    if (typeof navigator === 'undefined' || typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false;
    const supports = (ClipboardItem as unknown as { supports?: (type: string) => boolean }).supports;
    return supports ? supports.call(ClipboardItem, 'image/png') : true;
}

export async function copyTable(headers: Cell[], rows: Cell[][]): Promise<void> {
    const html = tableToHtml(headers, rows), text = tableToTsv(headers, rows);
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        try {
            await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
            return;
        } catch { /* a browser that refuses rich content still takes the text below */ }
    }
    await navigator.clipboard.writeText(text);
}

/** The blob is handed over as a promise: Safari only accepts a clipboard write begun inside the tap itself. */
export async function copyTableImage(image: Promise<Blob>): Promise<void> {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]);
}

/** The system share sheet where there is one (a phone: save to Photos, send on); a download otherwise. */
export async function saveTableImage(image: Promise<Blob>): Promise<void> {
    const file = new File([await image], 'table.png', { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file] }); return; }
        catch (error) { if ((error as Error)?.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(file), link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
