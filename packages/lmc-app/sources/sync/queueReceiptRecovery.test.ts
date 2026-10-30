import { describe, expect, it } from 'vitest';
import {
    queueReceiptRecoveryTargets,
    isMatchingQueueReceipt,
    missingQueuedPromptTargets,
    isMatchingQueuedPromptMessage,
} from './queueReceiptRecovery';
import { pendingQueuePrompts, visibleTranscriptMessages } from './queuedMessageVisibility';
import { normalizeRawMessage } from './typesRaw';
import { createReducer, reducer } from './reducer/reducer';
import type { Message } from './typesMessage';
import { compareDisplayMessages } from './messageDisplayOrder';
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

describe('missing queued prompt backward recovery (refresh during long turn)', () => {
    it('identifies a released queued prompt when its user row sits hundreds of seqs before the loaded window', () => {
        const state = createReducer();
        const released = reducer(state, [{ ...receipt(['6dbf7566']), serverSeq: 171499 }]).messages;
        const priorReply: Message = {
            kind: 'agent-text',
            id: 'prior-reply',
            localId: null,
            text: '你可以让运营先去 .137 存量回归选',
            createdAt: 2000,
            serverSeq: 171496,
        };
        const currentTool: Message = {
            kind: 'tool-call',
            id: 'parallel-check',
            localId: null,
            createdAt: 2100,
            serverSeq: 171942,
            children: [],
            tool: {
                name: 'Read',
                input: {},
                description: null,
                state: 'completed',
                createdAt: 2100,
                startedAt: 2100,
                completedAt: 2105,
            },
        };
        const windowMessages = [currentTool, ...released, priorReply].sort(compareDisplayMessages);

        // Before backward recovery, the user prompt at seq=170697 is missing from visibleTranscriptMessages.
        expect(visibleTranscriptMessages(windowMessages).map(m => m.id)).toEqual(['parallel-check', 'prior-reply']);
        expect(missingQueuedPromptTargets(windowMessages, [], 171443)).toEqual([
            { key: '6dbf7566', beforeSeq: 171443, kind: 'released' },
        ]);

        // Recovering the user prompt (seq=170697) and its paired file attachment (seq=170696) places both at seq=171499.
        const rawAttachment = normalizeRawMessage('file-1', 'file-local-1', 1000, {
            role: 'session',
            meta: { queueKey: '6dbf7566' },
            content: {
                type: 'session',
                data: {
                    id: 'file-1',
                    time: 1000,
                    role: 'user',
                    ev: { t: 'file', ref: 'ref-1', name: 'spec.png', size: 1024 },
                },
            },
        })!;
        const rawPrompt = normalizeRawMessage('user-170697', '6dbf7566', 1001, {
            role: 'user',
            localKey: '6dbf7566',
            content: { type: 'text', text: '重新梳理下新中台需求' },
            meta: { sentFrom: 'ios', intent: 'queue', queueKey: '6dbf7566' },
        })!;

        expect(isMatchingQueuedPromptMessage(rawAttachment, new Set(['6dbf7566']))).toBe(true);
        expect(isMatchingQueuedPromptMessage(rawPrompt, new Set(['6dbf7566']))).toBe(true);

        const recovered = reducer(state, [
            { ...rawAttachment, serverSeq: 170696 },
            { ...rawPrompt, serverSeq: 170697 },
        ]).messages;
        const merged = [...windowMessages, ...recovered].sort(compareDisplayMessages);

        expect(missingQueuedPromptTargets(merged, [], 171443)).toEqual([]);
        expect(visibleTranscriptMessages(merged).map(m => m.kind === 'user-text' ? m.text : m.id)).toEqual([
            'parallel-check',
            '重新梳理下新中台需求',
            recovered.find(m => m.kind === 'tool-call')!.id,
            'prior-reply',
        ]);
    });

    it('skips withdrawn prompts and includes unloaded live queue items as queued targets', () => {
        const withdrawnReceipt = normalizeRawMessage('withdrawn-1', null, 2, {
            role: 'agent',
            content: { type: 'event', id: 'ev-w', data: { type: 'queue-withdrawn', key: 'w-key' } },
        })!;
        const messages = reducer(createReducer(), [
            { ...receipt(['w-key']), serverSeq: 500 },
            { ...withdrawnReceipt, serverSeq: 501 },
        ]).messages;
        expect(missingQueuedPromptTargets(messages, [
            { key: 'w-key', preview: 'withdrawn', createdAt: 1 },
            { key: 'live-q', preview: 'still waiting', createdAt: 2 },
        ], 450)).toEqual([
            { key: 'live-q', beforeSeq: 450, kind: 'queued' },
        ]);
    });
});
