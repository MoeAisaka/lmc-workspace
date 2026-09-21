// Only started by resourceSearch.ts. Parsing never runs on the session event loop.
import { parentPort, workerData } from 'node:worker_threads';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';

const MAX_TEXT = 2 * 1024 * 1024;
const MAX_DOCUMENT = 16 * 1024 * 1024;
const fail = (reason) => { throw Object.assign(new Error(reason), { reason }); };
const escaped = workerData.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = new RegExp(escaped, 'iu');
const snippets = [];
let textSize = 0;
let hasText = false;
function scan(text, location) {
    textSize += text.length;
    if (textSize > MAX_TEXT) fail('tooLarge');
    if (text.trim()) hasText = true;
    const match = pattern.exec(text);
    if (!match || snippets.length >= 3) return;
    const start = Math.max(0, match.index - 65);
    const end = Math.min(text.length, match.index + match[0].length + 120);
    snippets.push({ ...location, text: (start ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '') });
}

async function search() {
    const handle = await open(workerData.path, constants.O_RDONLY | constants.O_NONBLOCK);
    let data;
    try {
        const before = await handle.stat();
        const limit = ['pdf', 'docx'].includes(workerData.extension) ? MAX_DOCUMENT : MAX_TEXT;
        if (!before.isFile()) fail('unsupported');
        if (before.size > limit) fail('tooLarge');
        const chunks = []; let size = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
            size += chunk.length;
            if (size > limit) fail('tooLarge');
            chunks.push(chunk);
        }
        const after = await handle.stat();
        if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) fail('changed');
        data = Buffer.concat(chunks);
    } finally { await handle.close(); }

    if (workerData.extension === 'pdf') {
        const pdf = await getDocumentProxy(new Uint8Array(data), { isEvalSupported: false, verbosity: 0 });
        try {
            if (pdf.numPages > 200) fail('tooLarge');
            for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
                const page = await pdf.getPage(pageNumber);
                const content = await page.getTextContent();
                const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
                scan(text, { page: pageNumber });
                page.cleanup();
            }
        } finally { await pdf.destroy(); }
    } else if (workerData.extension === 'docx') {
        // Raw text only: no HTML, images, external relationships or link navigation.
        const result = await mammoth.extractRawText({ buffer: data });
        if (result.value.length > MAX_TEXT) fail('tooLarge');
        const paragraphs = result.value.split(/\n\s*\n/);
        paragraphs.forEach((text, index) => scan(text, { paragraph: index + 1 }));
    } else {
        let text;
        try {
            const encoding = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le'
                : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8';
            text = new TextDecoder(encoding, { fatal: true }).decode(data);
        } catch { fail('unsupported'); }
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) fail('unsupported');
        text.split(/\r\n|\n|\r/).forEach((line, index) => scan(line, { line: index + 1 }));
    }
    if (!hasText && ['pdf', 'docx'].includes(workerData.extension)) fail('noText');
    return { snippets };
}

try { parentPort.postMessage(await search()); }
catch (error) { parentPort.postMessage({ reason: error?.reason ?? 'unreadable' }); }
