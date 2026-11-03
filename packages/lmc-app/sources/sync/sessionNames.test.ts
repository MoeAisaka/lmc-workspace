import { expect, it, vi } from 'vitest';
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { getSessionName } from '@/utils/sessionUtils';
import { applySettings, settingsParse } from './settings';
import { MetadataSchema, type Session } from './storageTypes';
it('keeps the user name ahead of changing CLI summaries and falls back to metadata.name', () => {
    const session = { id: 's', customName: '长期项目', metadata: { summary: { text: 'CLI title 1' }, name: '初始对话名' } } as Session;
    expect(getSessionName(session)).toBe('长期项目');
    expect(getSessionName({ ...session, metadata: { ...session.metadata!, summary: { text: 'CLI title 2', updatedAt: 1 } } })).toBe('长期项目');
    expect(getSessionName({ ...session, customName: null })).toBe('CLI title 1');
    expect(getSessionName({ ...session, customName: null, metadata: { path: '', host: '', name: '共享设备新建会话' } as Session['metadata'] })).toBe('共享设备新建会话');
});
it('parses pre-claim shared-device session metadata before path and host are populated', () => {
    const parsed = MetadataSchema.parse({
        name: '共享设备任务',
        flavor: 'codex',
        machineId: 'machine-1',
        sharedDevice: true,
    });
    expect(parsed.name).toBe('共享设备任务');
    expect(parsed.path).toBe('');
    expect(parsed.host).toBe('');
    expect(parsed.sharedDevice).toBe(true);
});
it('persists names and merges per-session deltas including explicit resets', () => {
    const original = settingsParse({ sessionNameOverrides: { a: '甲', b: '乙' } });
    const updated = applySettings(original, { sessionNameOverrides: { a: '新甲' } });
    expect(updated.sessionNameOverrides).toEqual({ a: '新甲', b: '乙' });
    expect(settingsParse(JSON.parse(JSON.stringify(updated))).sessionNameOverrides).toEqual(updated.sessionNameOverrides);
    expect(applySettings(updated, { sessionNameOverrides: { a: null } }).sessionNameOverrides).toEqual({ a: null, b: '乙' });
});
