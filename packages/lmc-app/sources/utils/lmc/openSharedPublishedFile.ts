import { storage } from '@/sync/storage';
import { openSavedFile } from '@/components/SavedFileDialog';
import { fileName } from './fileKinds';

/** A shared transcript does not grant access to the owner's filesystem.
 * When its visible file card names the linked document, use that saved snapshot.
 * The saved-file API still checks the recipient's current grant on every read.
 */
export function openSharedPublishedFile(sessionId: string, path: string): boolean {
    const state = storage.getState();
    if (!state.sessions[sessionId]?.shared) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return false;
    const name = fileName(path.replace(/\\/g, '/')).normalize('NFC');
    const pending = [...(state.sessionMessages[sessionId]?.messages ?? [])];
    const candidates = new Set<string>();
    while (pending.length) {
        const message = pending.pop()!;
        if (message.kind !== 'tool-call') continue;
        pending.push(...message.children);
        const input = message.tool.input;
        if (message.tool.name !== 'file' || typeof input?.name !== 'string' || input.name.normalize('NFC') !== name) continue;
        if (typeof input.assetId === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.assetId)) candidates.add(input.assetId);
    }
    // A basename cannot identify which snapshot was intended when names collide.
    if (candidates.size !== 1) return false;
    openSavedFile([...candidates][0]);
    return true;
}
