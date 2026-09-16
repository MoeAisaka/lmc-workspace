import { expect, it, vi } from 'vitest';
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { getSessionName } from '@/utils/sessionUtils';
import { applySettings, settingsParse } from './settings';
import type { Session } from './storageTypes';
it('keeps the user name ahead of changing CLI summaries', () => {
    const session = { id: 's', customName: '长期项目', metadata: { summary: { text: 'CLI title 1' } } } as Session;
    expect(getSessionName(session)).toBe('长期项目');
    expect(getSessionName({ ...session, metadata: { ...session.metadata!, summary: { text: 'CLI title 2', updatedAt: 1 } } })).toBe('长期项目');
    expect(getSessionName({ ...session, customName: null })).toBe('CLI title 1');
});
it('persists names and merges per-session deltas including explicit resets', () => {
    const original = settingsParse({ sessionNameOverrides: { a: '甲', b: '乙' } });
    const updated = applySettings(original, { sessionNameOverrides: { a: '新甲' } });
    expect(updated.sessionNameOverrides).toEqual({ a: '新甲', b: '乙' });
    expect(settingsParse(JSON.parse(JSON.stringify(updated))).sessionNameOverrides).toEqual(updated.sessionNameOverrides);
    expect(applySettings(updated, { sessionNameOverrides: { a: null } }).sessionNameOverrides).toEqual({ a: null, b: '乙' });
});
