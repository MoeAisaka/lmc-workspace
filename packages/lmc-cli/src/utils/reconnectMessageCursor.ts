type ReconnectReceiver = {
    resumeIncomingMessagesFrom(seq: number): void;
    skipExistingMessages(): void;
};

export function restoreReconnectMessageCursor(session: ReconnectReceiver, cursor: string | undefined): void {
    if (cursor === undefined) {
        session.skipExistingMessages();
        return;
    }
    const seq = Number(cursor);
    if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(seq) || seq < 0) {
        throw new Error('Invalid message cursor');
    }
    session.resumeIncomingMessagesFrom(seq);
}
