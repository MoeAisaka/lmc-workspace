import { execFile } from 'node:child_process';
import { extractInteractiveBlocks, type InteractiveBlock } from 'lmc-wire';
import { logger } from '@/ui/logger';

/**
 * Interactive answers on the agent side (D30, layers 2 and 3): finding a page
 * the engine wrote earlier so it can be shown or changed, and leaving a note
 * in nmem so the page can be found again after the context that held it has
 * been compacted away, or from another session.
 */
export type TranscriptPage = { entries: { seq: number; body: unknown }[]; hasMore: boolean };
export type TranscriptReader = (opts: { limit: number; beforeSeq?: number }) => Promise<TranscriptPage>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The engine text in one transcript entry, or null for anything else. */
export function agentTextOfEntry(body: unknown): string | null {
    if (!isRecord(body) || body.role !== 'session' || !isRecord(body.content)) return null;
    const content = body.content;
    if (content.role !== 'agent' || !isRecord(content.ev) || content.ev.t !== 'text' || content.ev.thinking === true) return null;
    return typeof content.ev.text === 'string' ? content.ev.text : null;
}

/** The newest complete block with this id in a page of entries. */
export function findInteractiveBlock(entries: TranscriptPage['entries'], id: string): (InteractiveBlock & { seq: number }) | null {
    const ordered = [...entries].sort((a, b) => b.seq - a.seq);
    for (const entry of ordered) {
        const text = agentTextOfEntry(entry.body);
        if (!text || !text.includes(id)) continue;
        const blocks = extractInteractiveBlocks(text);
        for (let index = blocks.length - 1; index >= 0; index--) {
            const block = blocks[index];
            if (block.id === id && block.closed && block.html.trim()) return { ...block, seq: entry.seq };
        }
    }
    return null;
}

/** Pages back through a transcript until the block turns up; bounded so a missing id is not a full read. */
export async function recallInteractiveBlock(read: TranscriptReader, id: string, maxPages = 10): Promise<(InteractiveBlock & { seq: number }) | null> {
    let beforeSeq: number | undefined;
    for (let page = 0; page < maxPages; page++) {
        const result = await read({ limit: 200, beforeSeq });
        const found = findInteractiveBlock(result.entries, id);
        if (found) return found;
        if (!result.hasMore || !result.entries.length) return null;
        beforeSeq = Math.min(...result.entries.map(entry => entry.seq));
    }
    return null;
}

export type BlockNote = { sessionId: string; sessionTitle: string | null; machine: string | null; id: string; title: string | null; summary: string };

/** What goes into nmem: enough to find the page and fetch it, never the page itself. */
export function blockNoteText(note: BlockNote): string {
    return [
        `LMC 交互块 ${note.id}${note.title ? `「${note.title}」` : ''}`,
        note.summary ? `内容：${note.summary}` : '',
        `会话 ${note.sessionId}${note.sessionTitle ? `（${note.sessionTitle}）` : ''}${note.machine ? ` · ${note.machine}` : ''}`,
        `取回源码：recall_interactive_block id=${note.id} session_id=${note.sessionId}`,
    ].filter(Boolean).join('\n');
}

/** The sentence before the block, if any, as a one-line description of it. */
export function summaryBeforeBlock(text: string, blockIndex: number): string {
    const fences = [...text.matchAll(/^\s*(`{3,}|~{3,})\s*lmc-ui\b.*$/gm)];
    const fence = fences[blockIndex];
    const before = fence ? text.slice(0, fence.index) : text;
    const line = before.trim().split('\n').filter(Boolean).pop() ?? '';
    return line.replace(/[#*_`>]/g, '').trim().slice(0, 120);
}

let nmemAvailable: boolean | null = null;
function nmemAvailableNow(): Promise<boolean> {
    if (nmemAvailable !== null) return Promise.resolve(nmemAvailable);
    return new Promise(resolve => {
        execFile('nmem', ['--version'], { timeout: 5000, windowsHide: true }, error => {
            nmemAvailable = !error;
            if (error) logger.debug('[interactive] nmem not available on this machine; interactive blocks are not registered');
            resolve(nmemAvailable);
        });
    });
}

/** Upserts the note keyed by session and block id, so a page shown twice is one memory. */
export async function registerInteractiveBlock(note: BlockNote, run: typeof execFile = execFile): Promise<boolean> {
    if (!(await nmemAvailableNow())) return false;
    const id = `lmc-ui-${note.sessionId}-${note.id}`.slice(0, 120);
    const title = `交互块 ${note.title ?? note.id}`;
    return new Promise(resolve => {
        run('nmem', ['memories', 'add', '--id', id, '-t', title, '-i', '0.4', '-l', 'lmc-ui', '--stdin'], { timeout: 15000, windowsHide: true }, error => {
            if (error) logger.debug(`[interactive] nmem add failed: ${error.message}`);
            resolve(!error);
        }).stdin?.end(blockNoteText(note));
    });
}

/**
 * Watches engine text for finished blocks and registers each id once per
 * process. A block streamed in pieces is seen complete when the final text
 * arrives; the same block re-sent (a replay, a refresh) is not re-registered.
 */
export function createBlockRegistrar(context: () => Omit<BlockNote, 'id' | 'title' | 'summary'>, register: (note: BlockNote) => Promise<boolean> = registerInteractiveBlock) {
    const seen = new Set<string>();
    return (text: string) => {
        if (!text.includes('lmc-ui')) return;
        const blocks = extractInteractiveBlocks(text);
        blocks.forEach((block, index) => {
            if (!block.id || !block.closed || !block.html.trim() || seen.has(block.id)) return;
            seen.add(block.id);
            void register({ ...context(), id: block.id, title: block.title, summary: summaryBeforeBlock(text, index) });
        });
    };
}
