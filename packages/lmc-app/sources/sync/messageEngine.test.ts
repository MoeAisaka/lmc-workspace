import { describe, expect, it } from 'vitest';
import { buildMessageEngineMap } from './messageEngine';
import type { Message } from './typesMessage';

const user = (id: string, at: number): Message => ({ kind: 'user-text', id, localId: null, createdAt: at, text: '/clear' }) as Message;
const handoff = (id: string, at: number, fromFlavor?: 'claude' | 'codex'): Message => ({
    kind: 'agent-event', id, createdAt: at,
    event: { type: 'engine-handoff', from: 'Claude Code', fromFlavor, source: 'engine', briefing: '## Goal\nShip it' },
}) as Message;

/** The store keeps messages newest-first, and so do these fixtures. */
describe('buildMessageEngineMap', () => {
    it('says nothing at all about a session that never switched', () => {
        expect(buildMessageEngineMap([user('u2', 20), user('u1', 10)], 'claude')).toBeNull();
    });

    it('gives messages above the boundary the engine that handed over', () => {
        const map = buildMessageEngineMap([user('new', 30), handoff('h', 20, 'claude'), user('old', 10)], 'codex')!;
        expect(map.get('new')).toBe('codex');
        expect(map.get('old')).toBe('claude');
    });

    it('walks back through every switch, not just the last one', () => {
        const map = buildMessageEngineMap([
            user('third', 50),
            handoff('h2', 40, 'codex'),
            user('second', 30),
            handoff('h1', 20, 'claude'),
            user('first', 10),
        ], 'claude')!;
        expect(map.get('third')).toBe('claude');
        expect(map.get('second')).toBe('codex');
        expect(map.get('first')).toBe('claude');
    });

    it('keeps the flavor it had when a boundary predates the field, rather than guessing', () => {
        const map = buildMessageEngineMap([user('new', 30), handoff('h', 20), user('old', 10)], 'codex')!;
        expect(map.get('old')).toBe('codex');
    });
});
