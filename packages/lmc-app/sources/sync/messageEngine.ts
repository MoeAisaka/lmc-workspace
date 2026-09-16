import type { Message } from './typesMessage';

/**
 * Which engine wrote each message, for a transcript that changed hands.
 *
 * A session has one flavor — whichever engine is running it now — but after a
 * switch, everything above the boundary was written by a different one. Any
 * rendering rule that keys off the engine (suppressing Claude's duplicated
 * slash-command echo, for one) would otherwise be applied to the wrong half of
 * the transcript: turned off for messages that need it, or on for messages
 * that would lose their only copy of the command.
 *
 * The `engine-handoff` events are where the transcript changed hands, so they
 * are where the answer is read from, rather than being stored per message —
 * old messages predate the feature and would have nothing stored on them.
 *
 * `messages` is expected newest-first, the order the store keeps them in.
 * Returns null when the transcript never switched, which is nearly all of
 * them: callers then use the session flavor for everything, as before.
 */
export function buildMessageEngineMap(
    messages: Message[],
    sessionFlavor: string | null | undefined,
): ReadonlyMap<string, string | null> | null {
    let switched = false;
    for (const message of messages) {
        if (message.kind === 'agent-event' && message.event.type === 'engine-handoff') {
            switched = true;
            break;
        }
    }
    if (!switched) return null;

    const byMessage = new Map<string, string | null>();
    let flavor: string | null = sessionFlavor ?? null;
    for (const message of messages) {
        if (message.kind === 'agent-event' && message.event.type === 'engine-handoff') {
            // The event is emitted by the engine taking over, so it opens that
            // engine's stretch: everything older belongs to the one it names.
            // An event from before `fromFlavor` existed still marks a boundary,
            // and leaving the flavor as it was is the honest answer there.
            flavor = message.event.fromFlavor ?? flavor;
            continue;
        }
        byMessage.set(message.id, flavor);
    }
    return byMessage;
}
