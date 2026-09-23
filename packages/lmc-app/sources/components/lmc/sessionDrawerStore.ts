import { create } from 'zustand';

/**
 * Open/closed state of the phone's floating session drawer. Lives outside the
 * navigator so any header (session, new session, settings) can open it.
 */
export const useSessionDrawer = create<{
    open: boolean;
    setOpen: (open: boolean) => void;
    toggle: () => void;
    /** Only the focused main chat publishes the space under its composer card. */
    composer: { sessionId: string; bottomSpacing: number } | null;
}>((set) => ({
    open: false,
    composer: null,
    setOpen: (open) => set({ open }),
    toggle: () => set((s) => ({ open: !s.open })),
}));

export function openSessionDrawer() { useSessionDrawer.getState().setOpen(true); }
export function closeSessionDrawer() { useSessionDrawer.getState().setOpen(false); }
