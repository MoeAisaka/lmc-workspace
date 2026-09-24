import { describe, expect, it } from 'vitest';
import { pendingQueuePrompts, visibleTranscriptMessages } from './queuedMessageVisibility';
import { normalizeRawMessage } from './typesRaw';
import { createReducer, reducer } from './reducer/reducer';
import type { Message, UserTextMessage } from './typesMessage';

const user = (id: string, localId: string | null, text = 'same prompt'): UserTextMessage => ({
    kind: 'user-text', id, localId, text, createdAt: 1,
});

describe('pending prompt transcript visibility', () => {
    const queued = () => ({ ...user('optimistic', 'key'), meta: { intent: 'queue' as const, queueKey: 'key' } });
    const released: Message = { kind: 'agent-event', id: 'released', createdAt: 4, event: { type: 'queue-released', keys: ['key'] } };
    const remoteQueue = [{ key: 'key', preview: 'same prompt', createdAt: 1 }];

    it('starts in the strip before agentState arrives, never flashing in the transcript', () => {
        const messages = [queued()];
        for (const queue of [undefined, [], remoteQueue]) {
            expect(visibleTranscriptMessages(messages, queue)).toEqual([]);
            expect(pendingQueuePrompts(messages, queue)).toHaveLength(1);
        }
        expect(pendingQueuePrompts(messages, [])[0].awaitingAgent).toBe(true);
        expect(pendingQueuePrompts(messages, remoteQueue)[0].awaitingAgent).toBeUndefined();
    });

    it('copies complete text with whitespace before and after the agent acknowledges it', () => {
        const text = `  **完整原文**\n\n${'长消息 '.repeat(60)}\n最后一行  `;
        const message = { ...queued(), text };
        for (const queue of [undefined, [], remoteQueue]) {
            const [item] = pendingQueuePrompts([message], queue);
            expect(item.copyText).toBe(text);
            expect(item.preview.length).toBeLessThanOrEqual(120);
            expect(visibleTranscriptMessages([message], queue)).toEqual([]);
        }
        expect(remoteQueue[0]).not.toHaveProperty('copyText');
    });

    it('waits for the matching message instead of copying a truncated or equal preview', () => {
        expect(pendingQueuePrompts([], remoteQueue)[0].copyText).toBeUndefined();
        const unrelated = user('other', 'other', 'same prompt');
        expect(pendingQueuePrompts([unrelated], remoteQueue)[0].copyText).toBeUndefined();
        expect(pendingQueuePrompts([unrelated, user('stored', 'key', 'full prompt\nlast line')], remoteQueue)[0].copyText)
            .toBe('full prompt\nlast line');
    });

    it('uses sender-facing text, preserving an empty caption without copying internal framing', () => {
        const message: Message = { ...queued(), text: 'internal engine framing', displayText: 'visible text\nnext line' };
        expect(pendingQueuePrompts([message], remoteQueue)[0].copyText).toBe('visible text\nnext line');
        expect(pendingQueuePrompts([{ ...message, displayText: '' }], remoteQueue)[0].copyText).toBe('');
    });

    it('supports message id and durable queue key without requiring a local id', () => {
        expect(pendingQueuePrompts([user('key', null, 'old queue')], remoteQueue)[0].copyText).toBe('old queue');
        const message = { ...user('derived-id', null, 'durable queue'), meta: { queueKey: 'key' } };
        expect(pendingQueuePrompts([message], remoteQueue)[0].copyText).toBe('durable queue');
    });

    it('requires a release receipt, including when consumption beats the queue snapshot', () => {
        const messages = [queued(), released];
        for (const queue of [undefined, [], remoteQueue]) {
            expect(visibleTranscriptMessages(messages, queue)).toEqual([messages[0]]);
            expect(pendingQueuePrompts(messages, queue)).toEqual([]);
        }
        // The independent event stream may deliver the receipt before the prompt.
        expect(pendingQueuePrompts([released], remoteQueue)).toEqual([]);
        expect(visibleTranscriptMessages(JSON.parse(JSON.stringify(messages)))).toEqual([messages[0]]);
    });

    it('does not reveal input during a failed steer take/restore or a withdrawal race', () => {
        const messages = [queued()];
        for (const queue of [remoteQueue, [], remoteQueue]) expect(visibleTranscriptMessages(messages, queue)).toEqual([]);
        const withdrawn: Message = { kind: 'agent-event', id: 'withdrawn', createdAt: 3, event: { type: 'queue-withdrawn', key: 'key' } };
        expect(visibleTranscriptMessages([...messages, withdrawn], [])).toEqual([]);
        expect(pendingQueuePrompts([...messages, withdrawn], remoteQueue)).toEqual([]);
    });

    it('keeps attachments with their queued prompt and does not hide matching unrelated text', () => {
        const attachment: Message = { kind: 'tool-call', id: 'image', localId: 'file-id', createdAt: 1, meta: { queueKey: 'key' }, tool: { name: 'file', input: {}, state: 'completed', createdAt: 1, startedAt: 1, completedAt: 1, description: null }, children: [] };
        const other = user('other', 'other');
        expect(visibleTranscriptMessages([attachment, queued(), other], [])).toEqual([other]);
        expect(pendingQueuePrompts([attachment, queued(), other], [])).toHaveLength(1);
        expect(visibleTranscriptMessages([attachment, queued(), other, released], [])).toHaveLength(3);
    });

    it('normalizes durable metadata and receipts without losing their identities', () => {
        const normalized = normalizeRawMessage('sent', 'key', 1, { role: 'user', content: { type: 'text', text: 'prompt' }, meta: { intent: 'queue', queueKey: 'key' } } as any);
        expect(normalized?.meta?.queueKey).toBe('key');
        const receipt = normalizeRawMessage('event', null, 2, { role: 'agent', content: { id: 'receipt', type: 'event', data: { type: 'queue-released', keys: ['key'] } } } as any);
        expect(receipt?.content).toEqual({ type: 'queue-released', keys: ['key'] });
        const file = normalizeRawMessage('file', 'file-local', 1, {
            role: 'session', meta: { queueKey: 'key' }, content: { type: 'session', data: {
                id: 'image', time: 1, role: 'user', ev: { t: 'file', ref: 'attachment', name: 'image.png', size: 1 },
            } },
        } as any);
        expect(file?.meta?.queueKey).toBe('key');
        const reduced = reducer(createReducer(), [file!, normalized!, receipt!]).messages;
        expect(reduced.filter(message => message.meta?.queueKey === 'key')).toHaveLength(2);
        expect(visibleTranscriptMessages(reduced)).toHaveLength(2);
    });

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
