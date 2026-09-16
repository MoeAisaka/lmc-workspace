import { describe, expect, it } from 'vitest';
import { compileHandoff, formatHandoffBriefing, HANDOFF_LIMITS, isHandoffDelivery, normalizeHandoff } from './engineHandoff';
import type { Message } from './typesMessage';

const user = (id: string, at: number, text: string): Message => ({ kind: 'user-text', id, localId: null, createdAt: at, text }) as Message;
const agent = (id: string, at: number, text: string): Message => ({ kind: 'agent-text', id, localId: null, createdAt: at, text }) as Message;
const tool = (id: string, at: number, name: string, input: any, state: 'completed' | 'error' = 'completed'): Message => ({
    kind: 'tool-call', id, localId: null, createdAt: at, children: [],
    tool: { name, state, input, createdAt: at, startedAt: at, completedAt: at, description: null },
}) as Message;

describe('normalizeHandoff', () => {
    it('keeps a submission that says something', () => {
        const handoff = normalizeHandoff({ goal: 'Ship the switch', done: 'Wrote the tool', nextStep: 'Wire the UI', files: ['a.ts'] });
        expect(handoff?.goal).toBe('Ship the switch');
        expect(handoff?.files).toEqual(['a.ts']);
    });

    it('refuses an empty form, which would be presented as the engine’s own account', () => {
        expect(normalizeHandoff({ goal: '', done: '', nextStep: '', files: [] })).toBeNull();
        expect(normalizeHandoff({ pitfalls: ['only this'] })).toBeNull();
        expect(normalizeHandoff(null)).toBeNull();
        expect(normalizeHandoff('a handoff')).toBeNull();
    });

    it('caps a submission that tries to write the conversation back out', () => {
        const handoff = normalizeHandoff({
            goal: 'x'.repeat(HANDOFF_LIMITS.text + 500),
            files: Array.from({ length: HANDOFF_LIMITS.items + 10 }, (_, index) => `file-${index}.ts`),
        });
        expect(handoff!.goal.length).toBe(HANDOFF_LIMITS.text);
        expect(handoff!.files.length).toBe(HANDOFF_LIMITS.items);
    });

    it('drops entries that are not text rather than failing the whole submission', () => {
        const handoff = normalizeHandoff({ goal: 'Ship it', files: ['a.ts', 42, '', null, 'b.ts'] });
        expect(handoff!.files).toEqual(['a.ts', 'b.ts']);
    });
});

describe('compileHandoff', () => {
    const transcript: Message[] = [
        user('u1', 10, 'Make the list group by device only'),
        tool('t1', 20, 'Edit', { file_path: '/repo/list.tsx' }),
        tool('t2', 30, 'Bash', { command: 'pnpm test' }, 'error'),
        tool('t3', 40, 'Edit', { file_path: '/repo/list.tsx' }),
        agent('a1', 50, 'Grouping is off by default now'),
        user('u2', 60, 'Also add a badge'),
    ];

    it('takes the goal from the first request, not the latest exchange', () => {
        expect(compileHandoff(transcript).goal).toBe('Make the list group by device only');
    });

    it('lists each edited file once', () => {
        expect(compileHandoff(transcript).files).toEqual(['/repo/list.tsx']);
    });

    it('reports a failed tool call as a pitfall', () => {
        expect(compileHandoff(transcript).pitfalls).toEqual(['Bash']);
    });

    it('leaves the fields only an engine could fill empty rather than inventing them', () => {
        const handoff = compileHandoff(transcript);
        expect(handoff.nextStep).toBe('');
        expect(handoff.pending).toBe('');
        expect(handoff.openQuestions).toEqual([]);
    });

    it('survives a transcript with nothing in it', () => {
        expect(compileHandoff([]).goal).toBe('');
    });
});

describe('formatHandoffBriefing', () => {
    const handoff = { goal: 'Ship it', done: 'Wrote the tool', pending: '', files: ['a.ts'], pitfalls: [], nextStep: 'Wire the UI', openQuestions: [] };

    it('says who is speaking, because the receiver would otherwise read it as its user', () => {
        expect(formatHandoffBriefing(handoff, 'Claude', 'engine')).toContain('[handoff from Claude]');
    });

    it('tells the reader when the notes were assembled rather than written', () => {
        expect(formatHandoffBriefing(handoff, 'Codex', 'compiled')).toContain('did not leave notes');
        expect(formatHandoffBriefing(handoff, 'Codex', 'engine')).not.toContain('did not leave notes');
    });

    it('leaves out sections with nothing in them', () => {
        const text = formatHandoffBriefing(handoff, 'Claude', 'engine');
        expect(text).toContain('## Next step');
        expect(text).not.toContain('## Not done');
        expect(text).not.toContain('## Open questions');
    });
});

describe('isHandoffDelivery', () => {
    it('recognises the runner\'s delivery by its display text even though it carries a localId', () => {
        expect(isHandoffDelivery('[handoff from Claude Code]\n\nYou are taking over…', true, '[handoff from Claude Code]')).toBe(true);
        expect(isHandoffDelivery('[handoff from Claude Code] I typed this myself', true, undefined)).toBe(false);
    });
    it('recognises a briefing arriving for the engine', () => {
        expect(isHandoffDelivery('[handoff from Claude Code]\n\nYou are taking over…', false)).toBe(true);
    });

    it('never hides a message the user actually typed', () => {
        expect(isHandoffDelivery('[handoff from Claude Code] what does this mean?', true)).toBe(false);
        expect(isHandoffDelivery('Ship the switch', false)).toBe(false);
    });

    it('keeps an earlier briefing from becoming the next handoff’s goal', () => {
        const goal = compileHandoff([
            { kind: 'user-text', id: 'h', localId: null, createdAt: 10, text: '[handoff from Codex]\n\n## Goal\nSomething older' },
            { kind: 'user-text', id: 'u', localId: null, createdAt: 20, text: 'Add a badge' },
        ] as any).goal;
        expect(goal).toBe('Add a badge');
    });
});
