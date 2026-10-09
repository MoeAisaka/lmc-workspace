import { describe, expect, it } from 'vitest';
import { pendingQueuePrompts, visibleTranscriptMessages } from './queuedMessageVisibility';
import { normalizeRawMessage } from './typesRaw';
import { createReducer, reducer } from './reducer/reducer';
import { compareDisplayMessages } from './messageDisplayOrder';
import type { Message, UserTextMessage } from './typesMessage';

const user = (id: string, localId: string | null, text = 'same prompt'): UserTextMessage => ({
    kind: 'user-text', id, localId, text, createdAt: 1,
});

describe('released prompt transcript position', () => {
    const prompt = (key: string, seq: number): Message => ({
        ...user(`prompt-${key}`, key), createdAt: seq, serverSeq: seq, meta: { queueKey: key },
    });
    const reply = (id: string, seq: number): Message => ({
        kind: 'agent-text', id, localId: null, text: id, createdAt: seq, serverSeq: seq,
    });
    const release = (id: string, seq: number, keys: string[]): Message => ({
        kind: 'agent-event', id, createdAt: seq, serverSeq: seq, event: { type: 'queue-released', keys },
    });
    const transcript = (...messages: Message[]) => visibleTranscriptMessages(messages.sort(compareDisplayMessages));
    const ids = (messages: Message[]) => messages.map(message => message.id);

    it('appears after work done while waiting, then stays before the subsequent answer', () => {
        const queued = prompt('key', 1), working = reply('while-waiting', 2), receipt = release('release', 3, ['key']);
        expect(ids(transcript(queued, working))).toEqual(['while-waiting']);
        expect(ids(transcript(queued, working, receipt))).toEqual(['prompt-key', 'while-waiting']);
        expect(ids(transcript(queued, working, receipt, reply('after-release', 4))))
            .toEqual(['after-release', 'prompt-key', 'while-waiting']);
        expect(queued).toMatchObject({ createdAt: 1, serverSeq: 1, localId: 'key' });
        expect(transcript(queued, working, receipt)[0]).toBe(queued);
    });

    it('follows individual release order when a later prompt is steered or promoted first', () => {
        const messages = [prompt('first', 1), prompt('second', 2), reply('working', 3),
            release('steered-second', 4, ['second']), reply('after-steer', 5),
            release('drained-first', 6, ['first']), reply('after-drain', 7)];
        expect(ids(transcript(...messages))).toEqual([
            'after-drain', 'prompt-first', 'after-steer', 'prompt-second', 'working',
        ]);
    });

    it('keeps each attachment with its prompt and uses the consumed order within a batch', () => {
        const attachment: Message = { kind: 'tool-call', id: 'image', localId: 'file-id', createdAt: 3, serverSeq: 3,
            meta: { queueKey: 'first' }, tool: { name: 'file', input: {}, state: 'completed', createdAt: 3, startedAt: 3, completedAt: 3, description: null }, children: [] };
        const messages = [prompt('first', 1), prompt('second', 2), attachment, reply('working', 4),
            release('batch', 5, ['second', 'first'])];
        expect(ids(transcript(...messages))).toEqual(['image', 'prompt-first', 'prompt-second', 'working']);
    });

    it('uses the first durable release and does not move again when its receipt is repeated', () => {
        const messages = [prompt('key', 1), reply('before', 2), release('first-release', 3, ['key']),
            reply('after', 4), release('repeated-release', 5, ['key'])];
        expect(ids(transcript(...messages))).toEqual(['after', 'prompt-key', 'before']);
        const withdrawn: Message = { kind: 'agent-event', id: 'withdrawn', createdAt: 6, serverSeq: 6,
            event: { type: 'queue-withdrawn', key: 'key' } };
        expect(ids(transcript(...messages, withdrawn))).toEqual(['after', 'before']);
    });

    it('recovers the same position after reload or after the older prompt page arrives', () => {
        const recent = [reply('before', 2), release('released', 3, ['key']), reply('after', 4)];
        expect(ids(transcript(...recent))).toEqual(['after', 'before']);
        const messages = [prompt('key', 1), ...recent];
        expect(ids(transcript(...messages))).toEqual(['after', 'prompt-key', 'before']);
        expect(transcript(...JSON.parse(JSON.stringify(messages)))).toEqual(transcript(...messages));
    });

    it('uses the server-ordered receipt position despite device clock skew', () => {
        const queued = { ...prompt('key', 1), createdAt: 10000 };
        const receipt = { ...release('released', 3, ['key']), createdAt: 0 };
        expect(ids(transcript(queued, reply('before', 2), receipt, reply('after', 4))))
            .toEqual(['after', 'prompt-key', 'before']);
    });

    it('anchors a legacy prompt by local identity when a durable receipt is available', () => {
        const legacy = { ...user('legacy', 'key'), serverSeq: 1 };
        expect(ids(transcript(legacy, reply('before', 2), release('released', 3, ['key']))))
            .toEqual(['legacy', 'before']);
    });
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

describe('a stale queued prompt whose release never reached this tab', () => {
    const queued: UserTextMessage = { kind: 'user-text', id: 'q', localId: 'q', text: 'GPT有5小时额度', createdAt: 10, serverSeq: 10, meta: { queueKey: 'q', sentFrom: 'web' } } as UserTextMessage;
    const idleSend = (seq: number, meta: Record<string, unknown>): UserTextMessage => ({ kind: 'user-text', id: `u${seq}`, localId: `u${seq}`, text: 'later', createdAt: seq, serverSeq: seq, meta } as UserTextMessage);

    it('stops spinning once a person sent a later prompt without queueing it', () => {
        expect(pendingQueuePrompts([queued, idleSend(20, { sentFrom: 'web' })], null)).toEqual([]);
    });

    it('keeps waiting when nothing says the engine went idle', () => {
        // Agent mail carries no sentFrom and can arrive mid-turn; a later queued
        // prompt means the engine was still busy; an earlier idle send says nothing.
        expect(pendingQueuePrompts([queued, idleSend(20, {})], null)).toHaveLength(1);
        expect(pendingQueuePrompts([queued, idleSend(20, { sentFrom: 'web', queueKey: 'later' })], null).map(p => p.key)).toEqual(['q', 'later']);
        expect(pendingQueuePrompts([idleSend(5, { sentFrom: 'web' }), queued], null)).toHaveLength(1);
    });

    it('still shows the agent\'s own queue entry for the same prompt', () => {
        const items = pendingQueuePrompts([queued, idleSend(20, { sentFrom: 'web' })], [{ key: 'q', preview: 'GPT有5小时额度', createdAt: 10 }]);
        expect(items.map(p => [p.key, p.awaitingAgent])).toEqual([['q', undefined]]);
    });
});
