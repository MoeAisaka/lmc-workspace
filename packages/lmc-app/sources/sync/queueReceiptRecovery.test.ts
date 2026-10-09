import { describe, expect, it } from 'vitest';
import { queueReceiptRecoveryTargets, isMatchingQueueReceipt } from './queueReceiptRecovery';
import { pendingQueuePrompts, visibleTranscriptMessages } from './queuedMessageVisibility';
import { normalizeRawMessage } from './typesRaw';
import { createReducer, reducer } from './reducer/reducer';
import type { Message } from './typesMessage';
const prompt: Message = { kind: 'user-text', id: 'prompt', localId: 'q', createdAt: 1, serverSeq: 128028, text: 'queued', meta: { queueKey: 'q' } };
const receipt = (keys: string[]) => normalizeRawMessage('receipt', null, 2, { role: 'agent', content: { type: 'event', id: 'event', data: { type: 'queue-released', keys } } })!;
describe('missing queue receipt recovery', () => {
    it('reads only durable orphan prompts, never optimistic or actual queued rows', () => {
        expect(queueReceiptRecoveryTargets([prompt], [])).toEqual([{ key: 'q', seq: 128028 }]);
        expect(queueReceiptRecoveryTargets([{ ...prompt, serverSeq: undefined }], [])).toEqual([]);
        expect(queueReceiptRecoveryTargets([prompt], [{ key: 'q', preview: 'queued', createdAt: 1 }])).toEqual([]);
    });
    it('accepts only an exact durable control receipt, not later replies or matching prose', () => {
        expect(isMatchingQueueReceipt(receipt(['q']), new Set(['q']))).toBe(true);
        expect(isMatchingQueueReceipt(receipt(['other']), new Set(['q']))).toBe(false);
        expect(isMatchingQueueReceipt({ ...receipt(['q']), isSidechain: true }, new Set(['q']))).toBe(false);
        const prose = normalizeRawMessage('p', null, 3, { role: 'user', content: { type: 'text', text: 'queue-released q' } })!;
        expect(isMatchingQueueReceipt(prose, new Set(['q']))).toBe(false);
    });
    it('repairs an orphan using the existing reducer and anchors it at the original receipt', () => {
        const reply: Message = { kind: 'agent-text', id: 'later', localId: null, text: 'already answered', serverSeq: 128040, createdAt: 3 };
        expect(pendingQueuePrompts([reply, prompt], [])).toHaveLength(1);
        const recovered = reducer(createReducer(), [{ ...receipt(['q']), serverSeq: 128036 }]).messages;
        const messages = [reply, ...recovered, prompt];
        expect(pendingQueuePrompts(messages, [])).toEqual([]);
        expect(queueReceiptRecoveryTargets(messages, [])).toEqual([]);
        expect(visibleTranscriptMessages(messages).map(message => message.id)).toEqual(['later', 'prompt']);
        expect(pendingQueuePrompts(JSON.parse(JSON.stringify(messages)), [])).toEqual([]);
    });
});
