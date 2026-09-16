/**
 * The briefing an engine writes when handing its session to another.
 *
 * The app has the matching piece: it compiles a fallback from the transcript
 * and sends it already formatted, so this side never needs the transcript and
 * that side never needs the tool. The two produce the same document — same
 * headings, same order — because the reader should not be able to tell which
 * path a briefing took except by the line that says so.
 */

/** Keeps a briefing small enough to ride in session metadata. See the app's HANDOFF_LIMITS. */
const LIMITS = { text: 700, item: 160, items: 10, briefing: 4000 };

function clampText(value: unknown, max: number): string {
    if (typeof value !== 'string') return '';
    const single = value.trim();
    return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function clampList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((entry) => clampText(entry, LIMITS.item))
        .filter((entry) => entry.length > 0)
        .slice(0, LIMITS.items);
}

/**
 * Formats a submitted handoff, or returns null when it said nothing.
 *
 * An empty form is refused rather than stored: handed over as the engine's own
 * account of the work, a form with nothing in it is worse than admitting there
 * are no notes, because the next engine cannot tell it apart from real ones.
 */
export function formatSubmittedHandoff(document: unknown, from: string): string | null {
    if (!document || typeof document !== 'object') return null;
    const raw = document as Record<string, unknown>;
    const goal = clampText(raw.goal, LIMITS.text);
    const done = clampText(raw.done, LIMITS.text);
    const nextStep = clampText(raw.nextStep, LIMITS.text);
    if (!goal && !done && !nextStep) return null;

    const section = (title: string, body: string) => (body ? `## ${title}\n${body}` : null);
    const list = (title: string, entries: string[]) => (entries.length ? `## ${title}\n${entries.map((entry) => `- ${entry}`).join('\n')}` : null);
    return [
        `[handoff from ${from}]`,
        'You are taking over a session already in progress. The previous engine wrote the notes below before handing over; its own context does not carry across. Read the files named before changing them.',
        '',
        section('Goal', goal),
        section('Done', done),
        section('Not done', clampText(raw.pending, LIMITS.text)),
        list('Files', clampList(raw.files)),
        list('Pitfalls', clampList(raw.pitfalls)),
        section('Next step', nextStep),
        list('Open questions', clampList(raw.openQuestions)),
    ].filter(Boolean).join('\n\n').slice(0, LIMITS.briefing);
}
