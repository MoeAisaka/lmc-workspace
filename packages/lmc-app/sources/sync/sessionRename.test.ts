import { beforeEach, expect, it, vi } from 'vitest';
const { prompt, alert, applySettings } = vi.hoisted(() => ({ prompt: vi.fn(), alert: vi.fn(), applySettings: vi.fn() }));
vi.mock('@/modal', () => ({ Modal: { prompt, alert } }));
vi.mock('./sync', () => ({ sync: { applySettings } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { promptSessionRename } from './sessionRename';
import type { Session } from './storageTypes';
const session = { id: 's', customName: '手动名称', metadata: { summary: { text: 'CLI title' } } } as Session;
beforeEach(() => vi.clearAllMocks());
it('prefills the manual name and saves a trimmed, account-scoped override', async () => {
    prompt.mockResolvedValue(' 新名称 ');
    await promptSessionRename(session);
    expect(prompt).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ defaultValue: '手动名称' }));
    expect(applySettings).toHaveBeenCalledWith({ sessionNameOverrides: { s: '新名称' } });
    expect(session.metadata?.summary?.text).toBe('CLI title');
});
it.each([null, '', ' ', '字'.repeat(201)])('does not change a saved name on cancel/invalid input', async value => {
    prompt.mockResolvedValue(value); await promptSessionRename(session);
    expect(applySettings).not.toHaveBeenCalled();
    if (value !== null) expect(alert).toHaveBeenCalled();
});
