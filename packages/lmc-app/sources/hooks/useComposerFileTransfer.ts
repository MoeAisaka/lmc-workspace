import * as React from 'react';
import { Platform } from 'react-native';
import { Modal } from '@/modal';
import { generateThumbhash } from '@/utils/thumbhash';
import { attachmentSizeLimit, formatSizeLimit, MAX_IMAGES_PER_MESSAGE } from '@/sync/attachmentTypes';
import type { AttachmentPreview } from '@/sync/attachmentTypes';
import { t } from '@/text';
import { getFilesFromClipboard, getFilesFromDrop } from '@/utils/pasteImages.web';

/**
 * Pasting and dropping files onto a composer.
 *
 * Lived inside the in-session composer, which is why the new-session one — the
 * first thing a session ever sees — could not take a dropped file at all. It is
 * a hook now so both get the same behaviour and neither can quietly drift.
 *
 * Web only: there is no paste event on a React Native TextInput, so the phone
 * pastes through an explicit action instead (see `useClipboardImage`).
 */
type ScopeNode = { parentNode: ScopeNode | null } | null | undefined;

/**
 * Which of the mounted composers a paste or drop belongs to: the one sharing
 * the deepest ancestor with where the event happened.
 *
 * The listeners sit on the document, and screens opened earlier stay mounted
 * behind the current one. Every one of their composers used to accept the same
 * paste, so an image pasted into one session also sat waiting in the others
 * (2026-10-08). A composer with no scope node can only win when nothing else
 * is closer; ties go to the composer mounted last, which is the one on top.
 */
export function pickTransferOwner(scopes: ScopeNode[], target: ScopeNode): number {
    const depthOf = (node: ScopeNode) => { let depth = 0; for (let n = node; n; n = n.parentNode) depth++; return depth; };
    const targetChain = new Set<object>();
    for (let n = target; n; n = n.parentNode) targetChain.add(n);
    let owner = -1, best = -1;
    scopes.forEach((scope, index) => {
        let shared = 0;
        for (let n = scope; n; n = n.parentNode) if (targetChain.has(n)) { shared = depthOf(n); break; }
        if (shared >= best) { best = shared; owner = index; }
    });
    return owner;
}

const mountedScopes: Array<{ node: () => ScopeNode }> = [];

export function useComposerFileTransfer(
    onAddFiles: ((files: AttachmentPreview[]) => void) | undefined,
    currentCount: number,
    /** An element inside this composer's screen; see pickTransferOwner. */
    scopeRef?: React.RefObject<unknown>,
) {
    // Read through a ref so the listeners are attached once rather than being
    // torn down and rebuilt on every keystroke that changes the count.
    const countRef = React.useRef(currentCount);
    countRef.current = currentCount;

    React.useEffect(() => {
        if (Platform.OS !== 'web' || !onAddFiles) return;
        const registration = { node: () => (scopeRef?.current ?? null) as ScopeNode };
        mountedScopes.push(registration);
        const owns = (target: unknown) => mountedScopes[pickTransferOwner(mountedScopes.map(entry => entry.node()), target as ScopeNode)] === registration;

        const accept = async (files: File[], source: 'paste' | 'drop') => {
            const remaining = MAX_IMAGES_PER_MESSAGE - countRef.current;
            if (remaining <= 0) {
                Modal.alert(
                    t('imageUpload.limitTitle'),
                    t('imageUpload.limitMessage', { max: MAX_IMAGES_PER_MESSAGE }),
                    [{ text: t('common.ok') }],
                );
                return;
            }
            const { fileToAttachmentPreview } = await import('@/utils/pasteImages.web');
            const previews: AttachmentPreview[] = [];
            for (const file of files.slice(0, remaining)) {
                const limit = attachmentSizeLimit(file.type, true);
                if (file.size > limit) {
                    Modal.alert(
                        t('lmc.common.fileTooLarge'),
                        t('lmc.common.fileTooLargeBody', { name: file.name || 'file', limit: formatSizeLimit(limit) }),
                        [{ text: t('common.ok') }],
                    );
                    continue;
                }
                const preview = await fileToAttachmentPreview(file, generateThumbhash);
                if (preview) {
                    previews.push({ ...preview, id: `${source}_${Date.now()}_${Math.random().toString(36).slice(2)}` });
                }
            }
            if (previews.length > 0) onAddFiles(previews);
        };

        const handlePaste = async (event: ClipboardEvent) => {
            // The listener is on the document, so without this a paste in the
            // URL bar, another modal, or any focused-elsewhere input would
            // steal files meant for somewhere else.
            const active = document.activeElement;
            const isEditableTarget = active instanceof HTMLInputElement
                || active instanceof HTMLTextAreaElement
                || (active instanceof HTMLElement && active.isContentEditable);
            if (!isEditableTarget || !owns(active)) return;

            // Clipboard payloads are readable only during event dispatch. Take
            // File references and cancel native insertion before any await;
            // keyboard paste clears clipboardData once this handler yields.
            const files = getFilesFromClipboard(event);
            if (!files.length) return;
            event.preventDefault();
            await accept(files, 'paste');
        };

        // dragover must preventDefault for drop to fire; gated on the drag
        // actually carrying files so dragging text around the app still works.
        const isFileDrag = (event: DragEvent) => {
            const types = event.dataTransfer?.types;
            if (!types) return false;
            for (let i = 0; i < types.length; i++) if (types[i] === 'Files') return true;
            return false;
        };

        const handleDragOver = (event: DragEvent) => {
            if (!isFileDrag(event) || !owns(event.target)) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        };

        const handleDrop = async (event: DragEvent) => {
            if (!isFileDrag(event) || !owns(event.target)) return;
            event.preventDefault();
            // Drop data has the same event-scoped lifetime as clipboard data.
            const files = getFilesFromDrop(event);
            if (!files.length) return;
            await accept(files, 'drop');
        };

        document.addEventListener('paste', handlePaste as any);
        document.addEventListener('dragover', handleDragOver);
        document.addEventListener('drop', handleDrop);
        return () => {
            mountedScopes.splice(mountedScopes.indexOf(registration), 1);
            document.removeEventListener('paste', handlePaste as any);
            document.removeEventListener('dragover', handleDragOver);
            document.removeEventListener('drop', handleDrop);
        };
    }, [onAddFiles, scopeRef]);
}
