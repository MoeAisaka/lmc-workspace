
/**
 * Reading the runner's framing off a delivered agent-mail message.
 *
 * Mail between sessions arrives as a user message whose first lines say who
 * wrote it and how it relates to this session; the cards need that apart from
 * the body. (Task state itself lives on the board in metadata, kept by the
 * runner — see the CLI's board.ts — not derived here.)
 */

/** The first line of a delivered mail, as the runner frames it. */
export type MailRelation = 'hub' | 'worker' | 'other';

export interface ParsedMail {
    relation: MailRelation;
    /** Who sent it, as the runner described them (device · engine · title). */
    who: string;
    /** The sender's session id when the framing carried it. */
    senderId: string | null;
    /** What they wrote, after the framing lines. */
    body: string;
}

const HEAD = /^\[(from your hub|from your worker|agent mail from)\s*·?\s*([^\]]*)\]\s*$/;

export function parseMail(text: string): ParsedMail | null {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const head = HEAD.exec(lines[0]?.trim() ?? '');
    if (!head) return null;
    const relation: MailRelation = head[1] === 'from your hub' ? 'hub' : head[1] === 'from your worker' ? 'worker' : 'other';
    // The framing runs until the first blank line; the sender id, when
    // present, sits in it as "session (id)" or "send_to_session to id".
    let cut = 1;
    while (cut < lines.length && lines[cut].trim()) cut += 1;
    const framing = lines.slice(1, cut).join('\n');
    const senderId = /session \(([A-Za-z0-9]+)\)/.exec(framing)?.[1] ?? /send_to_session to ([A-Za-z0-9]+)/.exec(framing)?.[1] ?? null;
    return { relation, who: head[2].trim(), senderId, body: lines.slice(cut + 1).join('\n').trim() };
}

export function isMailDelivery(text: string): boolean {
    return HEAD.test(text.split('\n', 1)[0]?.trim() ?? '');
}
