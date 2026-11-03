import { parseMarkdownBlock } from "./parseMarkdownBlock"
import type { FollowupOption } from './parseFollowupDirective';

export type MarkdownParseOptions = { followups?: boolean };

export type CalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';
export type TableColumnAlignment = 'left' | 'center' | 'right' | null;

export type MarkdownListItem = {
    depth: number;
    spans: MarkdownSpan[];
    checked?: boolean;
    number?: number;
};

export type MarkdownNumberedListItem = {
    number: number;
    depth: number;
    spans: MarkdownSpan[];
    checked?: boolean;
    bullet?: boolean;
};

export type MarkdownBlock = {
    type: 'text'
    content: MarkdownSpan[]
} | {
    type: 'quote',
    content: string
} | {
    type: 'callout',
    kind: CalloutKind,
    title: string | null,
    content: string
} | {
    type: 'header'
    level: 1 | 2 | 3 | 4 | 5 | 6
    content: MarkdownSpan[]
} | {
    type: 'list',
    items: MarkdownListItem[]
} | {
    type: 'numbered-list',
    items: MarkdownNumberedListItem[]
} | {
    type: 'code-block',
    language: string | null,
    content: string
} | {
    type: 'mermaid',
    content: string
} | {
    type: 'math',
    content: string
} | {
    /** D30: a sandboxed page the engine answered with, or a reference to one it wrote earlier. */
    type: 'interactive',
    id: string | null,
    title: string | null,
    ref: string | null,
    html: string,
    closed: boolean
} | {
    type: 'horizontal-rule'
} | {
    type: 'options',
    items: string[]
} | {
    type: 'followups',
    items: FollowupOption[]
} | {
    type: 'table',
    headers: MarkdownSpan[][],
    rows: MarkdownSpan[][][],
    alignments?: TableColumnAlignment[]
} | {
    type: 'details',
    summary: MarkdownSpan[],
    content: string,
    open: boolean
} | {
    type: 'image',
    alt: string,
    url: string
}

export type MarkdownSpanStyle = 'italic' | 'bold' | 'semibold' | 'code' | 'strikethrough';

export type MarkdownSpan = {
    styles: MarkdownSpanStyle[],
    text: string,
    url: string | null,
    math?: 'inline' | 'display',
}

export function parseMarkdown(markdown: string, options: MarkdownParseOptions = {}) {
    return parseMarkdownBlock(markdown, options);
}
