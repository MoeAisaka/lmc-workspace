import { describe, expect, it } from 'vitest';
import { engineForModelKey, engineModelGroups } from './engineModelCatalog';

const t = (key: string) => key;

describe('engineModelGroups', () => {
    it('lists the running engine first and the other one after it', () => {
        const groups = engineModelGroups('claude', null, t)!;
        expect(groups.map((group) => [group.engine, group.current])).toEqual([['claude', true], ['codex', false]]);
        expect(groups[1].models.some((model) => model.key === 'gpt-6-astra')).toBe(true);
    });

    it('shows the other engine’s models on a Codex session too', () => {
        const groups = engineModelGroups('codex', null, t)!;
        expect(groups[0].engine).toBe('codex');
        expect(groups[1].models.some((model) => model.key.startsWith('claude-'))).toBe(true);
    });

    it('prefers the list the running session published over the built-in table', () => {
        const metadata = { models: [{ code: 'house-model', value: 'House model' }] } as any;
        const groups = engineModelGroups('claude', metadata, t)!;
        expect(groups[0].models.map((model) => model.key)).toEqual(['house-model']);
        // The engine that is not running has published nothing, so it keeps ours.
        expect(groups[1].models.length).toBeGreaterThan(1);
    });

    it('offers no switch to an engine that cannot be switched', () => {
        expect(engineModelGroups('gemini', null, t)).toBeNull();
        expect(engineModelGroups(null, null, t)).toBeNull();
    });
});

describe('engineForModelKey', () => {
    it('says which engine would have to run a model', () => {
        const groups = engineModelGroups('claude', null, t)!;
        expect(engineForModelKey(groups, 'gpt-6-astra')).toBe('codex');
        expect(engineForModelKey(groups, 'claude-opus-5')).toBe('claude');
        expect(engineForModelKey(groups, 'not-a-model')).toBeNull();
    });
});
