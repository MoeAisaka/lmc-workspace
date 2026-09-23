import { expect, it, vi } from 'vitest';
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'zh-CN', languageCode: 'zh' }] }));
vi.mock('@/sync/persistence', () => ({ loadSettings: () => ({ settings: { preferredLanguage: 'zh-Hans' } }) }));
import { t } from './index';
import { localFeatureEnglish, localFeatureZhHans, localFeatureZhHant } from './localFeatures';
import { getEffortLevelsForModel, getCodexPermissionModes } from '@/components/modelModeOptions';
it('renders new agent and rename UI in Simplified Chinese', () => {
    expect(t('localFeatures.renameSession')).toBe('重命名会话');
    expect(t('localFeatures.agents')).toBe('智能体');
    // Levels keep the engine's own words in every language: they are
    // identifiers you will meet again in the CLI, not prose.
    expect(getEffortLevelsForModel('codex', 'gpt-6-astra', undefined, t).map(x => x.name)).toEqual(['Low', 'Medium', 'High', 'xHigh', 'Max', 'Ultra']);
    expect(getCodexPermissionModes(t)[0].name).toBe('自动');
});
it('covers every added key in both Chinese variants', () => {
    expect(Object.keys(localFeatureZhHans)).toEqual(Object.keys(localFeatureEnglish));
    expect(Object.keys(localFeatureZhHant)).toEqual(Object.keys(localFeatureEnglish));
    const sample = { floor: '50', date: '9/30 09:25', day: 1, days: 7, points: '9', count: 1 };
    for (const locale of [localFeatureZhHans, localFeatureZhHant]) {
        for (const value of Object.values(locale)) {
            const rendered = typeof value === 'function' ? value(sample) : value;
            expect(rendered).toMatch(/[\u3400-\u9fff]/);
            expect(rendered).not.toContain('undefined');
        }
    }
});
