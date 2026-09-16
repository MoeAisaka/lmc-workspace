import { create } from 'zustand';

/**
 * Where a dragged session row is about to land, when that is somewhere other
 * than between two rows of its own group.
 *
 * The sortable rows only know their own group; a hub section elsewhere in the
 * list has to light up as the row approaches it. The rows publish the target
 * under the pointer here, the sections read it, and the rows clear it when
 * the drag ends. Targets are strings: `hub:<sessionId>` for a hub group,
 * `ungroup` for the plain device list.
 */
interface DragTargetStore {
    target: string | null;
    setTarget: (target: string | null) => void;
}

export const useDragTarget = create<DragTargetStore>((set) => ({
    target: null,
    setTarget: (target) => set((state) => (state.target === target ? state : { target })),
}));
