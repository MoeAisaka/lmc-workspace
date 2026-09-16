import * as React from 'react';

/**
 * Whole hub groups (header, workers, task rows) reordered as one unit — the
 * group-level counterpart to `SortableSessionRows`. `getId` stands in for the
 * `{id}` shape that row-level sorting can assume directly, since a hub group
 * has no id of its own — only its hub session does.
 */
export interface SortableHubGroupsProps<T> {
    /** Key under `sessionProjectOrder` this list's order is saved to. */
    storageKey: string;
    items: T[];
    getId: (item: T) => string;
    /**
     * `handleProps` is meant for the one sub-element that should pick the
     * whole group up — the hub header row, not the group at large, which
     * still needs its own rows individually pressable/sortable.
     */
    renderItem: (item: T, handleProps: Record<string, unknown>) => React.ReactNode;
}

/**
 * Native has no drag gesture wired up here yet, the same as
 * `SortableSessionRows`' own native fallback — it renders each group in the
 * order it is given and nothing more.
 */
export function SortableHubGroups<T>({ items, getId, renderItem }: SortableHubGroupsProps<T>) {
    return <>{items.map((item) => <React.Fragment key={getId(item)}>{renderItem(item, {})}</React.Fragment>)}</>;
}
