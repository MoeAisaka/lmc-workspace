import type {
    CalloutKind,
    MarkdownBlock,
    MarkdownListItem,
    MarkdownNumberedListItem,
    MarkdownParseOptions,
    MarkdownSpan,
    TableColumnAlignment,
} from "./parseMarkdown";
import { parseMarkdownSpans } from "./parseMarkdownSpans";
import { parseMarkdownDetails } from './parseMarkdownDetails';
import { parseFollowupDirective } from './parseFollowupDirective';
import { parseInteractiveFence } from 'lmc-wire';

/**
 * Split a pipe-delimited table row into cells while respecting inline code spans
 * (`` `a | b` ``) and backslash-escaped pipes (`\|`), stripping only outer pipes.
 */
function splitTableRow(line: string): string[] {
    const trimmed = line.trim();
    const cells: string[] = [];
    let current = '';
    let i = 0;

    while (i < trimmed.length) {
        const ch = trimmed[i];
        if (ch === '\\' && i + 1 < trimmed.length) {
            if (trimmed[i + 1] === '|') {
                current += '|';
            } else {
                current += '\\' + trimmed[i + 1];
            }
            i += 2;
            continue;
        }
        if (ch === '`') {
            let ticks = 0;
            while (i + ticks < trimmed.length && trimmed[i + ticks] === '`') ticks++;
            current += trimmed.slice(i, i + ticks);
            i += ticks;
            while (i < trimmed.length) {
                if (trimmed[i] === '`') {
                    let closeTicks = 0;
                    while (i + closeTicks < trimmed.length && trimmed[i + closeTicks] === '`') closeTicks++;
                    current += trimmed.slice(i, i + closeTicks);
                    i += closeTicks;
                    if (closeTicks === ticks) break;
                } else {
                    current += trimmed[i];
                    i++;
                }
            }
            continue;
        }
        if (ch === '<') {
            const openCode = trimmed.slice(i).match(/^<(code|kbd)\b[^>]*>/i);
            if (openCode) {
                const tag = openCode[1].toLowerCase();
                const closeMatch = new RegExp(`</${tag}\\s*>`, 'i').exec(trimmed.slice(i + openCode[0].length));
                if (closeMatch) {
                    const take = openCode[0].length + closeMatch.index + closeMatch[0].length;
                    current += trimmed.slice(i, i + take);
                    i += take;
                    continue;
                }
            }
        }
        if (ch === '|') {
            cells.push(current.trim());
            current = '';
            i++;
            continue;
        }
        current += ch;
        i++;
    }
    cells.push(current.trim());

    let result = cells;
    if (result.length > 0 && trimmed.startsWith('|') && result[0] === '') result = result.slice(1);
    if (result.length > 0 && trimmed.endsWith('|') && !trimmed.endsWith('\\|') && result[result.length - 1] === '') {
        result = result.slice(0, -1);
    }
    return result;
}

function parseSeparatorAlignments(separatorLine: string): TableColumnAlignment[] | null {
    const cells = splitTableRow(separatorLine);
    if (cells.length === 0) return null;
    const alignments: TableColumnAlignment[] = [];
    for (const cell of cells) {
        if (!/^:?[-=]{1,}:?$/.test(cell)) return null;
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        alignments.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
    }
    return alignments;
}

function parseTable(lines: string[], startIndex: number): { table: MarkdownBlock | null; nextIndex: number } {
    let index = startIndex;
    const tableLines: string[] = [];

    // Collect consecutive lines that contain pipe characters, skipping blank lines
    // that LLMs often insert between table rows
    while (index < lines.length) {
        if (lines[index].includes('|')) {
            tableLines.push(lines[index]);
            index++;
        } else if (lines[index].trim() === '') {
            index++;
        } else {
            break;
        }
    }

    if (tableLines.length < 2) {
        return { table: null, nextIndex: startIndex };
    }

    const alignments = parseSeparatorAlignments(tableLines[1].trim());
    if (!alignments) {
        return { table: null, nextIndex: startIndex };
    }

    const headers = splitTableRow(tableLines[0])
        .map(cell => parseMarkdownSpans(cell, false));

    if (headers.length === 0) {
        return { table: null, nextIndex: startIndex };
    }

    const rows: MarkdownSpan[][][] = [];
    for (let i = 2; i < tableLines.length; i++) {
        const rowCells = splitTableRow(tableLines[i])
            .map(cell => parseMarkdownSpans(cell, false));
        if (rowCells.length > 0) {
            rows.push(rowCells);
        }
    }

    const hasExplicitAlignments = alignments.some(a => a !== null);
    const table: MarkdownBlock = {
        type: 'table',
        headers,
        rows,
        ...(hasExplicitAlignments ? { alignments } : {}),
    };

    return { table, nextIndex: index };
}

type RawListEntry = {
    kind: 'bullet' | 'ordered';
    number: number;
    indent: number;
    checked?: boolean;
    content: string;
};

function expandLeadingSpaces(line: string): number {
    let cols = 0;
    for (let i = 0; i < line.length; i++) {
        if (line[i] === ' ') cols += 1;
        else if (line[i] === '\t') cols += 4 - (cols % 4);
        else break;
    }
    return cols;
}

function matchListMarker(line: string): RawListEntry | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    // Do not mistake horizontal rules (`---`, `***`) for list items
    if (/^(?:\*\s*){3,}$|^(?:-\s*){3,}$|^(?:_\s*){3,}$/.test(trimmed)) return null;

    const indent = expandLeadingSpaces(line);
    const orderedMatch = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
    if (orderedMatch) {
        let rest = orderedMatch[2];
        let checked: boolean | undefined;
        const taskMatch = rest.match(/^\[([ xX])\]\s+(.*)$/);
        if (taskMatch) {
            checked = taskMatch[1].toLowerCase() === 'x';
            rest = taskMatch[2];
        }
        return { kind: 'ordered', number: parseInt(orderedMatch[1], 10), indent, checked, content: rest };
    }

    const bulletMatch = trimmed.match(/^([-*+])\s+(.*)$/);
    if (bulletMatch) {
        let rest = bulletMatch[2];
        let checked: boolean | undefined;
        const taskMatch = rest.match(/^\[([ xX])\]\s+(.*)$/);
        if (taskMatch) {
            checked = taskMatch[1].toLowerCase() === 'x';
            rest = taskMatch[2];
        }
        return { kind: 'bullet', number: 0, indent, checked, content: rest };
    }

    return null;
}

/**
 * Compute clean nesting depths (`0, 1, 2...`) from arbitrary 2/3/4-space
 * indentation using a parent-indent stack, so `1. Foo` followed by `   - Sub`
 * always lands at `depth = 1` without gaps or flattening.
 */
function normalizeListDepths(indents: number[]): number[] {
    const stack: number[] = [];
    return indents.map((indent) => {
        while (stack.length > 0 && indent < stack[stack.length - 1] - 1) {
            stack.pop();
        }
        if (stack.length === 0) {
            stack.push(indent);
            return 0;
        }
        const top = stack[stack.length - 1];
        if (indent > top + 1) {
            stack.push(indent);
            return stack.length - 1;
        }
        return stack.length - 1;
    });
}

function isSpecialBlockStarter(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (/^\s{0,3}#{1,6}\s+/.test(line)) return true;
    if (/^(`{3,}|~{3,})/.test(trimmed)) return true;
    if (/^>\s?/.test(trimmed)) return true;
    if (/^(?:\*\s*){3,}$|^(?:-\s*){3,}$|^(?:_\s*){3,}$/.test(trimmed)) return true;
    if (trimmed.startsWith('<options>') || trimmed.startsWith('<details')) return true;
    if (/^!\[([^\]]*)\]\(([^)]+)\)$/.test(trimmed)) return true;
    return false;
}

const CALLOUT_HEADER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]+(.*))?$/i;

export function parseMarkdownBlock(markdown: string, options: MarkdownParseOptions = {}) {
    const blocks: MarkdownBlock[] = [];
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    let index = 0;

    outer: while (index < lines.length) {
        const line = lines[index];
        index++;

        // 1. ATX Headers (`#` .. `######`, allowing up to 3 leading spaces and optional closing `#`)
        const headerMatch = line.match(/^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+\s*)?$/);
        if (headerMatch) {
            const level = headerMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
            blocks.push({
                type: 'header',
                level,
                content: parseMarkdownSpans(headerMatch[2].trim(), true),
            });
            continue outer;
        }

        const trimmed = line.trim();

        // 2. Fenced Code / Mermaid / Interactive block
        const fence = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
        if (fence) {
            const language = fence[2].trim() || null;
            const closingFence = new RegExp(`^${fence[1][0]}{${fence[1].length},}\\s*$`);
            const content: string[] = [];
            let closed = false;
            while (index < lines.length) {
                const nextLine = lines[index];
                if (closingFence.test(nextLine.trim())) {
                    index++;
                    closed = true;
                    break;
                }
                content.push(nextLine);
                index++;
            }
            const contentString = content.join('\n');

            const interactive = parseInteractiveFence(language);
            if (interactive) {
                blocks.push({ type: 'interactive', ...interactive, html: contentString, closed });
            } else if (language === 'mermaid') {
                blocks.push({ type: 'mermaid', content: contentString });
            } else {
                blocks.push({ type: 'code-block', language, content: contentString });
            }
            continue;
        }

        // 3. HTML `<details>` disclosure block
        const details = parseMarkdownDetails(lines, index - 1);
        if (details) {
            blocks.push(details.block);
            index = details.nextIndex;
            if (details.trailing.trim()) {
                lines[--index] = details.trailing;
            }
            continue;
        }

        // 4. Blockquote & GitHub Callout (`> [!NOTE]`, `> [!TIP]`, etc.)
        if (/^>\s?/.test(trimmed)) {
            const quoted = [trimmed.replace(/^>\s?/, '')];
            while (index < lines.length && /^\s*>/.test(lines[index])) {
                quoted.push(lines[index++].trimStart().replace(/^>\s?/, ''));
            }
            const alertMatch = quoted[0]?.trim().match(CALLOUT_HEADER);
            if (alertMatch) {
                const kind = alertMatch[1].toLowerCase() as CalloutKind;
                const title = alertMatch[2]?.trim() || null;
                const body = quoted.slice(1).join('\n').replace(/^\n+/, '');
                blocks.push({ type: 'callout', kind, title, content: body });
            } else {
                blocks.push({ type: 'quote', content: quoted.join('\n') });
            }
            continue;
        }

        // 5. Follow-up directives
        const followup = options.followups ? parseFollowupDirective(line) : null;
        if (followup) {
            const previous = blocks.at(-1);
            if (previous?.type === 'followups') previous.items.push(followup);
            else blocks.push({ type: 'followups', items: [followup] });
            continue;
        }

        // 6. Horizontal rule (`---`, `***`, `___`, `- - -`)
        if (/^(?:\*\s*){3,}$|^(?:-\s*){3,}$|^(?:_\s*){3,}$/.test(trimmed)) {
            blocks.push({ type: 'horizontal-rule' });
            continue;
        }

        // 7. Explicit `<options>` block
        if (trimmed.startsWith('<options>')) {
            const items: string[] = [];
            while (index < lines.length) {
                const nextLine = lines[index];
                if (nextLine.trim() === '</options>') {
                    index++;
                    break;
                }
                const optionMatch = nextLine.match(/<option>(.*?)<\/option>/);
                if (optionMatch) {
                    items.push(optionMatch[1]);
                }
                index++;
            }
            if (items.length > 0) {
                blocks.push({ type: 'options', items });
            }
            continue;
        }

        // 8. Standalone image block
        const imageMatch = trimmed.match(/^!\[([^\]]*)\]\((.+)\)$/);
        if (imageMatch && !imageMatch[2].includes('](')) {
            blocks.push({ type: 'image', alt: imageMatch[1], url: imageMatch[2].trim() });
            continue;
        }

        // 9. Unified ordered + unordered + nested + task list collector
        const firstListEntry = matchListMarker(line);
        if (firstListEntry) {
            const entries: RawListEntry[] = [firstListEntry];
            while (index < lines.length) {
                const nextRaw = lines[index];
                if (options.followups && parseFollowupDirective(nextRaw)) break;

                // Allow a single blank line inside a list if immediately followed by another list item
                if (nextRaw.trim() === '') {
                    const afterBlank = index + 1 < lines.length ? lines[index + 1] : '';
                    if (afterBlank && !(options.followups && parseFollowupDirective(afterBlank)) && matchListMarker(afterBlank)) {
                        index++;
                        continue;
                    }
                    break;
                }

                const nextEntry = matchListMarker(nextRaw);
                if (nextEntry) {
                    entries.push(nextEntry);
                    index++;
                    continue;
                }

                // Indented paragraph continuation line belonging to the last list item
                const nextIndent = expandLeadingSpaces(nextRaw);
                const lastEntry = entries[entries.length - 1];
                if (nextIndent >= lastEntry.indent + 2 && !isSpecialBlockStarter(nextRaw) && !nextRaw.includes('|')) {
                    lastEntry.content += ' ' + nextRaw.trim();
                    index++;
                    continue;
                }

                break;
            }

            const depths = normalizeListDepths(entries.map(e => e.indent));
            const hasOrdered = entries.some(e => e.kind === 'ordered');
            const hasBullet = entries.some(e => e.kind === 'bullet');

            if (!hasOrdered) {
                const items: MarkdownListItem[] = entries.map((entry, idx) => ({
                    depth: depths[idx],
                    spans: parseMarkdownSpans(entry.content, false),
                    ...(entry.checked !== undefined ? { checked: entry.checked } : {}),
                }));
                blocks.push({ type: 'list', items });
            } else if (!hasBullet) {
                const items: MarkdownNumberedListItem[] = entries.map((entry, idx) => ({
                    number: entry.number,
                    depth: depths[idx],
                    spans: parseMarkdownSpans(entry.content, false),
                    ...(entry.checked !== undefined ? { checked: entry.checked } : {}),
                }));
                blocks.push({ type: 'numbered-list', items });
            } else if (entries[0].kind === 'ordered') {
                // Mixed ordered outer list with bullet sub-items (e.g. `1.` -> `   - `)
                const items: MarkdownNumberedListItem[] = entries.map((entry, idx) => ({
                    number: entry.number,
                    depth: depths[idx],
                    spans: parseMarkdownSpans(entry.content, false),
                    ...(entry.checked !== undefined ? { checked: entry.checked } : {}),
                    ...(entry.kind === 'bullet' ? { bullet: true } : {}),
                }));
                blocks.push({ type: 'numbered-list', items });
            } else {
                // Mixed bullet outer list with ordered sub-items (e.g. `- ` -> `  1. `)
                const items: MarkdownListItem[] = entries.map((entry, idx) => ({
                    depth: depths[idx],
                    spans: parseMarkdownSpans(entry.content, false),
                    ...(entry.checked !== undefined ? { checked: entry.checked } : {}),
                    ...(entry.kind === 'ordered' ? { number: entry.number } : {}),
                }));
                blocks.push({ type: 'list', items });
            }
            continue;
        }

        // 10. Table
        if (trimmed.includes('|') && !trimmed.startsWith('```')) {
            const { table, nextIndex } = parseTable(lines, index - 1);
            if (table) {
                blocks.push(table);
                index = nextIndex;
                continue outer;
            }
        }

        // 11. Paragraph text
        if (trimmed.length > 0) {
            blocks.push({ type: 'text', content: parseMarkdownSpans(trimmed, false) });
        }
    }
    return blocks;
}
