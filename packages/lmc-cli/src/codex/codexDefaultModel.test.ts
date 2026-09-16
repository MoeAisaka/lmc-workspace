import { describe, expect, it } from 'vitest';
import { DEFAULT_CODEX_MODEL, DEFAULT_CODEX_EFFORT } from './runCodex';
import { assertCodexModelEffort } from './modelEffort';

/**
 * The model a Codex session runs when nothing chose one — no `--model` flag and
 * no model on the app's spawn. It is the value the CLI puts in session metadata
 * and sends to the app-server, so it has to name a model this engine can run
 * and an effort that model actually publishes.
 *
 * No request is made here: the constants are read straight from the launch
 * path, and the pairing is checked against the same catalog the send path uses.
 */
describe('the Codex launch default', () => {
    it('is GPT-6 Astra', () => {
        expect(DEFAULT_CODEX_MODEL).toBe('gpt-6-astra');
    });

    it('pairs with an effort that model publishes', () => {
        expect(() => assertCodexModelEffort(DEFAULT_CODEX_MODEL, DEFAULT_CODEX_EFFORT)).not.toThrow();
    });

    it('is not a model belonging to the other engine', () => {
        expect(() => assertCodexModelEffort(DEFAULT_CODEX_MODEL, null)).not.toThrow();
        expect(DEFAULT_CODEX_MODEL.startsWith('claude-')).toBe(false);
    });
});
