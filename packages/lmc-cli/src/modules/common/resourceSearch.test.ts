import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { searchResourceBody, searchSessionResources } from './resourceSearch';
import { ResourceReview } from './resourceReview';

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() { const path = await mkdtemp(join(tmpdir(), 'resource-search-')); roots.push(path); return path; }

// A real PDF with a valid cross-reference table, not a mocked extractor response.
function pdf(text: string) {
    const stream = text ? `BT /F1 12 Tf 20 100 Td (${text}) Tj ET` : '';
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
    let content = '%PDF-1.4\n'; const offsets = [0];
    objects.forEach((value, i) => { offsets.push(Buffer.byteLength(content)); content += `${i + 1} 0 obj\n${value}\nendobj\n`; });
    const offset = Buffer.byteLength(content);
    content += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`;
    return content;
}

describe('session resource content search', () => {
    it('finds literal text, Chinese, UTF-16 and a filename without interpreting code as regex', async () => {
        const root = await fixture();
        await writeFile(join(root, 'code.ts'), 'first\nconst sum = "a+b 回滚";\nlast');
        await writeFile(join(root, 'utf16.txt'), Buffer.concat([Buffer.from([255, 254]), Buffer.from('回滚策略', 'utf16le')]));
        await writeFile(join(root, '回滚.md'), 'no body match');
        const result = await searchSessionResources(root, async () => ['code.ts', 'utf16.txt', '回滚.md'], { query: '回滚' });
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.skipped).toEqual([]);
        expect(result.matches.map(m => m.path)).toEqual(['code.ts', 'utf16.txt', '回滚.md']);
        expect(result.matches[0].snippets[0]).toMatchObject({ line: 2, text: 'const sum = "a+b 回滚";' });
        expect(result.matches[2]).toMatchObject({ nameMatch: true, snippets: [] });
        expect(await searchResourceBody(join(root, 'code.ts'), 'ts', 'a+b')).toMatchObject({ snippets: [{ line: 2 }] });
    }, 20000);

    it('extracts real PDF pages and DOCX paragraphs and reports empty/corrupt documents', async () => {
        const root = await fixture();
        await writeFile(join(root, 'guide.pdf'), pdf('Release rollback instructions'));
        await writeFile(join(root, 'empty.pdf'), pdf(''));
        await writeFile(join(root, 'broken.docx'), 'not a zip');
        const require = createRequire(import.meta.url);
        const JSZip = createRequire(require.resolve('mammoth'))('jszip');
        const zip = new JSZip();
        zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
        zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
        zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Release guide</w:t></w:r></w:p><w:p><w:r><w:t>回滚 rollback instructions</w:t></w:r></w:p></w:body></w:document>');
        await writeFile(join(root, 'guide.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
        const result = await searchSessionResources(root, async () => ['guide.pdf', 'guide.docx', 'empty.pdf', 'broken.docx'], { query: 'rollback' });
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.matches.map(m => m.path)).toEqual(['guide.pdf', 'guide.docx']);
        expect(result.matches[0].snippets[0]).toMatchObject({ page: 1 });
        expect(result.matches[1].snippets[0]).toMatchObject({ paragraph: 2 });
        expect(result.skipped).toEqual(expect.arrayContaining([{ path: 'empty.pdf', reason: 'noText' }, { path: 'broken.docx', reason: 'unreadable' }]));
    }, 20000);

    it('keeps filename matches when body search skips sensitive, binary, missing and oversized resources', async () => {
        const root = await fixture();
        await writeFile(join(root, '.env'), 'SECRET=needle');
        await symlink(join(root, '.env'), join(root, 'alias.txt'));
        await writeFile(join(root, 'binary.png'), Buffer.from([0, 1, 0, 2]));
        await writeFile(join(root, 'huge.txt'), 'a'.repeat(2 * 1024 * 1024 + 1));
        const result = await searchSessionResources(root, async () => ['alias.txt', 'binary.png', 'missing.txt', 'huge.txt'], { query: '.' });
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.matches).toHaveLength(4);
        expect(result.matches.every(m => m.snippets.length === 0)).toBe(true);
        expect(result.skipped).toEqual(expect.arrayContaining([
            { path: 'alias.txt', reason: 'sensitive' }, { path: 'binary.png', reason: 'unsupported' },
            { path: 'missing.txt', reason: 'unreadable' }, { path: 'huge.txt', reason: 'tooLarge' },
        ]));
    }, 15000);

    it('pages selected formats and rejects a continuation when the path snapshot changes', async () => {
        const root = await fixture(); const paths = Array.from({ length: 6 }, (_, i) => `file${i}.MD`);
        await Promise.all(paths.map(path => writeFile(join(root, path), 'needle')));
        const first = await searchSessionResources(root, async () => [...paths, 'ignored.ts'], { query: 'needle', extension: 'md' });
        if (!first.success) throw new Error(first.error);
        expect(first).toMatchObject({ scanned: 4, total: 6, nextOffset: 4 });
        const second = await searchSessionResources(root, async () => paths, { query: 'needle', extension: 'md', offset: 4, snapshot: first.snapshot });
        expect(second).toMatchObject({ success: true, scanned: 6, nextOffset: null });
        expect(await searchSessionResources(root, async () => paths.slice(1), { query: 'needle', extension: 'md', offset: 4, snapshot: first.snapshot })).toEqual({ success: false, error: 'changed' });
    }, 20000);

    it('bounds parsing time and validates untrusted requests', async () => {
        const root = await fixture(); await writeFile(join(root, 'ok.txt'), 'hello');
        expect(await searchResourceBody(join(root, 'ok.txt'), 'txt', 'hello', 1)).toEqual({ reason: 'timeout' });
        for (const input of [{ query: '' }, { query: 'a', offset: -1 }, { query: 'x'.repeat(201) }])
            expect(await searchSessionResources(root, async () => [], input)).toEqual({ success: false, error: 'invalid' });
    });

    it('uses complete turn/unseen paths beyond the review page and excludes unrelated transcript paths', async () => {
        const root = await fixture(); const review = new ResourceReview(join(root, 'journal'));
        for (let i = 0; i < 24; i++) await review.observe({ id: String(i), turn: 'first', ev: { t: 'tool-call-start', call: String(i), name: i % 2 ? 'Edit' : 'CodexPatch', args: i % 2 ? { file_path: `${i}.txt`, content: 'a' } : { changes: { [`${i}.txt`]: { type: 'add', content: 'a' } } } } } as any);
        const all = await review.read('all');
        expect(all.entries).toHaveLength(20);
        expect(await review.paths('all')).toHaveLength(24);
        await review.markViewed(all.cursor);
        await review.observe({ id: 'start', turn: 'second', ev: { t: 'turn-start' } } as any);
        await review.observe({ id: 'new', turn: 'second', ev: { t: 'tool-call-start', call: 'new', name: 'Write', args: { file_path: 'new.txt', content: 'needle' } } } as any);
        expect((await review.read('turn')).scopePaths).toEqual(['new.txt']);
        expect(await review.paths('unseen')).toEqual(['new.txt']);
        await writeFile(join(root, 'new.txt'), 'needle');
        const result = await searchSessionResources(root, scope => review.paths(scope), { query: 'needle', scope: 'turn', paths: ['unrelated.txt'] });
        expect(result).toMatchObject({ success: true, total: 1, matches: [{ path: 'new.txt' }] });
    }, 15000);
});
