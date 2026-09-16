import { describe, expect, it } from 'vitest';
import { assertCodexModelEffort, ForeignEngineModelError, UnsupportedCodexEffortError } from './modelEffort';

describe('assertCodexModelEffort', () => {
    it('accepts an effort the model supports', () => {
        expect(() => assertCodexModelEffort('gpt-5.6-sol', 'ultra')).not.toThrow();
    });

    it('names the supported levels when the model does not support the effort', () => {
        expect(() => assertCodexModelEffort('gpt-5.6-luna', 'ultra')).toThrow(UnsupportedCodexEffortError);
    });

    it('leaves unknown and custom models to their provider', () => {
        expect(() => assertCodexModelEffort('my-workspace-model', 'ultra')).not.toThrow();
    });

    it('refuses a Claude model left behind by an engine switch', () => {
        // Without this the name travels to the app-server and returns as an
        // opaque 400, long after the reason can still be named.
        expect(() => assertCodexModelEffort('claude-fable-5-1', 'medium')).toThrow(ForeignEngineModelError);
    });

    it('refuses the foreign model even when the effort is one Codex would accept', () => {
        expect(() => assertCodexModelEffort('claude-opus-5', 'low')).toThrow(ForeignEngineModelError);
    });

    it('still delegates to Codex when no model is set', () => {
        expect(() => assertCodexModelEffort(null, 'medium')).not.toThrow();
        expect(() => assertCodexModelEffort(undefined, undefined)).not.toThrow();
    });
});
