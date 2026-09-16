import type { Message } from './typesMessage';

/** Newest first for the inverted chat list. Device clocks are not an ordering authority. */
export function compareDisplayMessages(a: Message, b: Message): number {
    if (a.serverSeq !== undefined && b.serverSeq !== undefined && a.serverSeq !== b.serverSeq) {
        return b.serverSeq - a.serverSeq;
    }
    return b.createdAt - a.createdAt;
}
