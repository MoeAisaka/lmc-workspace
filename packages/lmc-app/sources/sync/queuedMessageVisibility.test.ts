import { describe, expect, it } from 'vitest';
import { visibleTranscriptMessages } from './queuedMessageVisibility';
import { normalizeRawMessage } from './typesRaw';
import type { Message } from './typesMessage';

const user = (id: string, localId: string | null, text = 'same prompt'): Message => ({
    kind: 'user-text', id, localId, text, createdAt: 1,
});

describe('pending prompt transcript visibility', () => {
    it('omits repeated steer receipts even after reload with an empty queue', () => {
        const receipt: Message = { kind: 'agent-event', id: 'receipt', createdAt: 2,
            event: { type: 'message', message: 'Codex 已接收补充回复，将在当前工作中处理。' } };
        const prompt = user('prompt', 'prompt');
        const messages = [receipt, { ...receipt, id: 'receipt-2' }, prompt];
        for (const queue of [undefined, [], [{ key: 'unrelated' }]]) {
            expect(visibleTranscriptMessages(messages, queue)).toEqual([prompt]);
        }
        expect(messages).toHaveLength(3);
    });
    it('preserves delivery warnings, other engine events and identical conversational text', () => {
        const text = 'Codex 已接收补充回复，将在当前工作中处理。';
        const messages: Message[] = [
            user('quoted-user', null, text),
            { kind: 'agent-text', id: 'quoted-agent', localId: null, createdAt: 2, text },
            { kind: 'agent-event', id: 'warning', createdAt: 3,
                event: { type: 'message', message: '补充回复尚未确认送达 Codex；未自动重复发送，请检查连接和后续回应。' } },
            { kind: 'agent-event', id: 'claude', createdAt: 4,
                event: { type: 'message', message: 'Aborted by user' } },
        ];
        expect(visibleTranscriptMessages(messages)).toBe(messages);
    });
    it('hides by identity, preserves equal text and restores after consumption', () => {
        const original = user('usr-original', 'original');
        const waiting = user('usr-derived', 'queued');
        const response: Message = { kind: 'agent-text', id: 'response', localId: null, text: 'working', createdAt: 2 };
        const messages = [response, waiting, original];
        expect(visibleTranscriptMessages(messages, [{ key: 'queued' }])).toEqual([response, original]);
        expect(visibleTranscriptMessages(messages, [])).toBe(messages);
        expect(messages).toHaveLength(3);
    });
    it('keeps withdrawn prompts hidden after reload and pagination, regardless of receipt order', () => {
        const withdrawn = user('stored', 'key');
        const equalText = user('other', 'other-key');
        const normalized = normalizeRawMessage('withdrawal', null, 3, { role: 'agent', content: { id: 'receipt', type: 'event', data: { type: 'queue-withdrawn', key: 'key' } } } as any);
        expect(normalized?.role).toBe('event');
        const receipt: Message = { kind: 'agent-event', id: 'withdrawal', createdAt: 3, event: normalized!.content as any };
        for (const messages of [[receipt, withdrawn, equalText], [withdrawn, equalText, receipt]]) {
            expect(visibleTranscriptMessages(JSON.parse(JSON.stringify(messages)))).toEqual([equalText]);
        }
        expect(visibleTranscriptMessages([receipt])).toEqual([]);
    });
    it('supports optimistic ids and unrelated queue entries without text matching', () => {
        const messages = [user('optimistic', null)];
        expect(visibleTranscriptMessages(messages, [{ key: 'optimistic' }])).toEqual([]);
        expect(visibleTranscriptMessages(messages, [{ key: 'different' }])).toBe(messages);
        expect(visibleTranscriptMessages(messages)).toBe(messages);
    });
});
