import * as React from 'react';
import { useSetting } from '@/sync/storage';
import { orderSessions } from '@/sync/sessionOrder';

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
     * Mark the hub navigation header with `handleProps` so its button can
     * also start a group drag. On Web the surrounding group space is a
     * handle too; nested controls and worker sort rows are excluded.
     */
    renderItem: (item: T, handleProps: Record<string, unknown>) => React.ReactNode;
}

/**
 * Native shares the saved account order with Web, even though it does not
 * yet expose a drag gesture of its own.
 */
export function SortableHubGroups<T>({ storageKey, items, getId, renderItem }: SortableHubGroupsProps<T>) {
    const orders = useSetting('sessionProjectOrder');
    const rows = orderSessions(items.map(item => ({ id: getId(item), item })), orders[storageKey]);
    return <>{rows.map(({ id, item }) => <React.Fragment key={id}>{renderItem(item, {})}</React.Fragment>)}</>;
}
