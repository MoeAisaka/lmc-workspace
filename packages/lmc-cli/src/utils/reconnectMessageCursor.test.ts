import { describe, expect, it, vi } from 'vitest';
import { restoreReconnectMessageCursor } from './reconnectMessageCursor';

describe('restoreReconnectMessageCursor', () => {
    it.each(['0', '42'])('resumes from cursor %s without skipping messages arriving during replacement', cursor => {
        const session = { resumeIncomingMessagesFrom: vi.fn(), skipExistingMessages: vi.fn() };
        restoreReconnectMessageCursor(session, cursor);
        expect(session.resumeIncomingMessagesFrom).toHaveBeenCalledWith(Number(cursor));
        expect(session.skipExistingMessages).not.toHaveBeenCalled();
    });
    it('skips old messages for a normal reconnect without a cursor', () => {
        const session = { resumeIncomingMessagesFrom: vi.fn(), skipExistingMessages: vi.fn() };
        restoreReconnectMessageCursor(session, undefined);
        expect(session.skipExistingMessages).toHaveBeenCalledOnce();
        expect(session.resumeIncomingMessagesFrom).not.toHaveBeenCalled();
    });
    it.each(['', ' ', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992', '0x10'])('rejects invalid cursor %j before changing receive state', cursor => {
        const session = { resumeIncomingMessagesFrom: vi.fn(), skipExistingMessages: vi.fn() };
        expect(() => restoreReconnectMessageCursor(session, cursor)).toThrow('Invalid message cursor');
        expect(session.resumeIncomingMessagesFrom).not.toHaveBeenCalled();
        expect(session.skipExistingMessages).not.toHaveBeenCalled();
    });
});
