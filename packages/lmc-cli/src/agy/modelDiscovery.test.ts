import { describe, it, expect } from 'vitest';
import { parseAgyModels } from './modelDiscovery';
describe('native Antigravity catalog', () => {
    it('groups only reported effort variants and leaves thinking models without invented efforts', () => {
        const models = parseAgyModels('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)');
        expect(models).toHaveLength(2);
        expect(models[0]).toMatchObject({id:'gemini-3.8-flash',efforts:['high','low'],effortModels:{high:'gemini-3.8-flash-high',low:'gemini-3.8-flash-low'}});
        expect(models[1].efforts).toEqual([]);
        expect(() => parseAgyModels('Sign in required')).toThrow();
    });
    it('defaults Gemini 4 models to high when high is advertised without inventing unadvertised efforts', () => {
        const models = parseAgyModels([
            'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
            'gemini-4-argon-high\tGemini 4 Argon (High)',
            'gemini-4-argon-low\tGemini 4 Argon (Low)',
            'gemini-4-lite-low\tGemini 4 Lite (Low)',
            'gemini-4-lite-medium\tGemini 4 Lite (Medium)',
            'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
            'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
        ].join('\n'));
        expect(models.find(m => m.id === 'gemini-4-argon')).toMatchObject({ defaultEffort: 'high', efforts: ['medium', 'high', 'low'] });
        expect(models.find(m => m.id === 'gemini-4-lite')).toMatchObject({ defaultEffort: 'low', efforts: ['low', 'medium'] });
        expect(models.find(m => m.id === 'claude-opus-5-5')).toMatchObject({ defaultEffort: 'low', efforts: ['low', 'high'] });
    });
});
