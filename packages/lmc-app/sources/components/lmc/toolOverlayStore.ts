import { create } from 'zustand';

/**
 * Lets a tool row deep in the transcript open its detail without a route push.
 * SessionView registers the opener while it is mounted; anywhere else (an
 * embedded transcript, a notification deep link) the caller falls back to the
 * standalone message route.
 */
type ToolDetailOpener = (messageId: string) => void;
type FileOpener = (path: string) => void;

interface ToolOverlayStore {
    open: ToolDetailOpener | null;
    openFile: FileOpener | null;
    setOpener: (opener: ToolDetailOpener | null) => void;
    setFileOpener: (opener: FileOpener | null) => void;
}

export const useToolOverlay = create<ToolOverlayStore>((set) => ({
    open: null,
    openFile: null,
    setOpener: (opener) => set({ open: opener }),
    setFileOpener: (opener) => set({ openFile: opener }),
}));

/** Returns false when no session view can host the overlay. */
export function openToolDetail(messageId: string): boolean {
    const open = useToolOverlay.getState().open;
    if (!open) return false;
    open(messageId);
    return true;
}

/** Same, for a tool that points at a file rather than its own output. */
export function openSessionFile(path: string): boolean {
    const open = useToolOverlay.getState().openFile;
    if (!open) return false;
    open(path);
    return true;
}
