import { describe, expect, it } from 'vitest';
import { threadHasLmcSystemBlock } from './threadHasLmcSystem';
import { HAPPY_SYSTEM_BLOCK_OPEN, HAPPY_SYSTEM_BLOCK_CLOSE } from '@/codex/codexPrompt';

const userTurn = (text: string) => ({
    id: 't1',
    items: [{ type: 'userMessage' as const, id: 'i1', content: [{ type: 'text' as const, text }] }],
});

describe('threadHasLmcSystemBlock', () => {
    it('finds the wrapper in a user turn', () => {
        const text = `${HAPPY_SYSTEM_BLOCK_OPEN}\nuse options\n${HAPPY_SYSTEM_BLOCK_CLOSE}\n\nhello`;
        expect(threadHasLmcSystemBlock({ turns: [userTurn(text)] })).toBe(true);
    });

    it('reports a thread that never received the instructions', () => {
        expect(threadHasLmcSystemBlock({ turns: [userTurn('just a question')] })).toBe(false);
    });

    it('treats an empty or absent history as not-injected', () => {
        expect(threadHasLmcSystemBlock({ turns: [] })).toBe(false);
        expect(threadHasLmcSystemBlock({})).toBe(false);
        expect(threadHasLmcSystemBlock({ turns: [{ id: 't', items: [] }] })).toBe(false);
    });

    it('does not accept agent text as evidence', () => {
        // A model that echoes the marker has not been given the instructions.
        const thread = { turns: [{ id: 't1', items: [
            { type: 'agentMessage' as const, id: 'a1', text: `I would write ${HAPPY_SYSTEM_BLOCK_OPEN} here` },
        ] }] };
        expect(threadHasLmcSystemBlock(thread)).toBe(false);
    });

    it('scans every turn and every content part', () => {
        const thread = { turns: [
            userTurn('first'),
            { id: 't2', items: [{ type: 'userMessage' as const, id: 'i2', content: [
                { type: 'image' as const, url: 'http://x/y.png' },
                { type: 'text' as const, text: `${HAPPY_SYSTEM_BLOCK_OPEN}\nrules\n${HAPPY_SYSTEM_BLOCK_CLOSE}` },
            ] }] },
        ] };
        expect(threadHasLmcSystemBlock(thread)).toBe(true);
    });
});
