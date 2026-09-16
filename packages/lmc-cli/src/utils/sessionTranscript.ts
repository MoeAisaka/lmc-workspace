/**
 * The session's transcript, rendered for an engine to read.
 *
 * This is the one record of a session that covers every engine that has
 * worked on it: user messages, what each engine said and did, and where it
 * changed hands. An engine taking a session over gets a short briefing; when
 * the briefing is not enough, this is what it reads next — and unlike the
 * engines' own thread files it lives on the server, so it is the same from
 * any machine.
 *
 * Rendered, not dumped. Raw frames carry usage counters, tool-call ids and
 * turn bookkeeping that say nothing to a reader; and both engines speak the
 * same session protocol, so one renderer serves both. Thinking is left out —
 * it is the engine's scratch, not the record.
 */

export interface TranscriptEntry {
    seq: number;
    body: unknown;
}

const LINE_CAP = 1200;
const ARGS_CAP = 300;

function cap(text: string, max: number): string {
    const single = text.replace(/\s+$/g, '');
    return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stamp(ms: unknown): string {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** One line (or a few) for a message, or null for frames a reader does not need. */
export function renderTranscriptEntry(body: unknown): string | null {
    if (!isRecord(body)) return null;
    const role = body.role;
    const content = body.content;

    if (role === 'user' && isRecord(content) && content.type === 'text' && typeof content.text === 'string') {
        const meta = isRecord(body.meta) ? body.meta : {};
        const display = typeof meta.displayText === 'string' ? meta.displayText : null;
        // The briefing delivered to an engine arrives as a user message; the
        // transcript shows the delivery, and the briefing itself is what the
        // engine already read.
        if (display?.startsWith('[handoff from')) return `[handoff] ${display} — briefing delivered to the engine taking over`;
        if (content.text.startsWith('[engine switch requested]')) return '[user] asked to switch engine';
        return `[user] ${cap(content.text, LINE_CAP)}`;
    }

    if (role === 'session' && isRecord(content) && isRecord(content.ev)) {
        const ev = content.ev;
        const who = content.role === 'user' ? 'user' : 'engine';
        switch (ev.t) {
            case 'text': {
                if (ev.thinking === true) return null;
                return typeof ev.text === 'string' && ev.text.trim() ? `[${who}] ${cap(ev.text, LINE_CAP)}` : null;
            }
            case 'tool-call-start': {
                const name = typeof ev.name === 'string' ? ev.name : 'tool';
                let args = '';
                try { args = JSON.stringify(ev.args ?? {}); } catch { args = ''; }
                return `[tool] ${name} ${cap(args, ARGS_CAP)}`;
            }
            case 'service': return typeof ev.text === 'string' ? `[note] ${cap(ev.text, LINE_CAP)}` : null;
            case 'file': return typeof ev.name === 'string' ? `[file] ${ev.name}` : null;
            case 'turn-end': return ev.status === 'completed' ? null : `[turn ${String(ev.status)}]`;
            case 'start': return typeof ev.title === 'string' && ev.title ? `[session] ${ev.title}` : null;
            default: return null;   // turn-start, tool-call-end, stop: bookkeeping
        }
    }

    if (role === 'agent' && isRecord(content)) {
        if (content.type === 'event' && isRecord(content.data)) {
            const data = content.data;
            switch (data.type) {
                case 'engine-handoff': return `[engine switch] ${String(data.from)} handed this session over here (${data.source === 'engine' ? 'its own notes' : 'notes compiled from the transcript'}). Everything above was written by ${String(data.from)}.`;
                case 'engine-switch-cancelled': return '[engine switch] called off; the session stayed where it was';
                case 'message': return typeof data.message === 'string' ? `[note] ${cap(data.message, LINE_CAP)}` : null;
                case 'permission-mode-changed': return `[note] permission mode → ${String(data.mode)}`;
                case 'switch': return `[note] session moved to ${String(data.mode)} mode`;
                default: return null;   // ready, limit-reached
            }
        }
        // Older Claude SDK frames: assistant content blocks and tool results.
        if (content.type === 'output' && isRecord(content.data)) {
            const data = content.data;
            const message = isRecord(data.message) ? data.message : null;
            const blocks = message && Array.isArray(message.content) ? message.content : null;
            if (!blocks) return null;
            const lines: string[] = [];
            for (const block of blocks) {
                if (!isRecord(block)) continue;
                if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) lines.push(`[engine] ${cap(block.text, LINE_CAP)}`);
                else if (block.type === 'tool_use') {
                    let args = '';
                    try { args = JSON.stringify(block.input ?? {}); } catch { args = ''; }
                    lines.push(`[tool] ${String(block.name)} ${cap(args, ARGS_CAP)}`);
                } else if (block.type === 'tool_result') {
                    const raw = typeof block.content === 'string' ? block.content
                        : Array.isArray(block.content) ? block.content.map((c) => isRecord(c) && typeof c.text === 'string' ? c.text : '').join('\n') : '';
                    if (raw.trim()) lines.push(`[result${block.is_error ? ' · error' : ''}] ${cap(raw, ARGS_CAP)}`);
                }
            }
            return lines.length ? lines.join('\n') : null;
        }
    }
    return null;
}

export interface RenderedTranscript {
    text: string;
    /** How many raw messages produced a line. */
    shown: number;
    /** The lowest sequence number covered, for paging further back. */
    oldestSeq: number | null;
}

/**
 * Renders entries oldest-first, with a time stamp where the frame has one,
 * and stops at `maxChars` from the newest end — the recent past is what a
 * reader taking over needs first.
 */
export function renderTranscript(entries: TranscriptEntry[], maxChars = 16_000): RenderedTranscript {
    const ordered = [...entries].sort((a, b) => a.seq - b.seq);
    const lines: { seq: number; text: string }[] = [];
    for (const entry of ordered) {
        const line = renderTranscriptEntry(entry.body);
        if (!line) continue;
        const time = isRecord(entry.body) && isRecord(entry.body.content) ? stamp(entry.body.content.time) : '';
        lines.push({ seq: entry.seq, text: time ? `${time} ${line}` : line });
    }
    // Keep the newest lines that fit.
    let total = 0;
    let start = lines.length;
    while (start > 0 && total + lines[start - 1].text.length + 1 <= maxChars) {
        start -= 1;
        total += lines[start].text.length + 1;
    }
    const kept = lines.slice(start);
    return {
        text: kept.map((l) => l.text).join('\n'),
        shown: kept.length,
        oldestSeq: kept.length ? kept[0].seq : (ordered.length ? ordered[0].seq : null),
    };
}
