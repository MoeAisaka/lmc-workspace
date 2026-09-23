import type { MarkdownBlock } from './parseMarkdown';
import { parseMarkdownSpans } from './parseMarkdownSpans';

// A dedicated Markdown disclosure, never raw HTML. Attributes are discarded
// except for the boolean `open`; nested content goes through our normal parser.
export function parseMarkdownDetails(lines: string[], start: number): {
    block: Extract<MarkdownBlock, { type: 'details' }>;
    nextIndex: number;
    trailing: string;
} | null {
    const opening = lines[start].trimStart().match(/^<details(?:\s[^>]*)?>/i);
    if (!opening) return null;
    const attributes = opening[0].slice(8, -1).matchAll(/([^\s=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]+))?/g);
    const open = Array.from(attributes).some(attribute => attribute[1].toLowerCase() === 'open');
    const content: string[] = [];
    let depth = 1;
    let fence: { marker: string; length: number } | null = null;
    let nextIndex = lines.length;
    let trailing = '';

    for (let index = start; index < lines.length; index++) {
        const line = index === start ? lines[index].trimStart().slice(opening[0].length) : lines[index];
        const fenceMatch = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
        if (fence) {
            if (fenceMatch && fenceMatch[1][0] === fence.marker && fenceMatch[1].length >= fence.length && !fenceMatch[2].trim()) fence = null;
            content.push(line);
            continue;
        }
        if (fenceMatch) {
            fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
            content.push(line);
            continue;
        }

        // Tags inside inline/fenced code must remain literal, including examples
        // of </details>. Count nesting so the inner close cannot end the parent.
        let inlineTicks = 0;
        let end = -1;
        for (const token of line.matchAll(/`+|<details(?:\s[^>]*)?>|<\/details\s*>/gi)) {
            if (token.index! > 0 && line[token.index! - 1] === '\\') continue;
            if (token[0][0] === '`') {
                if (!inlineTicks) inlineTicks = token[0].length;
                else if (inlineTicks === token[0].length) inlineTicks = 0;
            } else if (!inlineTicks) {
                depth += token[0][1] === '/' ? -1 : 1;
                if (depth === 0) {
                    end = token.index!;
                    trailing = line.slice(end + token[0].length);
                    nextIndex = index + 1;
                    break;
                }
            }
        }
        content.push(end < 0 ? line : line.slice(0, end));
        if (end >= 0) break;
    }

    let body = content.join('\n').trim();
    // Also accept an unfinished summary while the assistant is streaming. Its
    // title can grow without exposing HTML tags or losing the eventual body.
    const summary = body.match(/^<summary\s*>([\s\S]*?)(?:<\/summary\s*>|$)/i);
    if (summary) body = body.slice(summary[0].length).trim();
    return {
        block: { type: 'details', summary: parseMarkdownSpans(summary?.[1].trim() || '', false), content: body, open },
        nextIndex,
        trailing,
    };
}
