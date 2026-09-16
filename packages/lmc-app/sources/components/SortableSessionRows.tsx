import * as React from 'react';
export type SortableSessionRowsProps<T extends { id: string } = { id: string }> = {
    groupId: string;
    disabled?: boolean;
    sessions: T[];
    /** Left inset of the row's own box, so the lifted-row highlight matches it. */
    highlightInset?: number;
    renderRow: (session: T, index: number) => React.ReactNode;
    /**
     * The drop target this group itself is, so a row dragged over its own
     * group is a reorder rather than a drop. Targets are the `data-drop-target`
     * values sections declare; see components/lmc/dragTargetStore.
     */
    ownDropTarget?: string;
    /** A row was released over another group's target: bind, unbind, whatever the target means. */
    onDropOn?: (sessionId: string, target: string) => void;
};
export function SortableSessionRows<T extends { id: string }>({ sessions, renderRow }: SortableSessionRowsProps<T>) {
    return <>{sessions.map((session, index) => <React.Fragment key={session.id}>{renderRow(session, index)}</React.Fragment>)}</>;
}
