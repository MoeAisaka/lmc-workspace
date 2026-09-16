import { describe, expect, it } from 'vitest';
import { renderTranscript, renderTranscriptEntry } from './sessionTranscript';

const frame = (ev: any, extra: any = {}) => ({ role: 'session', content: { id: 'x', time: 1789126802774, role: 'agent', turn: 't', ev, ...extra }, meta: { sentFrom: 'cli' } });

describe('renderTranscriptEntry', () => {
    it('renders what a reader needs and drops bookkeeping', () => {
        expect(renderTranscriptEntry({ role: 'user', content: { type: 'text', text: 'Reply with LAB-READY' } })).toBe('[user] Reply with LAB-READY');
        expect(renderTranscriptEntry(frame({ t: 'text', text: 'LAB-READY' }))).toBe('[engine] LAB-READY');
        expect(renderTranscriptEntry(frame({ t: 'text', text: 'hmm', thinking: true }))).toBeNull();
        expect(renderTranscriptEntry(frame({ t: 'tool-call-start', call: 'c', name: 'Read', title: '', description: '', args: { file_path: '/a.ts' } }))).toBe('[tool] Read {"file_path":"/a.ts"}');
        expect(renderTranscriptEntry(frame({ t: 'tool-call-end', call: 'c' }))).toBeNull();
        expect(renderTranscriptEntry(frame({ t: 'turn-start' }))).toBeNull();
        expect(renderTranscriptEntry(frame({ t: 'turn-end', status: 'completed' }))).toBeNull();
        expect(renderTranscriptEntry(frame({ t: 'turn-end', status: 'failed' }))).toBe('[turn failed]');
    });

    it('marks the switch boundary and the briefing delivery rather than repeating the briefing', () => {
        expect(renderTranscriptEntry({ role: 'agent', content: { id: 'e', type: 'event', data: { type: 'engine-handoff', from: 'Claude Code', fromFlavor: 'claude', source: 'engine', briefing: '## Goal…' } } }))
            .toContain('Claude Code handed this session over here (its own notes)');
        expect(renderTranscriptEntry({ role: 'user', content: { type: 'text', text: '[handoff from Claude Code]\n\nlong…' }, meta: { displayText: '[handoff from Claude Code]' } }))
            .toBe('[handoff] [handoff from Claude Code] — briefing delivered to the engine taking over');
        expect(renderTranscriptEntry({ role: 'user', content: { type: 'text', text: '[engine switch requested]\nYour user…' } })).toBe('[user] asked to switch engine');
        expect(renderTranscriptEntry({ role: 'agent', content: { id: 'e', type: 'event', data: { type: 'ready' } } })).toBeNull();
    });

    it('reads older Claude SDK output frames', () => {
        const body = { role: 'agent', content: { type: 'output', data: { type: 'assistant', message: { content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 'u', name: 'Bash', input: { command: 'ls' } }] } } } };
        expect(renderTranscriptEntry(body)).toBe('[engine] On it.\n[tool] Bash {"command":"ls"}');
    });
});

describe('renderTranscript', () => {
    it('orders oldest first, stamps times, and keeps the newest lines that fit', () => {
        const entries = [
            { seq: 3, body: frame({ t: 'text', text: 'third' }) },
            { seq: 1, body: { role: 'user', content: { type: 'text', text: 'first' } } },
            { seq: 2, body: frame({ t: 'turn-start' }) },
        ];
        const all = renderTranscript(entries);
        expect(all.text.split('\n')).toEqual(['[user] first', expect.stringMatching(/^\d\d:\d\d \[engine\] third$/)]);
        expect(all.shown).toBe(2);
        expect(all.oldestSeq).toBe(1);
        const tight = renderTranscript(entries, 25);
        expect(tight.shown).toBe(1);
        expect(tight.text).toMatch(/third$/);
        expect(tight.oldestSeq).toBe(3);
    });
});
