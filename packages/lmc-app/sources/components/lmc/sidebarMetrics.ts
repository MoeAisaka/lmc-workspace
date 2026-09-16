import { create } from 'zustand';

/**
 * What the sidebar's top card actually measures.
 *
 * The session pane puts its status card on the same line, and "the same height"
 * has to mean the height that card really has — it is content-derived, so any
 * number written down here would drift the first time the search row or the
 * brand row changes. The sidebar reports it; whoever wants to line up with it
 * reads it.
 */
export const useSidebarMetrics = create<{
    headerCardHeight: number;
    setHeaderCardHeight: (height: number) => void;
}>((set) => ({
    headerCardHeight: 0,
    setHeaderCardHeight: (height) => set((state) => (
        Math.abs(state.headerCardHeight - height) < 1 ? state : { headerCardHeight: height }
    )),
}));
