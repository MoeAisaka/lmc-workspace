/**
 * What a task cost, kept by the worker's runner turn by turn.
 *
 * Neither engine bills per task; both tell the runner what each turn used.
 * The meter keeps those turns with their time, and a report sums the ones
 * since the task was dispatched — so the hub learns what a task cost in
 * tokens (and, where the engine says so, in dollars) without anyone keeping
 * books by hand. The owner set no budget; this is the record, not a limit.
 */
export interface TurnUsage {
    inputTokens: number;
    outputTokens: number;
    /** Only when the engine reports it (Claude does per turn; Codex does not). */
    usd?: number;
    /** Output was estimated from the text (Claude streams the real count only at turn end). */
    estimated?: boolean;
}

export interface TaskMeter {
    add(usage: TurnUsage, at?: number): void;
    /** The engine's own total for the turn just finished: tops up what the per-call records missed (streamed output tokens arrive late) and prices it. */
    reconcile(total: TurnUsage, at?: number): void;
    /** A one-line summary of the turns since `sinceMs`, or null when there were none. */
    since(sinceMs: number): string | null;
    turnsSince(sinceMs: number): number;
}

const LIMIT = 2000;

export function createTaskMeter(): TaskMeter {
    const turns: (TurnUsage & { at: number; call?: boolean })[] = [];
    let turnStart = 0;
    const push = (record: TurnUsage & { at: number; call?: boolean }) => { turns.push(record); if (turns.length > LIMIT) turns.splice(0, turns.length - LIMIT); };
    return {
        add(usage, at = Date.now()) {
            if (!Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) return;
            push({ ...usage, at, call: true });
        },
        reconcile(total, at = Date.now()) {
            const mine = turns.slice(turnStart);
            // Estimates served their purpose mid-turn; the engine's count replaces them.
            for (const t of mine) if (t.estimated) { t.outputTokens = 0; delete t.estimated; }
            const input = Math.max(0, total.inputTokens - mine.reduce((s, t) => s + t.inputTokens, 0));
            const output = Math.max(0, total.outputTokens - mine.reduce((s, t) => s + t.outputTokens, 0));
            if (input || output || typeof total.usd === 'number') push({ inputTokens: input, outputTokens: output, ...(typeof total.usd === 'number' ? { usd: total.usd } : {}), at });
            turnStart = turns.length;
        },
        turnsSince(sinceMs) {
            return turns.filter((t) => t.at >= sinceMs && t.call).length;
        },
        since(sinceMs) {
            const mine = turns.filter((t) => t.at >= sinceMs);
            if (mine.length === 0) return null;
            const input = mine.reduce((sum, t) => sum + t.inputTokens, 0);
            const output = mine.reduce((sum, t) => sum + t.outputTokens, 0);
            const usd = mine.reduce((sum, t) => sum + (t.usd ?? 0), 0);
            const priced = mine.some((t) => typeof t.usd === 'number');
            const calls = mine.filter((t) => t.call).length;
            if (calls === 0 && !priced) return null;
            const approx = mine.some((t) => t.estimated);
            return `${calls} call${calls === 1 ? '' : 's'} · in ${fmt(input)} · out ${approx ? '≈' : ''}${fmt(output)}${priced ? ` · $${usd.toFixed(usd < 0.1 ? 3 : 2)}` : ''}`;
        },
    };
}

const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);

/**
 * Claude: every assistant message carries the usage of the API call that
 * produced it, so the meter fills in while the turn runs — a worker that
 * reports mid-turn still knows what the task cost so far. Dollars arrive only
 * with the turn's result, as a priced record with no tokens of its own.
 */
export function claudeTurnUsage(message: unknown): TurnUsage | null {
    if (!message || typeof message !== 'object') return null;
    const m = message as { type?: string; message?: { usage?: Record<string, unknown> }; total_cost_usd?: unknown };
    if (m.type === 'assistant' && m.message?.usage) {
        const u = m.message.usage;
        const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
        // The streamed usage carries the output count of the first chunk only;
        // the real number comes with the turn's result. Until then, size the
        // content: about four characters to a token.
        const content = (m.message as { content?: unknown }).content;
        const chars = Array.isArray(content) ? content.reduce((sum: number, block: unknown) => sum + JSON.stringify(block ?? '').length, 0) : 0;
        const estimate = Math.ceil(chars / 4);
        const reported = n('output_tokens');
        return reported >= estimate ? { inputTokens: n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens'), outputTokens: reported }
            : { inputTokens: n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens'), outputTokens: estimate, estimated: true };
    }
    return null;
}

/** Claude: the result's own totals for the turn, to reconcile the per-call records. */
export function claudeTurnTotal(message: unknown): TurnUsage | null {
    if (!message || typeof message !== 'object') return null;
    const m = message as { type?: string; usage?: Record<string, unknown>; total_cost_usd?: unknown };
    if (m.type !== 'result') return null;
    const u = m.usage ?? {};
    const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
    return { inputTokens: n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens'), outputTokens: n('output_tokens'), ...(typeof m.total_cost_usd === 'number' ? { usd: m.total_cost_usd } : {}) };
}

/** Codex `thread/tokenUsage/updated` (as the client's token_count event) → the last turn's usage. */
export function codexTurnUsage(message: unknown): TurnUsage | null {
    if (!message || typeof message !== 'object') return null;
    const m = message as { type?: string; last?: Record<string, unknown>; total?: Record<string, unknown> };
    if (m.type !== 'token_count') return null;
    const src = m.last ?? m.total;
    if (!src) return null;
    const n = (k: string) => (typeof src[k] === 'number' ? (src[k] as number) : 0);
    if (!n('inputTokens') && !n('outputTokens')) return null;
    return { inputTokens: n('inputTokens'), outputTokens: n('outputTokens') };
}
