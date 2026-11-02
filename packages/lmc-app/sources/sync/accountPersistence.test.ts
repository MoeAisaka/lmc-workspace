import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ stores: new Map<string, Map<string, any>>() }));
vi.mock('react-native-mmkv', () => ({ MMKV: class {
    values: Map<string, any>;
    constructor(options?: { id: string }) { const id = options?.id ?? 'default'; if (!mocks.stores.has(id)) mocks.stores.set(id, new Map()); this.values = mocks.stores.get(id)!; }
    getString(key: string) { return this.values.get(key); }
    getBoolean(key: string) { return this.values.get(key); }
    set(key: string, value: unknown) { this.values.set(key, value); }
    delete(key: string) { this.values.delete(key); }
    clearAll() { this.values.clear(); }
} }));
import { selectAccountPersistence, loadSessionDrafts, saveSessionDrafts, loadPendingSettings, saveSettings } from './persistence';
import { settingsDefaults } from './settings';
import { getCurrentLanguage, t } from '@/text';
import { compactTokens } from './usageAnalytics';
beforeEach(() => { mocks.stores.clear(); });
it('keeps accounts and centers separate and restores each account draft', () => {
    selectAccountPersistence('center-a', 'alice'); saveSessionDrafts({ privateSession: 'private draft' });
    selectAccountPersistence('center-a', 'bob'); expect(loadSessionDrafts()).toEqual({}); saveSessionDrafts({ sharedSession: 'bob draft' });
    selectAccountPersistence('center-b', 'alice'); expect(loadSessionDrafts()).toEqual({});
    selectAccountPersistence('center-a', 'alice'); expect(loadSessionDrafts()).toEqual({ privateSession: 'private draft' });
});
it('re-syncs active UI language and compactTokens units when switching account persistence', () => {
    selectAccountPersistence('center-a', 'alice');
    saveSettings({ ...settingsDefaults, preferredLanguage: 'zh-Hans' }, 1);
    expect(getCurrentLanguage()).toBe('zh-Hans');
    expect(t('lmc.usage.colPointsPerHundredMillion')).toBe('百分点 / 亿 Token');
    expect(compactTokens(35_000_000)).toBe('0.35亿');

    selectAccountPersistence('center-a', 'bob');
    expect(getCurrentLanguage()).toBe('en');
    expect(t('lmc.usage.colPointsPerHundredMillion')).toBe('Pct pts / 100M tokens');
    expect(compactTokens(35_000_000)).toBe('35.00M');

    selectAccountPersistence('center-a', 'alice');
    expect(getCurrentLanguage()).toBe('zh-Hans');
    expect(compactTokens(35_000_000)).toBe('0.35亿');
});
it('only migrates legacy state with an exact account identity, never pending settings from another account', () => {
    mocks.stores.set('default', new Map([['profile', JSON.stringify({ id: 'alice' })], ['session-drafts', JSON.stringify({ s: 'legacy' })], ['pending-settings', JSON.stringify({ analyticsOptOut: true })]]));
    selectAccountPersistence('center-a', 'bob'); expect(loadSessionDrafts()).toEqual({}); expect(loadPendingSettings()).toEqual({});
    selectAccountPersistence('center-a', 'alice'); expect(loadSessionDrafts()).toEqual({ s: 'legacy' }); expect(loadPendingSettings()).toEqual({ analyticsOptOut: true });
    expect(mocks.stores.get('default')?.has('session-drafts')).toBe(false);
});
