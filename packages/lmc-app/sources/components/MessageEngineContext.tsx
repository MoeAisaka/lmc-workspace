import * as React from 'react';

/**
 * The engine each message came from, for transcripts that changed engines
 * mid-session. Null — the ordinary case — means no switch ever happened and
 * the session flavor describes every message.
 *
 * A context rather than a prop because the answer is needed deep inside tool
 * groups, and threading it through every intermediate view would touch a lot
 * of code to say something that is almost always "the same as the session".
 */
const MessageEngineContext = React.createContext<ReadonlyMap<string, string | null> | null>(null);

export const MessageEngineProvider = MessageEngineContext.Provider;

/** The flavor that wrote this message, falling back to the session's own. */
export function useMessageFlavor(messageId: string, sessionFlavor: string | null | undefined): string | null | undefined {
    const byMessage = React.useContext(MessageEngineContext);
    if (!byMessage) return sessionFlavor;
    const flavor = byMessage.get(messageId);
    return flavor === undefined ? sessionFlavor : flavor;
}
