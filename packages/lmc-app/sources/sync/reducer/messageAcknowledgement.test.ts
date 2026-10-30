import { describe, expect, it, vi } from 'vitest';
import { createReducer, reducer } from './reducer';
import { normalizeRawMessage, RawRecordSchema, type NormalizedMessage } from '../typesRaw';
import type { Message } from '../typesMessage';
import { compareDisplayMessages } from '../messageDisplayOrder';
import { visibleTranscriptMessages } from '../queuedMessageVisibility';
import { groupMessagesForDisplay } from '@/hooks/useGroupedMessages';

vi.mock('@/components/tools/knownTools', () => ({ knownTools: {} }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

describe('acknowledged prompt turn boundary', () => {
    for (const engine of ['codex', 'claude'] as const) {
        for (const delivery of ['before-reply', 'after-reply', 'same-batch'] as const) {
            it(`${engine} / ${delivery}: keeps new work after the prompt despite a fast sender clock`, () => {
                const state = createReducer();
                const rows = new Map<string, Message>();
                const apply = (messages: NormalizedMessage[]) => {
                    const result = reducer(state, messages);
                    for (const message of result.messages) rows.set(message.id, message);
                    return result.messages;
                };
                const agent = (id: string, seq: number, text: string): NormalizedMessage => ({
                    ...normalizeRawMessage(id, null, seq * 100, RawRecordSchema.parse(engine === 'codex'
                        ? { role: 'session', content: { id, role: 'agent', turn: `turn-${seq}`, time: seq * 100, ev: { t: 'text', text } } }
                        : { role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: id, message: { role: 'assistant', model: 'claude', content: [{ type: 'text', text }] } } } }))!,
                    serverSeq: seq,
                });
                apply([agent('old', 10, '上一轮已结束')]);
                const prompt: NormalizedMessage = { id: 'local', localId: 'local', createdAt: 10000,
                    role: 'user', content: { type: 'text', text: '好' }, isSidechain: false };
                const echo = { ...prompt, id: 'server', createdAt: 1100, serverSeq: 11 };
                const [optimistic] = apply(delivery === 'same-batch' ? [prompt, echo] : [prompt]);
                if (delivery === 'before-reply') apply([echo]);
                apply([agent('new', 12, '就按这个方案推进')]);
                if (delivery === 'after-reply') apply([echo]);
                const visible = visibleTranscriptMessages([...rows.values()].sort(compareDisplayMessages));
                expect(visible.map(m => m.kind === 'agent-text' || m.kind === 'user-text' ? m.text : m.kind))
                    .toEqual(['就按这个方案推进', '好', '上一轮已结束']);
                expect(rows.get(optimistic.id)).toMatchObject({ id: optimistic.id, createdAt: 10000, serverSeq: 11 });
                expect(groupMessagesForDisplay(visible).map(item => item.type)).toEqual(['message', 'message', 'message']);
                expect(apply([{ ...prompt, id: 'server', createdAt: 1100, serverSeq: 11 }])).toEqual([]);
                expect(apply([prompt])).toEqual([]);
                expect(rows.size).toBe(3);
            });
        }
    }

    for (const delivery of ['before-reply', 'after-reply', 'same-batch', 'echo-first'] as const) {
        it(`attachment / ${delivery}: keeps the reply and tools after an acknowledged image prompt`, () => {
            const state = createReducer();
            const rows = new Map<string, Message>();
            const apply = (messages: NormalizedMessage[]) => {
                const result = reducer(state, messages);
                for (const message of result.messages) rows.set(message.id, message);
                return result.messages;
            };
            const envelope = (id: string, time: number, ev: object, seq?: number): NormalizedMessage => ({
                ...normalizeRawMessage(id, null, time, RawRecordSchema.parse({
                    role: 'session', content: { id, role: 'agent', turn: 'turn', time, ev },
                }))!,
                serverSeq: seq,
            });
            apply([envelope('old', 5000, { t: 'text', text: '上一轮已结束' }, 100)]);
            const fileRecord = RawRecordSchema.parse({ role: 'session', content: {
                id: 'image-envelope', time: 10000, role: 'user',
                ev: { t: 'file', ref: 'image-ref', name: 'image.png', size: 100, image: { width: 80, height: 60 } },
            } });
            const file = normalizeRawMessage('local-file', 'local-file', 10000, fileRecord)!;
            const fileEcho = { ...normalizeRawMessage('server-file', 'local-file', 8000, fileRecord)!, serverSeq: 101 };
            // Session file envelopes normalize as agent tool rows, unlike the text prompt.
            const prompt: NormalizedMessage = { id: 'local-text', localId: 'local-text', createdAt: 10001,
                role: 'user', content: { type: 'text', text: '我在MacBook上看不到' }, isSidechain: false };
            const promptEcho = { ...prompt, id: 'server-text', createdAt: 8001, serverSeq: 102 };
            const initialFiles = delivery === 'same-batch' ? [file, fileEcho]
                : delivery === 'echo-first' ? [fileEcho, file] : [file];
            const [fileRow] = apply(initialFiles);
            const [promptRow] = apply([prompt]);
            apply([promptEcho]);
            if (delivery === 'before-reply') apply([fileEcho]);
            // The executor clock trails the sender. A later tool is necessary to
            // reproduce the inconsistent sort seen in the live screenshot.
            apply([envelope('reply', 9000, { t: 'text', text: '我来改成可下载的附件' }, 105)]);
            apply([envelope('work', 10500, { t: 'tool-call-start', call: 'command', name: 'Bash', title: '运行命令', description: '', args: { command: 'pwd' } }, 106)]);
            if (delivery === 'after-reply') apply([fileEcho]);

            const visible = visibleTranscriptMessages([...rows.values()].sort(compareDisplayMessages));
            const labels = (messages: Message[]) => messages.map(m => m.kind === 'agent-text' || m.kind === 'user-text'
                ? m.text : m.kind === 'tool-call' ? m.tool.name : m.kind);
            expect(labels(visible)).toEqual(['Bash', '我来改成可下载的附件', '我在MacBook上看不到', 'file', '上一轮已结束']);
            const grouped = groupMessagesForDisplay(visible, true, { collapseCurrentTurn: false, timelineCurrentTurn: true });
            expect(grouped.map(item => item.type)).toEqual(['agent-work-group', 'message', 'message', 'message']);
            if (grouped[0].type === 'agent-work-group') {
                expect(labels(grouped[0].messages)).toEqual(['Bash', '我来改成可下载的附件']);
            }
            expect(rows.get(fileRow.id)).toMatchObject({ id: fileRow.id, createdAt: 10000, serverSeq: 101 });
            expect(rows.get(promptRow.id)).toMatchObject({ id: promptRow.id, createdAt: 10001, serverSeq: 102 });
            expect(apply([fileEcho, promptEcho])).toEqual([]);
            expect(apply([file, prompt])).toEqual([]);
            expect(rows.size).toBe(5);
        });
    }
});
