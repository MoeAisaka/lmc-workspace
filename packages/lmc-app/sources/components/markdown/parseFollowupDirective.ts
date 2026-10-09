export type FollowupOption = { title: string; prompt: string };

/** A complete, standalone assistant action; never evaluate attribute contents. */
export function parseFollowupDirective(line: string): FollowupOption | null {
    // Accept both the native directive and the single-colon/bulleted form seen
    // in replies. Quoted examples, inline code and ordinary prose don't match.
    const match = line.match(/^ {0,3}(?:(?:[-*+]|\d+\.)[ \t]+)?:{1,2}codex-followup\[([^\]\r\n]+)\]\{[ \t]*prompt[ \t]*=[ \t]*("(?:\\.|[^"\\])*")[ \t]*\}[ \t]*$/);
    if (!match) return null;
    try {
        const title = match[1].trim();
        const prompt: string = JSON.parse(match[2]);
        return title && prompt.trim() ? { title, prompt } : null;
    } catch {
        // A streamed, incomplete or malformed directive remains ordinary text.
        return null;
    }
}
