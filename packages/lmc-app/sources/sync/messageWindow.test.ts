import { createReducer, reducer } from './reducer/reducer';
import { compareDisplayMessages } from './messageDisplayOrder';
import { describe, expect, it } from 'vitest';

import type { NormalizedMessage } from './typesRaw';
import {
    derivedMessagesEqual,
    estimateNormalizedMessageBytes,
    mergeAndSelectMessageWindow,
    rebuildDerivedMessageWindow,
} from './messageWindow';

function user(id: string, createdAt: number, text = id): NormalizedMessage {
    return {
        id,
        localId: `local-${id}`,
        createdAt,
        isSidechain: false,
        role: 'user',
        content: { type: 'text', text },
        serverSeq: createdAt,
    };
}

function agent(id: string, createdAt: number, text = id): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        isSidechain: false,
        role: 'agent',
        content: [{ type: 'text', text, uuid: id, parentUUID: null }],
        serverSeq: createdAt,
    };
}

function ready(id: string, seq: number): NormalizedMessage {
    return { id, localId: null, createdAt: seq, serverSeq: seq, role: 'event', isSidechain: false, content: { type: 'ready' } };
}

describe('completed turn retention', () => {
    const a = [user('a', 1), agent('a-output', 2), ready('a-end', 3)];
    const b = [user('b', 4), agent('b-output', 5), ready('b-end', 6)];
    const c = [user('c', 7), agent('c-output', 8)];
    it('keeps A B and all of active C without truncating large output', () => {
        const huge = agent('large', 9, 'x'.repeat(600000));
        const result = mergeAndSelectMessageWindow([...a, ...b], [...c, huge], 'newest');
        expect(result.messages).toEqual([...a, ...b, ...c, huge]);
        expect(result.compactedIds).toEqual([]);
        expect(result.evictedIds).toEqual([]);
    });
    it('evicts A only when C ends, keeping full B and C', () => {
        const end = ready('c-end', 9);
        const result = mergeAndSelectMessageWindow([...a, ...b, ...c], [end], 'newest');
        expect(result.messages).toEqual([...b, ...c, end]);
        expect(result.evictedIds).toEqual(a.map(m => m.id));
    });
    it('does not treat mid-turn user replies or sidechain ready as completed turns', () => {
        const incoming = [user('answer', 9), agent('more', 10), { ...ready('child-end', 11), isSidechain: true }];
        expect(mergeAndSelectMessageWindow([...a, ...b, ...c], incoming, 'newest').evictedIds).toEqual([]);
    });
    it('keeps reloaded A during updates and duplicate replay until D completes', () => {
        const end = ready('c-end', 9);
        const reloaded = mergeAndSelectMessageWindow([...b, ...c, end], a, 'older').messages;
        expect(reloaded).toEqual([...a, ...b, ...c, end]);
        const active = mergeAndSelectMessageWindow(reloaded, [end, user('d', 10), agent('d-output', 11)], 'newest');
        expect(active.evictedIds).toEqual([]);
        expect(mergeAndSelectMessageWindow(active.messages, [ready('d-end', 12)], 'newest').messages.map(m => m.id)).toEqual(['c', 'c-output', 'c-end', 'd', 'd-output', 'd-end']);
    });
    it('ignores consecutive ready markers and retains messages without lifecycle evidence', () => {
        expect(mergeAndSelectMessageWindow([], [...a, ready('duplicate-a-end', 3.5), ...b], 'newest').evictedIds).toEqual([]);
        const long = Array.from({ length: 1000 }, (_, i) => agent('m' + i, i));
        expect(mergeAndSelectMessageWindow([], long, 'newest').messages).toEqual(long);
    });
});

describe('derivedMessagesEqual', () => {
    it('treats structurally identical plain-data graphs as equal', () => {
        expect(derivedMessagesEqual(
            { id: 'a', kind: 'text', children: [{ text: 'hi', done: true }], count: 2 },
            { id: 'a', kind: 'text', children: [{ text: 'hi', done: true }], count: 2 },
        )).toBe(true);
    });

    it('detects nested differences, missing keys, and array-length changes', () => {
        expect(derivedMessagesEqual({ a: [1, 2] }, { a: [1, 2, 3] })).toBe(false);
        expect(derivedMessagesEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
        expect(derivedMessagesEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
        expect(derivedMessagesEqual(null, {})).toBe(false);
    });
});

describe('rebuildDerivedMessageWindow', () => {
    it('replays the same sources to the same derived ids', () => {
        // Derived ids must be deterministic: a trim-triggered rebuild that
        // renumbered rows gave every row a new React key and flashed the chat.
        const sources = [
            user('u1', 1, 'prompt'),
            agent('a1', 2, 'reply'),
            agent('a2', 3, 'more'),
        ];
        const first = rebuildDerivedMessageWindow(sources);
        const second = rebuildDerivedMessageWindow(sources);
        expect(first.messages.length).toBeGreaterThan(0);
        expect(second.messages.map((message) => message.id))
            .toEqual(first.messages.map((message) => message.id));
    });


    it('releases reducer dedupe and rendered entries for evicted sources', () => {
        const selected = mergeAndSelectMessageWindow(
            [],
            [agent('m1', 1), ready('end1', 2), agent('m2', 3), ready('end2', 4), agent('m3', 5), ready('end3', 6)],
            'newest',
        );

        const rebuilt = rebuildDerivedMessageWindow(selected.messages, null);

        expect(rebuilt.reducerState.messageIds.has('m1')).toBe(false);
        expect(rebuilt.reducerState.messageIds.has('m2')).toBe(true);
        expect(rebuilt.reducerState.messageIds.has('m3')).toBe(true);
        expect(rebuilt.messages.map((message) => message.kind === 'agent-text' ? message.text : message.kind))
            .toEqual(['m3', 'm2']);
        expect(Object.keys(rebuilt.messagesMap)).toHaveLength(2);
    });

    it('regenerates a pending permission independently of retained history', () => {
        const rebuilt = rebuildDerivedMessageWindow([], {
            requests: {
                permission1: {
                    tool: 'Bash',
                    arguments: { command: 'pwd' },
                    createdAt: 123,
                },
            },
            completedRequests: {},
        } as any);

        expect(rebuilt.messages).toHaveLength(1);
        const message = rebuilt.messages[0];
        expect(message.kind).toBe('tool-call');
        expect(message.kind === 'tool-call' && message.tool.permission).toMatchObject({
            id: 'permission1',
            status: 'pending',
        });
    });
});


describe('display ordering across clock changes', () => {
    it('preserves server order when a newer message has an older device timestamp', () => {
        const older = { ...agent('older', 2000), serverSeq: 10 };
        const newer = { ...agent('newer', 1000), serverSeq: 11 };
        const result = rebuildDerivedMessageWindow([older, newer]);
        expect(result.messages.map(m => m.kind === 'agent-text' ? m.text : '')).toEqual(['newer', 'older']);
    });
});


describe('incremental display ordering', () => {
    it('keeps equal-time messages in server order across reverse arrival batches', () => {
        const state = createReducer();
        const newest = reducer(state, [{ ...agent('new', 1000), serverSeq: 11 }]).messages;
        const older = reducer(state, [{ ...agent('old', 1000), serverSeq: 10 }]).messages;
        expect([...older, ...newest].sort(compareDisplayMessages).map(m => m.kind === 'agent-text' ? m.text : '')).toEqual(['new', 'old']);
    });
});
