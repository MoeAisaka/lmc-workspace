// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNewSessionWorktrees } from './useNewSessionWorktrees';
import { listWorktrees, type WorktreeInfo } from '@/utils/worktree';
vi.mock('@/utils/worktree', () => ({ listWorktrees: vi.fn() }));

describe('new-session remote worktree queries', () => {
    let root: Root;
    let items: WorktreeInfo[] | null;
    function Probe({ machine, path, enabled }: { machine: { id: string; activeAt: number }; path: string; enabled: boolean }) {
        items = useNewSessionWorktrees(machine.id, path, enabled);
        return null;
    }
    const render = async (activeAt = 0, path = '/project', enabled = true, id = 'windows') => {
        await act(async () => root.render(createElement(Probe, { machine: { id, activeAt }, path, enabled })));
    };
    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.mocked(listWorktrees).mockReset().mockResolvedValue([]);
        root = createRoot(document.createElement('div'));
    });
    afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

    it('does not launch more processes when heartbeats, session activity or an empty Git result rerender the screen', async () => {
        await render();
        for (let tick = 1; tick <= 100; tick++) await render(tick);
        expect(listWorktrees).toHaveBeenCalledTimes(1);
        expect(items!).toEqual([]);
    });
    it('queries again for a changed directory, machine or reconnect', async () => {
        await render();
        await render(1, '/next');
        await render(2, '/next', true, 'mini');
        await render(3, '/next', false, 'mini');
        await render(4, '/next', true, 'mini');
        expect(listWorktrees).toHaveBeenCalledTimes(4);
    });
    it('does not query Git for a catalog workspace, unsupported agent or offline machine', async () => {
        await render(0, '/project', false);
        await render(1, '/project', false);
        expect(listWorktrees).not.toHaveBeenCalled();
    });
    it('ignores a late result after switching directories and never shows old worktrees for the new directory', async () => {
        let resolveOld!: (items: WorktreeInfo[]) => void;
        vi.mocked(listWorktrees).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
            .mockResolvedValueOnce([{ path: '/next/worktree', branch: 'next' }]);
        await render();
        await render(1, '/next');
        await act(async () => resolveOld([{ path: '/old/worktree', branch: 'old' }]));
        expect(items!).toEqual([{ path: '/next/worktree', branch: 'next' }]);
    });
    it('handles failed discovery once without starting a retry loop', async () => {
        vi.mocked(listWorktrees).mockRejectedValue(new Error('offline'));
        await render();
        await render(1);
        expect(listWorktrees).toHaveBeenCalledTimes(1);
        expect(items!).toEqual([]);
    });
});
