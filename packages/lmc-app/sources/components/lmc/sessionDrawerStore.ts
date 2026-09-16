import { create } from 'zustand';

/**
 * Open/closed state of the phone's floating session drawer. Lives outside the
 * navigator so any header (session, new session, settings) can open it.
 */
export const useSessionDrawer = create<{ open: boolean; setOpen: (open: boolean) => void; toggle: () => void }>((set) => ({
    open: false,
    setOpen: (open) => set({ open }),
    toggle: () => set((s) => ({ open: !s.open })),
}));

export function openSessionDrawer() { useSessionDrawer.getState().setOpen(true); }
export function closeSessionDrawer() { useSessionDrawer.getState().setOpen(false); }
