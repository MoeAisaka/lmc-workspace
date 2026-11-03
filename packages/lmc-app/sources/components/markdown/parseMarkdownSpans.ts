import type { MarkdownSpan, MarkdownSpanStyle } from "./parseMarkdown";
import { findFileReferences, parseFileReference } from "./linkUtils";
import { latexToPlainText, matchInlineMathAt } from "./mathUtils";

const ASCII_WORD = /[A-Za-z0-9]/;
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~><&$]/;
const HTML_BR_TAG = /^<br\s*\/?>/i;
const HTML_AUTOLINK = /^<(https?:\/\/[^\s<>]+)>/i;
const HTML_OPEN_TAG = /^<(b|strong|i|em|s|del|strike|code|kbd|a|ul|ol|sup|sub|u|ins|mark|span)((?:\s+[A-Za-z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*)>/i;
const HTML_LI_OPEN_TAG = /<li(?:\s+[A-Za-z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*>/i;
const HTML_ENTITY_AT_START = /^&([A-Za-z][A-Za-z0-9]*|#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6});/;

const NAMED_HTML_ENTITIES: Record<string, string> = {
    nbsp: '\u00A0',
    lt: '<',
    gt: '>',
    amp: '&',
    quot: '"',
    apos: "'",
    mdash: '—',
    ndash: '–',
    hellip: '…',
    rarr: '→',
    larr: '←',
    times: '×',
    divide: '÷',
    copy: '©',
    reg: '®',
    trade: '™',
};

function decodeHtmlEntityToken(token: string): string | null {
    if (token.startsWith('#x') || token.startsWith('#X')) {
        const cp = parseInt(token.slice(2), 16);
        if (cp >= 0x20 && cp <= 0x10FFFF && (cp < 0xD800 || cp > 0xDFFF)) {
            return String.fromCodePoint(cp);
        }
        return null;
    }
    if (token.startsWith('#')) {
        const cp = parseInt(token.slice(1), 10);
        if (cp >= 0x20 && cp <= 0x10FFFF && (cp < 0xD800 || cp > 0xDFFF)) {
            return String.fromCodePoint(cp);
        }
        return null;
    }
    const lower = token.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_HTML_ENTITIES, lower)
        ? NAMED_HTML_ENTITIES[lower]
        : null;
}

function decodeHtmlEntities(raw: string): string {
    return raw.replace(/&([A-Za-z][A-Za-z0-9]*|#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6});/g, (full, token: string) => {
        return decodeHtmlEntityToken(token) ?? full;
    });
}

function mergeStyles(base: MarkdownSpanStyle[], extra?: MarkdownSpanStyle | MarkdownSpanStyle[]): MarkdownSpanStyle[] {
    if (!extra) return base.length ? [...base] : [];
    const additions = Array.isArray(extra) ? extra : [extra];
    const next = [...base];
    for (const item of additions) {
        if (!next.includes(item)) next.push(item);
    }
    return next;
}

function appendSpan(spans: MarkdownSpan[], styles: MarkdownSpanStyle[], text: string, url: string | null) {
    if (!text) return;
    const prev = spans.at(-1);
    if (
        prev
        && !prev.math
        && prev.url === url
        && prev.styles.length === styles.length
        && prev.styles.every((s, idx) => s === styles[idx])
    ) {
        prev.text += text;
        return;
    }
    spans.push({ styles: [...styles], text, url });
}

function appendMathSpan(
    spans: MarkdownSpan[],
    styles: MarkdownSpanStyle[],
    content: string,
    mode: 'inline' | 'display',
    url: string | null,
) {
    if (!content) return;
    spans.push({ styles: [...styles], text: content, url, math: mode });
}

/**
 * Paths written into prose become links too. When already inside an explicit
 * markdown link (`inheritedUrl`), keep that link target rather than splitting.
 */
function pushTextWithFileLinks(
    spans: MarkdownSpan[],
    text: string,
    styles: MarkdownSpanStyle[],
    inheritedUrl: string | null
) {
    if (!text) return;
    if (inheritedUrl) {
        appendSpan(spans, styles, text, inheritedUrl);
        return;
    }
    let lastIndex = 0;
    for (const { index, length } of findFileReferences(text)) {
        if (index > lastIndex) {
            appendSpan(spans, styles, text.slice(lastIndex, index), null);
        }
        const path = text.slice(index, index + length);
        appendSpan(spans, styles, path, path);
        lastIndex = index + length;
    }
    if (lastIndex < text.length) {
        appendSpan(spans, styles, text.slice(lastIndex), null);
    }
}

function pushTextWithAutoLinks(
    spans: MarkdownSpan[],
    text: string,
    styles: MarkdownSpanStyle[],
    inheritedUrl: string | null
) {
    if (!text) return;
    if (inheritedUrl) {
        appendSpan(spans, styles, text, inheritedUrl);
        return;
    }
    const urlPattern = /https?:\/\/[^\s<]+/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = urlPattern.exec(text)) !== null) {
        const plainText = text.slice(lastIndex, match.index);
        if (plainText) {
            pushTextWithFileLinks(spans, plainText, styles, null);
        }

        let url = match[0];
        let trailing = '';
        // Strip sentence-ending punctuation while keeping balanced parentheses in URLs (e.g. Wikipedia)
        while (/[),.;:!?]$/.test(url)) {
            if (url.endsWith(')')) {
                const opens = (url.match(/\(/g) ?? []).length;
                const closes = (url.match(/\)/g) ?? []).length;
                if (closes <= opens) break;
            }
            trailing = url.slice(-1) + trailing;
            url = url.slice(0, -1);
        }

        if (url) {
            appendSpan(spans, styles, url, url);
        }
        if (trailing) {
            pushTextWithFileLinks(spans, trailing, styles, null);
        }

        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
        pushTextWithFileLinks(spans, text.slice(lastIndex), styles, null);
    }
}

/** Find matching closing backtick run of exact length `ticks`. */
function findCodeSpanEnd(src: string, startAfterOpen: number, ticks: number): number {
    let i = startAfterOpen;
    while (i < src.length) {
        if (src[i] === '`') {
            let run = 0;
            while (i + run < src.length && src[i + run] === '`') run++;
            if (run === ticks) return i;
            i += run;
        } else {
            i++;
        }
    }
    return -1;
}

/**
 * Parse `[label](url)` starting at `openBracketIndex` (`src[openBracketIndex] === '['`).
 * Respects inline code spans and nested brackets in `label`, plus balanced
 * parentheses and optional `"title"` in `url`.
 */
function matchMarkdownLink(src: string, openBracketIndex: number): { label: string; url: string; endIndex: number } | null {
    let i = openBracketIndex + 1;
    let bracketDepth = 1;
    while (i < src.length) {
        const ch = src[i];
        if (ch === '\\' && i + 1 < src.length) {
            if (src[i + 1] === '(' || src[i + 1] === '[') {
                const math = matchInlineMathAt(src, i);
                if (math) {
                    i = math.endIndex;
                    continue;
                }
            }
            i += 2;
            continue;
        }
        if (ch === '$') {
            const math = matchInlineMathAt(src, i);
            if (math) {
                i = math.endIndex;
                continue;
            }
        }
        if (ch === '`') {
            let ticks = 0;
            while (i + ticks < src.length && src[i + ticks] === '`') ticks++;
            const closeCode = findCodeSpanEnd(src, i + ticks, ticks);
            if (closeCode !== -1) {
                i = closeCode + ticks;
                continue;
            }
            i += ticks;
            continue;
        }
        if (ch === '[') {
            bracketDepth++;
        } else if (ch === ']') {
            bracketDepth--;
            if (bracketDepth === 0) break;
        }
        i++;
    }
    if (bracketDepth !== 0 || i >= src.length || src[i + 1] !== '(') {
        return null;
    }
    const label = src.slice(openBracketIndex + 1, i);
    let j = i + 2;
    while (j < src.length && src[j] === ' ') j++;

    // Angle-bracketed target: `[label](<path with (parens)>)`
    if (src[j] === '<') {
        const closeAngle = src.indexOf('>', j + 1);
        if (closeAngle !== -1) {
            let k = closeAngle + 1;
            while (k < src.length && src[k] !== ')') k++;
            if (k < src.length) {
                return { label, url: src.slice(j + 1, closeAngle).trim(), endIndex: k + 1 };
            }
        }
    }

    let parenDepth = 1;
    let urlEnd = j;
    let inTitleQuotes: '"' | "'" | null = null;
    let titleStart = -1;

    while (j < src.length) {
        const ch = src[j];
        if (ch === '\\' && j + 1 < src.length) {
            j += 2;
            continue;
        }
        if (inTitleQuotes) {
            if (ch === inTitleQuotes) {
                inTitleQuotes = null;
            }
            j++;
            continue;
        }
        if ((ch === '"' || ch === "'") && j > i + 2 && /\s/.test(src[j - 1])) {
            if (titleStart === -1) titleStart = j - 1;
            inTitleQuotes = ch;
            j++;
            continue;
        }
        if (ch === '(') {
            parenDepth++;
        } else if (ch === ')') {
            parenDepth--;
            if (parenDepth === 0) {
                urlEnd = titleStart !== -1 ? titleStart : j;
                const rawUrl = src.slice(i + 2, urlEnd).trim();
                if (!rawUrl) return null;
                return { label, url: rawUrl, endIndex: j + 1 };
            }
        }
        j++;
    }
    return null;
}

/**
 * Find matching closing HTML tag `</tag>` while respecting nested same-name tags
 * and (for non-code tags) inline backtick code spans.
 */
function findClosingHtmlTag(
    src: string,
    startAfterOpen: number,
    tagLower: string,
    rawContent: boolean
): { contentEnd: number; afterClose: number } | null {
    let depth = 1;
    let j = startAfterOpen;
    while (j < src.length) {
        const ch = src[j];
        if (!rawContent) {
            if (ch === '\\' && j + 1 < src.length) {
                j += 2;
                continue;
            }
            if (ch === '`') {
                let ticks = 0;
                while (j + ticks < src.length && src[j + ticks] === '`') ticks++;
                const closeCode = findCodeSpanEnd(src, j + ticks, ticks);
                if (closeCode !== -1) {
                    j = closeCode + ticks;
                    continue;
                }
                j += ticks;
                continue;
            }
        }
        if (ch === '<') {
            const rest = src.slice(j);
            const closeMatch = rest.match(/^<\/([A-Za-z]+)\s*>/);
            if (closeMatch && closeMatch[1].toLowerCase() === tagLower) {
                depth--;
                if (depth === 0) {
                    return { contentEnd: j, afterClose: j + closeMatch[0].length };
                }
                j += closeMatch[0].length;
                continue;
            }
            const openMatch = rest.match(tagLower === 'li' ? /^<(li)((?:\s+[A-Za-z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*)>/i : HTML_OPEN_TAG);
            if (openMatch && openMatch[1].toLowerCase() === tagLower) {
                depth++;
                j += openMatch[0].length;
                continue;
            }
        }
        j++;
    }
    return null;
}

/**
 * Find matching closing emphasis delimiter (`***`, `**`, `__`, `~~`, `*`, `_`)
 * while skipping inline code spans and links so inner `*` / `_` inside URLs or
 * backticks never prematurely terminate outer emphasis.
 */
function findClosingDelimiter(src: string, startAfterOpen: number, delim: string): number {
    const ch0 = delim[0];
    const len = delim.length;
    const isUnderscore = ch0 === '_';
    const isSingleStar = delim === '*';

    let i = startAfterOpen;
    while (i <= src.length - len) {
        const ch = src[i];
        if (ch === '\\' && i + 1 < src.length) {
            if (src[i + 1] === '(' || src[i + 1] === '[') {
                const math = matchInlineMathAt(src, i);
                if (math) {
                    i = math.endIndex;
                    continue;
                }
            }
            i += 2;
            continue;
        }
        if (ch === '$') {
            const math = matchInlineMathAt(src, i);
            if (math) {
                i = math.endIndex;
                continue;
            }
        }
        if (ch === '`') {
            let ticks = 0;
            while (i + ticks < src.length && src[i + ticks] === '`') ticks++;
            const closeCode = findCodeSpanEnd(src, i + ticks, ticks);
            if (closeCode !== -1) {
                i = closeCode + ticks;
                continue;
            }
            i += ticks;
            continue;
        }
        if (ch === '<') {
            const codeOpen = src.slice(i).match(/^<(code|kbd)\b[^>]*>/i);
            if (codeOpen) {
                const closed = findClosingHtmlTag(src, i + codeOpen[0].length, codeOpen[1].toLowerCase(), true);
                if (closed) {
                    i = closed.afterClose;
                    continue;
                }
            }
        }
        if (ch === '[') {
            const link = matchMarkdownLink(src, i);
            if (link) {
                i = link.endIndex;
                continue;
            }
        }
        if (src.startsWith(delim, i)) {
            // For single `*`, do not close on `**`
            if (isSingleStar && (src[i + 1] === '*' || src[i - 1] === '*')) {
                let stars = 0;
                while (src[i + stars] === '*') stars++;
                i += stars;
                continue;
            }
            // Single `*` or `_` cannot have whitespace immediately before closing delimiter
            if (len === 1 && /\s/.test(src[i - 1] ?? ' ')) {
                i++;
                continue;
            }
            // Underscore emphasis cannot close inside an ASCII identifier (`foo_bar_baz`)
            if (isUnderscore && ASCII_WORD.test(src[i + len] ?? '')) {
                i += len;
                continue;
            }
            if (i > startAfterOpen) {
                return i;
            }
        }
        i++;
    }
    return -1;
}

function tokenizeInline(
    src: string,
    header: boolean,
    inheritedStyles: MarkdownSpanStyle[],
    inheritedUrl: string | null,
    spans: MarkdownSpan[]
) {
    let buffer = '';
    const flush = () => {
        if (buffer) {
            pushTextWithAutoLinks(spans, buffer, inheritedStyles, inheritedUrl);
            buffer = '';
        }
    };
    const trimTrailingHorizontalSpaceBeforeBreak = () => {
        if (buffer.length > 0) {
            buffer = buffer.replace(/[ \t]+$/, '');
            return;
        }
        const prev = spans.at(-1);
        if (prev && !prev.styles.includes('code') && /[ \t]$/.test(prev.text)) {
            prev.text = prev.text.replace(/[ \t]+$/, '');
            if (!prev.text) spans.pop();
        }
    };

    let i = 0;
    while (i < src.length) {
        const ch = src[i];

        // 1. Backslash hard break (`\\\n`) and escapes (`\*`, `\|`, `\<`, `\&`, etc.)
        if (ch === '\\' && src[i + 1] === '\n') {
            trimTrailingHorizontalSpaceBeforeBreak();
            flush();
            appendSpan(spans, inheritedStyles, '\n', inheritedUrl);
            i += 2;
            while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
            continue;
        }
        if (ch === '\\' && (src[i + 1] === '(' || src[i + 1] === '[')) {
            const math = matchInlineMathAt(src, i);
            if (math) {
                flush();
                appendMathSpan(spans, inheritedStyles, math.content, math.mode, inheritedUrl);
                i = math.endIndex;
                continue;
            }
        }
        if (ch === '\\' && i + 1 < src.length && ESCAPABLE.test(src[i + 1])) {
            buffer += src[i + 1];
            i += 2;
            continue;
        }

        // 2. Inline code (`code` or ``code with ` tick``)
        if (ch === '`') {
            let ticks = 0;
            while (i + ticks < src.length && src[i + ticks] === '`') ticks++;
            const closeCode = findCodeSpanEnd(src, i + ticks, ticks);
            if (closeCode !== -1) {
                flush();
                let code = src.slice(i + ticks, closeCode);
                if (ticks > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim().length > 0) {
                    code = code.slice(1, -1);
                }
                const targetUrl = inheritedUrl ?? (parseFileReference(code) ? code : null);
                appendSpan(spans, mergeStyles(inheritedStyles, 'code'), code, targetUrl);
                i = closeCode + ticks;
                continue;
            }
            buffer += src.slice(i, i + ticks);
            i += ticks;
            continue;
        }

        // 3. Inline HTML (`<br>`, `<https://...>`, paired `<b>`/`<strong>`/`<i>`/`<em>`/`<del>`/`<code>`/`<a>`/`<ul>`/`<ol>`)
        if (ch === '<') {
            const rest = src.slice(i);

            const brMatch = rest.match(HTML_BR_TAG);
            if (brMatch) {
                trimTrailingHorizontalSpaceBeforeBreak();
                flush();
                appendSpan(spans, inheritedStyles, '\n', inheritedUrl);
                i += brMatch[0].length;
                while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
                continue;
            }

            if (!inheritedUrl) {
                const autoMatch = rest.match(HTML_AUTOLINK);
                if (autoMatch) {
                    flush();
                    appendSpan(spans, inheritedStyles, autoMatch[1], autoMatch[1]);
                    i += autoMatch[0].length;
                    continue;
                }
            }

            const openMatch = rest.match(HTML_OPEN_TAG);
            if (openMatch) {
                const tagLower = openMatch[1].toLowerCase();
                const attrs = openMatch[2] ?? '';
                const openEnd = i + openMatch[0].length;
                const isCodeTag = tagLower === 'code' || tagLower === 'kbd';
                const closed = findClosingHtmlTag(src, openEnd, tagLower, isCodeTag);
                if (closed) {
                    const inner = src.slice(openEnd, closed.contentEnd);
                    if (isCodeTag) {
                        flush();
                        const decoded = decodeHtmlEntities(inner);
                        const targetUrl = inheritedUrl ?? (parseFileReference(decoded) ? decoded : null);
                        appendSpan(spans, mergeStyles(inheritedStyles, 'code'), decoded, targetUrl);
                        i = closed.afterClose;
                        continue;
                    }
                    if (tagLower === 'ul' || tagLower === 'ol') {
                        const items: string[] = [];
                        let cursor = 0;
                        while (cursor < inner.length) {
                            const liOpen = inner.slice(cursor).match(HTML_LI_OPEN_TAG);
                            if (!liOpen || liOpen.index === undefined) break;
                            const liBodyStart = cursor + liOpen.index + liOpen[0].length;
                            const liClosed = findClosingHtmlTag(inner, liBodyStart, 'li', false);
                            if (!liClosed) break;
                            items.push(inner.slice(liBodyStart, liClosed.contentEnd).trim());
                            cursor = liClosed.afterClose;
                        }
                        if (items.length > 0) {
                            trimTrailingHorizontalSpaceBeforeBreak();
                            flush();
                            const prev = spans.at(-1);
                            if (prev && !prev.text.endsWith('\n')) {
                                appendSpan(spans, inheritedStyles, '\n', inheritedUrl);
                            }
                            items.forEach((item, idx) => {
                                if (idx > 0) appendSpan(spans, inheritedStyles, '\n', inheritedUrl);
                                appendSpan(spans, inheritedStyles, tagLower === 'ol' ? `${idx + 1}. ` : '• ', inheritedUrl);
                                tokenizeInline(item, header, inheritedStyles, inheritedUrl, spans);
                            });
                            i = closed.afterClose;
                            while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
                            if (i < src.length && !HTML_BR_TAG.test(src.slice(i)) && src[i] !== '\n') {
                                appendSpan(spans, inheritedStyles, '\n', inheritedUrl);
                            }
                            continue;
                        }
                    }
                    flush();
                    if (tagLower === 'b' || tagLower === 'strong') {
                        const nextStyles = header ? inheritedStyles : mergeStyles(inheritedStyles, 'bold');
                        tokenizeInline(inner, header, nextStyles, inheritedUrl, spans);
                    } else if (tagLower === 'i' || tagLower === 'em') {
                        const nextStyles = header ? inheritedStyles : mergeStyles(inheritedStyles, 'italic');
                        tokenizeInline(inner, header, nextStyles, inheritedUrl, spans);
                    } else if (tagLower === 's' || tagLower === 'del' || tagLower === 'strike') {
                        tokenizeInline(inner, header, mergeStyles(inheritedStyles, 'strikethrough'), inheritedUrl, spans);
                    } else if (tagLower === 'a') {
                        const hrefMatch = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
                        const rawHref = decodeHtmlEntities((hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? '').trim());
                        const safeHref = rawHref && !/^(?:javascript|vbscript|data):/i.test(rawHref) ? rawHref : null;
                        tokenizeInline(inner, header, inheritedStyles, inheritedUrl ?? safeHref, spans);
                    } else {
                        const nextStyles = tagLower === 'mark' && !header
                            ? mergeStyles(inheritedStyles, 'semibold')
                            : inheritedStyles;
                        tokenizeInline(inner, header, nextStyles, inheritedUrl, spans);
                    }
                    i = closed.afterClose;
                    continue;
                }
            }
        }

        // 4. HTML character entities (`&nbsp;`, `&lt;`, `&#124;`, etc.) — decoded directly into text buffer
        if (ch === '&') {
            const entityMatch = src.slice(i).match(HTML_ENTITY_AT_START);
            if (entityMatch) {
                const decoded = decodeHtmlEntityToken(entityMatch[1]);
                if (decoded !== null) {
                    buffer += decoded;
                    i += entityMatch[0].length;
                    continue;
                }
            }
        }

        // 5. CommonMark two-space hard line break (`  \n`)
        if (ch === '\n' && buffer.endsWith('  ')) {
            trimTrailingHorizontalSpaceBeforeBreak();
            flush();
            appendSpan(spans, inheritedStyles, '\n', inheritedUrl);
            i += 1;
            while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
            continue;
        }

        // 5b. Inline / display math (`$...$` and `$$...$$`)
        if (ch === '$') {
            const math = matchInlineMathAt(src, i);
            if (math) {
                flush();
                appendMathSpan(spans, inheritedStyles, math.content, math.mode, inheritedUrl);
                i = math.endIndex;
                continue;
            }
        }

        // 6. Inline image `![alt](url)` inside a paragraph -> render as clickable link `[🖼 alt]`
        if (ch === '!' && src[i + 1] === '[' && !inheritedUrl) {
            const imgLink = matchMarkdownLink(src, i + 1);
            if (imgLink) {
                flush();
                const label = imgLink.label.trim() || imgLink.url;
                appendSpan(spans, inheritedStyles, label, imgLink.url);
                i = imgLink.endIndex;
                continue;
            }
        }

        // 7. Explicit Markdown link `[label](url)` (recursively parses inner `code`, `**bold**`, etc.)
        if (ch === '[' && !inheritedUrl) {
            const link = matchMarkdownLink(src, i);
            if (link) {
                flush();
                tokenizeInline(link.label, header, inheritedStyles, link.url, spans);
                i = link.endIndex;
                continue;
            }
        }

        // 8. Strikethrough `~~...~~`
        if (ch === '~' && src[i + 1] === '~' && src[i + 2] !== '~') {
            const close = findClosingDelimiter(src, i + 2, '~~');
            if (close !== -1) {
                flush();
                tokenizeInline(
                    src.slice(i + 2, close),
                    header,
                    mergeStyles(inheritedStyles, 'strikethrough'),
                    inheritedUrl,
                    spans
                );
                i = close + 2;
                continue;
            }
        }

        // 9. Strong + Italic `***...***`, Strong `**...**` / `__...__`, Italic `*...*` / `_..._`
        if (ch === '*' || ch === '_') {
            const prevChar = i > 0 ? src[i - 1] : '';
            const blockedUnderscore = ch === '_' && ASCII_WORD.test(prevChar);

            if (!blockedUnderscore) {
                if (ch === '*' && src.startsWith('***', i) && src[i + 3] && !/\s/.test(src[i + 3])) {
                    const close = findClosingDelimiter(src, i + 3, '***');
                    if (close !== -1) {
                        flush();
                        const nextStyles = header ? inheritedStyles : mergeStyles(inheritedStyles, ['bold', 'italic']);
                        tokenizeInline(src.slice(i + 3, close), header, nextStyles, inheritedUrl, spans);
                        i = close + 3;
                        continue;
                    }
                }

                const doubleDelim = ch + ch;
                if (src.startsWith(doubleDelim, i) && src[i + 2] !== ch) {
                    const close = findClosingDelimiter(src, i + 2, doubleDelim);
                    if (close !== -1) {
                        flush();
                        const nextStyles = header ? inheritedStyles : mergeStyles(inheritedStyles, 'bold');
                        tokenizeInline(src.slice(i + 2, close), header, nextStyles, inheritedUrl, spans);
                        i = close + 2;
                        continue;
                    }
                }

                if (src[i + 1] && src[i + 1] !== ch && !/\s/.test(src[i + 1])) {
                    const close = findClosingDelimiter(src, i + 1, ch);
                    if (close !== -1) {
                        flush();
                        const nextStyles = header ? inheritedStyles : mergeStyles(inheritedStyles, 'italic');
                        tokenizeInline(src.slice(i + 1, close), header, nextStyles, inheritedUrl, spans);
                        i = close + 1;
                        continue;
                    }
                }
            }
        }

        buffer += ch;
        i++;
    }

    flush();
}

export function parseMarkdownSpans(markdown: string, header: boolean): MarkdownSpan[] {
    const spans: MarkdownSpan[] = [];
    tokenizeInline(markdown, header, [], null, spans);
    return spans;
}

const WIDE_CHAR = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const CODE_CHAR_RATIO = 1.15;

/**
 * Estimate widest visual line width (in half-width character cells) across
 * multi-line spans so `<br>`-wrapped table cells size columns to their longest
 * line rather than summing every line together.
 */
export function spansLength(spans: MarkdownSpan[]): number {
    let maxLine = 0;
    let currentLine = 0;
    for (const s of spans) {
        const ratio = s.styles.includes('code') ? CODE_CHAR_RATIO : 1;
        const visibleText = s.math ? latexToPlainText(s.text) : s.text;
        for (const ch of visibleText) {
            if (ch === '\n') {
                if (currentLine > maxLine) maxLine = currentLine;
                currentLine = 0;
            } else {
                currentLine += (WIDE_CHAR.test(ch) ? 2 : 1) * ratio;
            }
        }
    }
    return Math.max(maxLine, currentLine);
}
