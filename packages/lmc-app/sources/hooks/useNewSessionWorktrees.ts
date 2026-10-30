import * as React from 'react';
import { listWorktrees, type WorktreeInfo } from '@/utils/worktree';

/** Only a change of target or availability should launch a remote Git process. */
export function useNewSessionWorktrees(machineId: string | null, path: string | null, enabled: boolean) {
    const [loaded, setLoaded] = React.useState<{ machineId: string; path: string; items: WorktreeInfo[] } | null>(null);
    React.useEffect(() => {
        if (!enabled || !machineId || !path) return;
        let canceled = false;
        void listWorktrees(machineId, path).then(
            items => { if (!canceled) setLoaded({ machineId, path, items }); },
            () => { if (!canceled) setLoaded({ machineId, path, items: [] }); },
        );
        return () => { canceled = true; };
    }, [enabled, machineId, path]);
    return enabled && loaded?.machineId === machineId && loaded?.path === path ? loaded.items : null;
}
