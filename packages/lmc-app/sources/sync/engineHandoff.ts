import type { Message } from './typesMessage';

/**
 * What one engine tells the next about the work in progress.
 *
 * Neither engine can read the other's transcript store, so a switch cannot
 * carry context — it can only describe it. The description is written by the
 * engine being left, because it is the only party that knows why the code looks
 * the way it does; this shape is what it is asked for, and the fields are the
 * questions someone taking over actually has.
 *
 * Sizes are capped because an engine asked for a summary will otherwise write
 * the conversation back out, and the point of a handoff is that it is shorter
 * than what it replaces.
 */
export interface EngineHandoff {
    /** What the user is trying to get, not what was just done. */
    goal: string;
    done: string;
    pending: string;
    /** Files touched, and why — a path alone tells the next engine nothing. */
    files: string[];
    /** Dead ends, environment quirks, things not worth trying again. */
    pitfalls: string[];
    /** The specific first action for whoever picks this up. */
    nextStep: string;
    /** Anything that needs the user to decide. */
    openQuestions: string[];
}

/**
 * The briefing crosses the process boundary in session metadata, which is
 * re-sent whenever anything else in it changes, so it has to stay small. These
 * caps put the worst case around 4KB — roughly a thousand tokens, which is a
 * briefing rather than a retelling.
 */
export const HANDOFF_LIMITS = {
    text: 700,
    item: 160,
    items: 10,
    briefing: 4000,
} as const;

/** Where a handoff came from — the reader deserves to know which they are reading. */
export type HandoffSource = 'engine' | 'compiled';

/** The line every briefing opens with, so its reader knows who is speaking. */
const BRIEFING_MARKER = '[handoff from ';

/**
 * Whether this user message is a briefing being delivered to the engine.
 *
 * A briefing arrives as a user message because that is the only way into an
 * engine, but the user did not say it: the transcript marks the switch with a
 * boundary of its own, which is both where it belongs and where the full text
 * can be opened. Rendering the message too would duplicate it and misattribute
 * it at the same time.
 *
 * Gated on the absence of a `localId` the way the slash-command echo is, so a
 * message actually typed in the app is never mistaken for one.
 */
export function isHandoffDelivery(text: string, hasLocalId: boolean, displayText?: string | null): boolean {
    if (!text.startsWith(BRIEFING_MARKER)) return false;
    // The runner labels its delivery with the marker as display text, which a
    // person typing the same opening words would not have; its messages also
    // carry a localId like everything else the CLI enqueues, so that alone
    // cannot tell them apart.
    if (displayText?.startsWith(BRIEFING_MARKER)) return true;
    return !hasLocalId;
}

function clampText(value: unknown, max: number): string {
    if (typeof value !== 'string') return '';
    const single = value.trim();
    return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function clampList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((entry) => clampText(entry, HANDOFF_LIMITS.item))
        .filter((entry) => entry.length > 0)
        .slice(0, HANDOFF_LIMITS.items);
}

/** Accepts whatever an engine submitted, keeping only what fits the shape. */
export function normalizeHandoff(value: unknown): EngineHandoff | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    const handoff: EngineHandoff = {
        goal: clampText(raw.goal, HANDOFF_LIMITS.text),
        done: clampText(raw.done, HANDOFF_LIMITS.text),
        pending: clampText(raw.pending, HANDOFF_LIMITS.text),
        files: clampList(raw.files),
        pitfalls: clampList(raw.pitfalls),
        nextStep: clampText(raw.nextStep, HANDOFF_LIMITS.text),
        openQuestions: clampList(raw.openQuestions),
    };
    // A handoff that says nothing is worse than none: it would be presented as
    // the engine's own account of the work when it is an empty form.
    return handoff.goal || handoff.done || handoff.nextStep ? handoff : null;
}

const RECENT_TURNS = 8;
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'apply_patch']);

function toolFilePath(input: unknown): string | null {
    if (!input || typeof input !== 'object') return null;
    const record = input as Record<string, unknown>;
    for (const key of ['file_path', 'path', 'filePath', 'notebook_path']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
}

/**
 * The handoff to use when the engine did not write one.
 *
 * Assembled from the transcript rather than from the engine, so it survives a
 * crash, a refusal, or a model that ignored the request. It is visibly worse —
 * it reports what happened, not why — which is why it is marked as compiled
 * wherever it is shown, and why it is a fallback rather than the plan.
 */
export function compileHandoff(messages: Message[]): EngineHandoff {
    const ordered = [...messages].sort((left, right) => left.createdAt - right.createdAt);
    // A briefing delivered by an earlier switch is not something the user
    // asked for, and taking it as the goal would compound one summary into the
    // next until the original request is gone.
    const userTexts = ordered.filter((message) => message.kind === 'user-text'
        && !isHandoffDelivery(message.text, message.localId != null, message.displayText)) as Extract<Message, { kind: 'user-text' }>[];
    const agentTexts = ordered.filter((message) => message.kind === 'agent-text' && !message.isThinking) as Extract<Message, { kind: 'agent-text' }>[];
    const toolCalls = ordered.filter((message) => message.kind === 'tool-call') as Extract<Message, { kind: 'tool-call' }>[];

    const files: string[] = [];
    for (const call of toolCalls) {
        if (!EDIT_TOOLS.has(call.tool.name)) continue;
        const path = toolFilePath(call.tool.input);
        if (path && !files.includes(path)) files.push(path);
    }

    const failed = toolCalls
        .filter((call) => call.tool.state === 'error')
        .map((call) => `${call.tool.name}${toolFilePath(call.tool.input) ? ` · ${toolFilePath(call.tool.input)}` : ''}`)
        .filter((entry, index, all) => all.indexOf(entry) === index);

    // The first request states the goal better than any later one: by the end
    // the conversation is discussing details of an answer, not asking for it.
    const goal = userTexts.length > 0 ? clampText(userTexts[0].text, HANDOFF_LIMITS.text) : '';
    const recent = [...userTexts.slice(-RECENT_TURNS), ...agentTexts.slice(-RECENT_TURNS)]
        .sort((left, right) => left.createdAt - right.createdAt)
        .map((message) => `${message.kind === 'user-text' ? 'User' : 'Agent'}: ${clampText(message.text, HANDOFF_LIMITS.item)}`);

    return {
        goal,
        done: clampText(recent.join('\n'), HANDOFF_LIMITS.text),
        pending: '',
        files: files.slice(0, HANDOFF_LIMITS.items),
        pitfalls: failed.slice(0, HANDOFF_LIMITS.items),
        nextStep: '',
        openQuestions: [],
    };
}

/**
 * The handoff as the next engine receives it: a plain-text briefing, since the
 * only way in is a user message. Says outright that it is a handoff and not the
 * user speaking, the same way agent mail has to.
 */
export function formatHandoffBriefing(handoff: EngineHandoff, from: string, source: HandoffSource): string {
    const section = (title: string, body: string) => (body ? `## ${title}\n${body}` : null);
    const list = (title: string, entries: string[]) => (entries.length ? `## ${title}\n${entries.map((entry) => `- ${entry}`).join('\n')}` : null);
    return [
        `[handoff from ${from}]`,
        source === 'engine'
            ? 'You are taking over a session already in progress. The previous engine wrote the notes below before handing over; its own context does not carry across. Read the files named before changing them.'
            : 'You are taking over a session already in progress. The previous engine did not leave notes, so the following was assembled from the transcript — it reports what happened, not why. Treat it as a starting point and verify before acting.',
        '',
        section('Goal', handoff.goal),
        section('Done', handoff.done),
        section('Not done', handoff.pending),
        list('Files', handoff.files),
        list('Pitfalls', handoff.pitfalls),
        section('Next step', handoff.nextStep),
        list('Open questions', handoff.openQuestions),
    ].filter(Boolean).join('\n\n').slice(0, HANDOFF_LIMITS.briefing);
}
