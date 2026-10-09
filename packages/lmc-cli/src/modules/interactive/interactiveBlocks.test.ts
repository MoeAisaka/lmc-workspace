import { describe, expect, it, vi } from 'vitest';
import { agentTextOfEntry, blockNoteText, createBlockRegistrar, findInteractiveBlock, recallInteractiveBlock, summaryBeforeBlock } from './interactiveBlocks';

const entry = (seq: number, text: string, role: 'agent' | 'user' = 'agent', thinking = false) =>
    ({ seq, body: { role: 'session', content: { role, ev: { t: 'text', text, ...(thinking ? { thinking: true } : {}) } } } });

describe('interactive blocks on the agent side', () => {
    it('reads only engine text out of transcript entries', () => {
        expect(agentTextOfEntry(entry(1, 'hi').body)).toBe('hi');
        expect(agentTextOfEntry(entry(1, 'hi', 'user').body)).toBeNull();
        expect(agentTextOfEntry(entry(1, 'hi', 'agent', true).body)).toBeNull();
        expect(agentTextOfEntry({ role: 'user', content: { type: 'text', text: 'hi' } })).toBeNull();
    });
    it('finds the newest complete block with the id', () => {
        const entries = [entry(3, '```lmc-ui id=a title="new"\n<p>2</p>\n```'), entry(1, '```lmc-ui id=a title="old"\n<p>1</p>\n```'), entry(5, '```lmc-ui id=a\n<p>cut')];
        expect(findInteractiveBlock(entries, 'a')).toMatchObject({ seq: 3, title: 'new', html: '<p>2</p>' });
        expect(findInteractiveBlock(entries, 'b')).toBeNull();
    });
    it('pages back until the block turns up, and stops at the start', async () => {
        const pages = [{ entries: [entry(9, 'later')], hasMore: true }, { entries: [entry(4, '```lmc-ui id=a\n<p>x</p>\n```')], hasMore: true }];
        const read = vi.fn(async ({ beforeSeq }: { beforeSeq?: number }) => beforeSeq === undefined ? pages[0] : pages[1]);
        expect(await recallInteractiveBlock(read, 'a')).toMatchObject({ seq: 4 });
        expect(read).toHaveBeenLastCalledWith({ limit: 200, beforeSeq: 9 });
        const empty = vi.fn(async () => ({ entries: [entry(1, 'nothing')], hasMore: false }));
        expect(await recallInteractiveBlock(empty, 'a')).toBeNull();
        expect(empty).toHaveBeenCalledTimes(1);
    });
    it('describes a block by the sentence before it and never includes the page', () => {
        const text = '# 套餐\n两种套餐差别不大，拖动滑块看。\n```lmc-ui id=plan title="套餐对比"\n<p>secret page</p>\n```\n结论。';
        expect(summaryBeforeBlock(text, 0)).toBe('两种套餐差别不大，拖动滑块看。');
        const note = blockNoteText({ sessionId: 's1', sessionTitle: '流量', machine: 'Mini', id: 'plan', title: '套餐对比', summary: summaryBeforeBlock(text, 0) });
        expect(note).toContain('recall_interactive_block id=plan session_id=s1');
        expect(note).not.toContain('secret page');
    });
    it('registers each finished block once, with its title and the sentence before it', () => {
        const notes: string[] = [];
        const registrar = createBlockRegistrar(() => ({ sessionId: 's', sessionTitle: null, machine: null }), async note => { notes.push(`${note.id}:${note.title}:${note.summary}`); return true; });
        registrar('看这个。\n```lmc-ui id=a title="A"\n<p>x');
        expect(notes).toEqual([]);
        registrar('看这个。\n```lmc-ui id=a title="A"\n<p>x</p>\n```');
        registrar('看这个。\n```lmc-ui id=a title="A"\n<p>x</p>\n```\n```lmc-ui ref=a\n```');
        registrar('```lmc-ui id=b\n<p>y</p>\n```');
        expect(notes).toEqual(['a:A:看这个。', 'b:null:']);
    });

});
