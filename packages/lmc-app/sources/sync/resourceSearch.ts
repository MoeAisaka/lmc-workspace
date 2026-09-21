import type { ResourceSearchMatch, ResourceSearchRequest, ResourceSearchResponse, ResourceSearchSkipped } from 'lmc-wire';

export type ResourceSearchProgress = {
    matches: ResourceSearchMatch[];
    skipped: ResourceSearchSkipped[];
    scanned: number;
    total: number;
    complete: boolean;
};

/** Keep paging on the Agent; never download whole documents into the browser. */
export async function runResourceSearch(
    request: ResourceSearchRequest,
    rpc: (request: ResourceSearchRequest) => Promise<ResourceSearchResponse>,
    update: (state: ResourceSearchProgress) => void,
    signal: AbortSignal,
): Promise<void> {
    const matches = new Map<string, ResourceSearchMatch>();
    const skipped = new Map<string, ResourceSearchSkipped>();
    let offset = 0;
    let snapshot: string | undefined;
    while (!signal.aborted) {
        const result = await rpc({ ...request, offset, snapshot });
        if (signal.aborted) return;
        if (!result.success) throw new Error(result.error);
        if (result.scanned < offset || result.scanned > result.total ||
            (result.nextOffset !== null && (result.nextOffset <= offset || result.nextOffset !== result.scanned)) ||
            (snapshot !== undefined && result.snapshot !== snapshot)) throw new Error('changed');
        result.matches.forEach(match => matches.set(match.path, match));
        result.skipped.forEach(item => skipped.set(item.path, item));
        update({ matches: [...matches.values()], skipped: [...skipped.values()], scanned: result.scanned, total: result.total, complete: result.nextOffset === null });
        if (result.nextOffset === null) return;
        offset = result.nextOffset;
        snapshot = result.snapshot;
    }
}

/** Literal matching also handles punctuation in code, without regex injection. */
export function resourceHighlightParts(text: string, query: string): { text: string; match: boolean }[] {
    if (!query.trim()) return [{ text, match: false }];
    const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expression = new RegExp(escaped, 'giu');
    const parts: { text: string; match: boolean }[] = [];
    let start = 0;
    for (const match of text.matchAll(expression)) {
        if (match.index > start) parts.push({ text: text.slice(start, match.index), match: false });
        parts.push({ text: match[0], match: true });
        start = match.index + match[0].length;
    }
    if (start < text.length) parts.push({ text: text.slice(start), match: false });
    return parts;
}
